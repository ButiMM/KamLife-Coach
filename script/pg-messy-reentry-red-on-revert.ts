/** RED-ON-REVERT — every #229 production handoff is removed independently. */
if (!process.env.DATABASE_URL) {
  console.log("pg-messy-reentry-red-on-revert: SKIPPED — no DATABASE_URL");
  process.exit(0);
}
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const { pool } = await import("../server/db");
const acceptance = "script/pg-messy-reentry-acceptance.ts";
let failed = 0;

async function reset() {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  const migrated = spawnSync("npm", ["run", "db:migrate"], { encoding: "utf8", env: process.env });
  if (migrated.status !== 0) throw new Error("db:migrate failed: " + migrated.stderr);
}

async function red(name: string, file: string, from: string, to: string, expected: string) {
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) {
    failed++;
    console.log(`  FAIL  ${name} — revert matched nothing`);
    return;
  }
  try {
    writeFileSync(file, original.replace(from, to));
    await reset();
    const run = spawnSync("npx", ["tsx", acceptance], { encoding: "utf8", env: process.env });
    const output = String(run.stdout || "") + String(run.stderr || "");
    const ok = run.status !== 0 && output.includes(expected);
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} -> ${run.status === 0 ? "unexpected GREEN" : "RED"}`);
    if (!ok) console.log(output.slice(-1200));
  } finally {
    writeFileSync(file, original);
  }
}

await red("terminal backfill receipt", "server/routes.ts",
  `commitFact(turn, firstDomain === "steps" ? "steps" : "workout", backfillReply);`,
  "return backfillReply;", "non-food catch-up also reaches today's decision");
await red("whole-bubble question veto", "server/handlers/food-context.ts",
  "if (mDayMatches.length >= 2 && !isFrustration",
  "if (mDayMatches.length >= 2 && !isQuestion && !isFrustration",
  "only the two supported meals land");
await red("question segments become logs", "server/handlers/food-context.ts",
  "      if (isAskingNotReporting(seg.text) && !journeyMustKeepFacts(seg.text).food) continue;\n", "",
  "named-day food questions do not become catch-up meal rows");
await red("fuzzy workout becomes food", "server/handlers/food-context.ts",
  "scanForSAFoods(seg.text, { exactOnly: true })", "scanForSAFoods(seg.text)",
  "only the two supported meals land");
await red("historical outcome does not close #208", "server/backfill.ts",
  "      await closeOpenTrainingLoopForDay({ user, resolvedDay: beat.dayKey, sourceMessageId });\n", "",
  "matching older #208 loop closes exactly once");
await red("restart template claims contentful catch-up", "server/handlers/early-commands.ts",
  "if (isComeback && !ctx.hasMultiDayReport)", "if (isComeback)",
  "catch-up does not restart or deny the history");
await red("direction leaves reconstructed turn", "server/routes.ts",
  "    canonicalCloseOwnsQuestion,\n", "",
  "one reply reflects the supported multi-domain reconstruction");
await red("transport duplicates and rejects catch-up", "server/routes/whatsapp.ts",
  "export const COMEBACK_ACK = `You came back — that's the real streak. 💛\\n\\n`;",
  "export const COMEBACK_ACK = `You came back — that's the real streak. 💛 No catch-up needed, we start from today.\\n\\n`;",
  "delivery acknowledgement does not reject supported history");
await red("transport duplicates canonical welcome", "server/routes/whatsapp.ts",
  `  return lower.includes("welcome back") || lower.includes("you came back") ? reply : prefix + reply;`,
  "  return prefix + reply;", "transport also recognises canonical comeback wording");

await pool.end();
console.log(`pg-messy-reentry-red-on-revert: ${failed ? `RED — ${failed} ineffective control(s)` : "GREEN — every independent revert was caught"}`);
process.exit(failed ? 1 : 0);
