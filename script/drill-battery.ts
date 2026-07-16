/**
 * DRILL BATTERY — the testers' torture cases as a one-command script.
 *
 * The cases + runner live in server/drill-cases.ts (shared with the nightly
 * prod job scheduler/jobs/drill-nightly.ts — same cases, same runner, so what
 * you drill by hand is exactly what prod verifies every night).
 *
 * Needs an OpenAI key (this drills the live model — it is NOT part of the
 * offline suites):   OPENAI_API_KEY=sk-... npx tsx script/drill-battery.ts
 */

import OpenAI from "openai";

// Key check BEFORE the server import — modules down the coach-brain import chain
// construct OpenAI clients at load time and throw an unhelpful error without one.
const key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
if (!key) {
  console.error("drill-battery: set OPENAI_API_KEY (this battery calls the live model).");
  process.exit(2);
}
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
const { DRILL_CASES, runDrillCase } = await import("../server/drill-cases");
const openai = new OpenAI({ apiKey: key });

let passed = 0, failed = 0;
for (const c of DRILL_CASES) {
  try {
    const r = await runDrillCase(openai, c);
    const tag = r.pass ? "✅ PASS" : (r.protection === "deterministic" ? "🟡 FAIL (canary — prod routes this to a deterministic handler; clients safe)" : "❌ FAIL (brain owns this in prod — client-facing)");
    if (r.pass) passed++; else failed++;
    console.log(`\n${tag} — ${c.name}`);
    console.log(`  client: ${c.user}`);
    console.log(`  coach:  ${r.reply.replace(/\n/g, "\n          ")}`);
    for (const w of r.warns) console.log(`  ⚠️  ${w}`);
  } catch (e: any) {
    failed++;
    console.log(`\n❌ ERROR — ${c.name}: ${e?.message || e}`);
  }
}

console.log(`\ndrill-battery: ${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
