/**
 * SEMANTIC AMPUTATION GUARD — the doctrine a model actually receives.
 *
 * askCoachK does not send COACH_K_SYSTEM. It sends `COACH_K_SYSTEM.slice(0, 20_000)`, and the
 * other 47,677 characters reach no model anywhere. That is not a size problem, it is a
 * CAPABILITY problem, and the dangerous part is how quietly it moves: adding a paragraph near
 * the top of coach-prompt.ts pushes whatever sits near the boundary over the edge, and nothing
 * fails. The file still compiles. Every test still passes. A HARD RULE simply stops arriving.
 *
 * It has already happened once. The cut currently lands at character 19,965 — INSIDE
 * "RECOMPOSITION GOAL — CRITICAL EXPECTATION SETTING:" — so the model receives that heading
 * with 35 of its 3,918 characters under it. A heading with no body is worse than an omission:
 * it announces an instruction that is not there.
 *
 * So a character count is not enough. This asserts three things per protected section:
 *   1. the section still EXISTS in the source            (nobody deleted the doctrine)
 *   2. its body SENTINELS still exist in the source      (nobody gutted it and left the heading)
 *   3. its delivery status has not REGRESSED             (nobody pushed it past the boundary)
 *
 * WHY A BASELINE AND NOT A FLAT ASSERTION. Six of the seven protected sections do not reach a
 * model TODAY. A guard demanding they all survive would be red the moment it was written, and a
 * red guard gets disabled. So each section records what is true now and may only IMPROVE — the
 * same ratchet check-architecture.ts uses. Restoring a section is a deliberate act with a
 * deliberate baseline change; losing one is impossible to do silently.
 *
 * This guard asserts NOTHING about whether the current state is acceptable. It is not. It
 * exists so the state cannot get worse while we decide what to do about it.
 *
 * Run: npx tsx script/check-prompt-integrity.ts   (wired into `npm test`)
 */

import { readFileSync } from "node:fs";

// The EVALUATED constant, not the source text. coach-prompt.ts is a pure leaf module — two string
// exports, no imports, no side effects — so importing it is safe and it is the only way to get
// real offsets: the source contains the literal `${HANDLING_CONFUSION}` (21 chars) where the
// evaluated prompt carries that section in full (2,187 chars). Measuring the source puts every
// offset after line 76 out by ~1,700 characters, which is exactly the kind of quiet wrongness
// this guard exists to prevent.
const { COACH_K_SYSTEM } = await import("../server/coach-prompt");

// The boundary is READ FROM gpt.ts rather than hardcoded here, so the two can never disagree.
// If someone changes the slice, this guard measures the new one instead of a stale copy.
const gptSrc = readFileSync("server/gpt.ts", "utf-8");
const sliceMatch = gptSrc.match(/COACH_K_SYSTEM\.slice\(0,\s*([0-9_]+)\)/);
if (!sliceMatch) {
  console.error("prompt integrity: FAILED — cannot find COACH_K_SYSTEM.slice(0, N) in server/gpt.ts.");
  console.error("  The guard measures the REAL boundary. If the slice moved or went away, update this guard deliberately.");
  process.exit(1);
}
const SLICE = parseInt(sliceMatch[1].replace(/_/g, ""), 10);

type Status = "SENT" | "AMPUTATED" | "NEVER SENT";
/** Better is further left — a section may improve, never regress. */
const RANK: Record<Status, number> = { "NEVER SENT": 0, AMPUTATED: 1, SENT: 2 };

interface Protected {
  /** Exact heading text as it appears in the prompt. */
  head: string;
  /** Body-level claims that must survive. A heading alone is not the doctrine. */
  sentinels: string[];
  /** What is true TODAY. May only improve. */
  baseline: Status;
  /** Why this section is protected. */
  why: string;
}

// THE PROTECTED LIST — explicit and version-controlled, per the founder's ruling. Every entry
// is either a rule the coach may not break or a body of knowledge the product promises.
const PROTECTED: Protected[] = [
  {
    head: "HARD RULES — NEVER BREAK THESE UNDER ANY CIRCUMSTANCES:",
    sentinels: [`Never say "How can I help you today"`, `Never say "Great question"`],
    baseline: "SENT",
    why: "the banned-phrase list — the difference between a coach and a help desk",
  },
  {
    head: "MYTH BUSTING — THESE POSITIONS ARE NON-NEGOTIABLE:",
    sentinels: ["SPOT REDUCTION: Does not exist"],
    baseline: "NEVER SENT",
    why: "10,011 chars of non-negotiable positions; spot reduction is code-enforced, the rest is not",
  },
  {
    head: "THE FOUR PILLARS — EVERY CLIENT, EVERY GOAL, NON-NEGOTIABLE:",
    sentinels: ["1. MOVE — Daily steps"],
    baseline: "NEVER SENT",
    why: "the whole system in four parts; step targets are code-enforced, the framing is not",
  },
  {
    head: "PROGRAMME PHILOSOPHY — THIS IS NON NEGOTIABLE:",
    sentinels: ["Foundation is machine and cable compound movements"],
    baseline: "NEVER SENT",
    why: "machines before free weights — a safety position, not a preference",
  },
  {
    head: "SA FOOD KNOWLEDGE — EXACT VALUES FOR EVERY FOOD RESPONSE:",
    sentinels: ["Pilchards in tomato sauce 1 tin (215g): 180 kcal, 25g protein"],
    baseline: "NEVER SENT",
    why: "food values; foods.ts owns the numbers deterministically, which is the better home",
  },
  {
    head: "BUDGET TIERS — USE EXACTLY THESE PLANS:",
    sentinels: ["R57 EMERGENCY"],
    baseline: "NEVER SENT",
    why: "the R57/R100/R200 plans — the product's answer to 'I have no money this week'",
  },
  {
    head: "RESPONSE FORMAT RULES — APPLY TO EVERY SINGLE RESPONSE:",
    sentinels: ["Maximum 3 messages for any programme"],
    baseline: "NEVER SENT",
    why: "says 'every single response' and reaches none; the message caps are enforced nowhere",
  },
  {
    head: "RECOMPOSITION GOAL — CRITICAL EXPECTATION SETTING:",
    sentinels: ["Changes will come VISUALLY"],
    baseline: "AMPUTATED",
    why: "THE live amputation — the cut lands inside this section, heading sent, doctrine lost",
  },
];

