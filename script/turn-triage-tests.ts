/**
 * TURN TRIAGE — the verdict vocabulary and the retention rule.
 *
 * SCOPE, STATED HONESTLY. These are OWNER-LEVEL tests. PR #62 established that an owner-level
 * test can pass while a caller bypasses the owner and still produces the wrong outcome, and the
 * only thing that caught it was an end-to-end fixture. There is no end-to-end coverage here,
 * because this repo has no HTTP test harness (no supertest, no route-level suite) and the stub DB
 * implements no `delete`. Building either is a real piece of work and it is NOT done, so the
 * bypass risk #62 identified is present on this surface and is recorded rather than implied away.
 *
 * What IS covered is the part that decides what gets stored: a closed vocabulary that refuses
 * unknown values, and a retention cutoff that is a value rather than an inference from a delete
 * statement. Both are tested against real inputs, not source strings.
 */

process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";

import assert from "node:assert/strict";

let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e: any) { failures.push(`  ✗ ${name}\n    ${e?.message || e}`); }
}

async function main() {
  const { validateVerdict, retentionCutoff } = await import("../server/routes/admin-turns");

  // ── THE CLOSED VOCABULARY ───────────────────────────────────────────────────────────────────
  check("a known failure category is accepted, and reaches the patch", () => {
    const r = validateVerdict({ failureCategory: "RESPONSE" });
    assert.ok(r.ok, "a legitimate category was refused");
    assert.equal((r as any).patch.failureCategory, "RESPONSE");
  });

  check("every one of the five layers is accepted", () => {
    for (const c of ["STATE", "UNDERSTANDING", "REASONING", "ACTION", "RESPONSE"]) {
      assert.ok(validateVerdict({ failureCategory: c }).ok, `${c} was refused`);
    }
  });

  check("every lifecycle state is accepted, revalidated included", () => {
    for (const s of ["observed", "confirmed", "fixed", "deployed", "revalidated"]) {
      assert.ok(validateVerdict({ lifecycleStatus: s }).ok, `${s} was refused`);
    }
  });

  // THE CONTROL. The vocabulary is only worth having if it REFUSES — the whole value of this
  // table is a countable distribution, and "response" / "output layer" / "mouth" alongside
  // "RESPONSE" would make the count meaningless within a week.
  check("control . a near-miss category is refused, not coerced", () => {
    for (const bad of ["response", "Response", "output layer", "mouth", "OTHER", ""]) {
      const r = validateVerdict({ failureCategory: bad });
      assert.equal(r.ok, false, `"${bad}" was accepted as a category`);
    }
  });

  check("control . an invented lifecycle state is refused", () => {
    for (const bad of ["done", "closed", "REVALIDATED", "wontfix"]) {
      assert.equal(validateVerdict({ lifecycleStatus: bad }).ok, false, `"${bad}" was accepted`);
    }
  });

  // Clearing a verdict is a legitimate action and must not be confused with an invalid one.
  check("null clears a verdict rather than being refused as unknown", () => {
    const r = validateVerdict({ failureCategory: null, lifecycleStatus: null });
    assert.ok(r.ok, "clearing a verdict was refused");
    assert.equal((r as any).patch.failureCategory, null);
  });

  check("an empty body is refused — a no-op must not stamp triagedAt", () => {
    assert.equal(validateVerdict({}).ok, false);
    assert.equal(validateVerdict(null).ok, false);
  });

  check("a recorded verdict is stamped with when it was made", () => {
    const r = validateVerdict({ failureCategory: "STATE" });
    assert.ok((r as any).patch.triagedAt instanceof Date, "no triagedAt on a real verdict");
  });

  // Both free-text fields land in an admin page. The page escapes on render; the cap is the belt.
  check("free text is bounded", () => {
    const r: any = validateVerdict({ fixRef: "x".repeat(500), triageNote: "y".repeat(5000) });
    assert.ok(r.ok);
    assert.equal(r.patch.fixRef.length, 200);
    assert.equal(r.patch.triageNote.length, 2000);
  });

  // ── RETENTION ───────────────────────────────────────────────────────────────────────────────
  // POPIA minimisation is only real if the boundary is what we said it was. 90 days, measured.
  check("the retention cutoff is 90 days behind the clock", () => {
    const now = Date.UTC(2026, 7, 25, 12, 0, 0);
    const cutoff = retentionCutoff(now);
    const days = (now - cutoff.getTime()) / 86_400_000;
    assert.equal(days, 90, `retention is ${days} days, not 90`);
  });

  check("control . a turn from yesterday is inside the window, one from last year is not", () => {
    const now = Date.UTC(2026, 7, 25, 12, 0, 0);
    const cutoff = retentionCutoff(now).getTime();
    assert.ok(now - 86_400_000 > cutoff, "yesterday's turn would have been purged");
    assert.ok(now - 400 * 86_400_000 < cutoff, "a year-old turn would have been kept");
    // The edge itself: 89 days survives, 91 does not.
    assert.ok(now - 89 * 86_400_000 > cutoff, "day 89 was purged");
    assert.ok(now - 91 * 86_400_000 < cutoff, "day 91 was kept");
  });

  console.log(`\nturn-triage: ${passed}/${passed + failures.length} passed`);
  if (failures.length) {
    console.log("\nFailures:\n" + failures.join("\n"));
    process.exit(1);
  }
  console.log("✓ the verdict vocabulary refuses what it must, and retention is 90 days");
  // EXPLICIT (2026-08-25). Importing the route module pulls in routes/auth.ts, whose brute-force
  // cleanup setInterval keeps the event loop alive forever. Without this the suite hangs green.
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
