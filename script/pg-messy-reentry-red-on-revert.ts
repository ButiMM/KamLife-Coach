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
await red("fuzzy workout becomes food", "server/handlers/food-context.ts",
  "scanForSAFoods(seg.text, { exactOnly: true })", "scanForSAFoods(seg.text)",
  "a workout phrase between food days never becomes a fuzzy pre-workout meal");
await red("historical outcome does not close #208", "server/backfill.ts",
  "      await closeOpenTrainingLoopForDay({ user, resolvedDay: beat.dayKey, sourceMessageId });\n", "",
  "matching older #208 loop closes exactly once");
await red("restart template claims contentful catch-up", "server/handlers/early-commands.ts",
  "if (isComeback && !ctx.hasMultiDayReport)", "if (isComeback)",
  "contentful multi-day catch-up does not terminate in the generic three-step comeback template");
await red("direction leaves reconstructed turn", "server/routes.ts",
  "    canonicalCloseOwnsQuestion,\n", "",
  "final outbound reflects the supported multi-domain reconstruction");
await red("authoritative composer loses return warmth", "server/understanding/live.ts",
  "    ? `Welcome back — I've got the catch-up you sent.\\n\\n${body}`\n",
  "    ? body\n",
  "authoritative response composer adds one warm return acknowledgement");
await red("transport reintroduces no-catch-up text", "server/routes/whatsapp.ts",
  "      ? rawReply\n", "      ? `No catch-up needed. ${rawReply}`\n",
  "final outbound contains neither 'No catch-up needed' nor 'we start from today'");
await red("transport reintroduces start-today text", "server/routes/whatsapp.ts",
  "      ? rawReply\n", "      ? `We start from today. ${rawReply}`\n",
  "final outbound contains neither 'No catch-up needed' nor 'we start from today'");
await red("historical cardio falls through to today", "server/handlers/workout.ts",
  `const isCardioLog = !turnAlreadyWrote("workout") && !looksLikeQuestion(m)`,
  `const isCardioLog = !looksLikeQuestion(m)`,
  "historical cardio catch-up writes only the two named days");
await red("batch status question writes referenced foods", "server/handlers/food-context.ts",
  "      if (questionGovernsBatch && !explicitlyReportsFood(seg.text)) continue;\n", "",
  "batch status question stays read-only");

await pool.end();
console.log(`pg-messy-reentry-red-on-revert: ${failed ? `RED — ${failed} ineffective control(s)` : "GREEN — every independent revert was caught"}`);
process.exit(failed ? 1 : 0);