/** Short name for messages — "MYTH BUSTING" rather than the whole heading. */
const label = (p: Protected) => p.head.split("—")[0].trim().replace(/:$/, "");

const starts = PROTECTED.map(p => ({ p, at: COACH_K_SYSTEM.indexOf(p.head) }));
const problems: string[] = [];
const report: string[] = [];

for (const { p, at } of starts) {
  // 1. EXISTS — catches a deletion, including one made while "trimming the prompt".
  if (at < 0) {
    problems.push(`  ✗ ${label(p)}: heading NOT FOUND in coach-prompt.ts.`);
    problems.push(`      ${p.why}`);
    problems.push(`      A protected section may be moved or restored, never deleted without changing this list.`);
    continue;
  }
  // 2. SENTINELS EXIST — a heading with a gutted body passes a naive test and fails a client.
  const missing = p.sentinels.filter(s => !COACH_K_SYSTEM.includes(s));
  if (missing.length) {
    problems.push(`  ✗ ${label(p)}: body sentinel(s) missing from source:`);
    for (const m of missing) problems.push(`      "${m.slice(0, 70)}"`);
    problems.push(`      The heading survives but the doctrine under it does not. That is the failure this guard exists for.`);
  }

  // STATUS IS DERIVED FROM THE SENTINELS, not from byte extents. Section extents cannot be
  // computed reliably here — "SPOT REDUCTION:", "PROTEINS:", "SIMPLE COACHING:" are ALL-CAPS
  // sub-headings inside their parent sections, so any next-heading scan terminates early and
  // reports a 51-character MYTH BUSTING. The sentinels answer the question that actually
  // matters, and it is the founder's third requirement: is enough of the body delivered to be
  // USABLE? A heading inside the slice with its doctrine outside it is AMPUTATED — the live
  // RECOMPOSITION failure — and that is precisely what a length check cannot see.
  const placed = p.sentinels.map(s => ({ s, at: COACH_K_SYSTEM.indexOf(s) }));
  const delivered = placed.filter(x => x.at >= 0 && x.at + x.s.length <= SLICE);
  const status: Status = at >= SLICE ? "NEVER SENT"
    : delivered.length === placed.length ? "SENT"
    : "AMPUTATED";

  // 3. NO REGRESSION.
  if (RANK[status] < RANK[p.baseline]) {
    problems.push(`  ✗ ${label(p)}: ${p.baseline} → ${status}. This section LOST ground.`);
    problems.push(`      heading at ${at.toLocaleString()}, boundary ${SLICE.toLocaleString()}, ` +
      `${delivered.length}/${placed.length} sentinels delivered.`);
    for (const x of placed) {
      if (!(x.at >= 0 && x.at + x.s.length <= SLICE)) {
        problems.push(`      LOST: "${x.s.slice(0, 62)}"  @${x.at.toLocaleString()}`);
      }
    }
    problems.push(`      Something above it grew. Shrink what was added, or move this section earlier.`);
  }

  report.push(
    `${label(p)}:\n` +
    `  heading at: ${at.toLocaleString()}\n` +
    `  sentinels delivered: ${delivered.length} / ${placed.length}` +
      placed.map(x => `\n    ${x.at >= 0 && x.at + x.s.length <= SLICE ? "sent  " : "LOST  "}@${String(x.at).padStart(6)}  "${x.s.slice(0, 52)}"`).join("") + "\n" +
    `  STATUS: ${status}${status === p.baseline ? ""
      : RANK[status] > RANK[p.baseline]
        ? `  (baseline ${p.baseline} — IMPROVED, raise the baseline to lock it in)`
        : `  (baseline ${p.baseline} — REGRESSED, see failure below)`}`
  );
}

console.log(`STATIC_HOT_BRAIN boundary: ${SLICE.toLocaleString()}`);
console.log(`COACH_K_SYSTEM total: ${COACH_K_SYSTEM.length.toLocaleString()} chars — ` +
  `${Math.max(0, COACH_K_SYSTEM.length - SLICE).toLocaleString()} never reach a model\n`);
console.log(report.join("\n\n"));

if (problems.length) {
  console.error("\nprompt integrity: FAILED — a protected coaching law changed what it delivers:");
  console.error(problems.join("\n"));
  console.error("\nDo not raise the slice or delete the section. Either shrink what was added above it,");
  console.error("or make the restoration deliberate and update the baseline in this file with a reason.");
  process.exit(1);
}

const sent = starts.filter(({ p, at }) => at >= 0 && at < SLICE).length;
console.log(`\nprompt integrity: OK — ${PROTECTED.length} protected sections, ${sent} reach a model, ` +
  `${PROTECTED.length - sent} do not. None regressed.`);
process.exit(0);
