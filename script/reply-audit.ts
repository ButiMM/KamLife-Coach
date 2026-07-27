/**
 * REPLY AUDIT — run the defect scanner over real production replies.
 *
 * (2026-07-27.) Built because the founder was the regression suite: six defects shipped and
 * were found by him reading WhatsApp screenshots one at a time. Every one of them is
 * mechanically detectable from the reply text, so this reads what the coach ACTUALLY SENT to
 * real clients and reports what is wrong with it. No model, no API cost, seconds to run.
 *
 *   npm run audit:replies              # last 2000 turns
 *   npm run audit:replies -- 5000      # last 5000 turns
 *   npm run audit:replies -- 2000 csv  # machine-readable, for tracking the trend
 *
 * Needs DATABASE_URL. Read-only — it never writes to the database.
 */

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";

const limit = Number(process.argv[2]) || 2000;
const asCsv = (process.argv[3] || "").toLowerCase() === "csv";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("reply-audit: DATABASE_URL is not set — this reads real production replies.");
    console.error("Run it where the database is reachable (Railway shell, or with DATABASE_URL exported).");
    process.exit(2);
  }

  const { db } = await import("../server/db");
  const { chatHistory } = await import("../shared/schema");
  const { desc, isNotNull } = await import("drizzle-orm");
  const { summarise } = await import("../server/audit/reply-defects");

  const rows = await db
    .select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut, intent: chatHistory.intent })
    .from(chatHistory)
    .where(isNotNull(chatHistory.messageOut))
    .orderBy(desc(chatHistory.createdAt))
    .limit(limit);

  // Skip system markers ("[RETRO WORKOUT: …]") — those are log entries, not replies to anyone.
  const turns = rows
    .filter(r => (r.messageOut || "").trim() && !/^\s*\[/.test(r.messageOut || ""))
    .map(r => ({ messageIn: r.messageIn || "", messageOut: r.messageOut || "", intent: r.intent }));

  const s = summarise(turns);

  if (asCsv) {
    console.log("code,count");
    for (const r of s.byCode) console.log(`${r.code},${r.count}`);
    return;
  }

  const pct = s.scanned ? ((s.defects / s.scanned) * 100).toFixed(1) : "0.0";
  console.log(`\nREPLY AUDIT — ${s.scanned} real replies scanned\n`);
  console.log(`  clean:    ${s.clean}`);
  console.log(`  defective: ${s.defects}  (${pct}% of replies carry at least one defect)\n`);

  if (s.byCode.length === 0) {
    console.log("  No defects detected in this sample.\n");
    return;
  }

  for (const row of s.byCode) {
    console.log(`─ ${row.code} — ${row.count}`);
    for (const ex of row.examples) {
      console.log(`    client: ${ex.in || "(none)"}`);
      console.log(`    coach:  ${ex.out.replace(/\n/g, " ⏎ ")}`);
      console.log(`    why:    ${ex.detail}\n`);
    }
  }

  console.log(`Each code maps to a detector in server/audit/reply-defects.ts.`);
  console.log(`A defect that is fixed at one call site but not the others keeps showing up here —`);
  console.log(`that is the point. Re-run after every fix.\n`);
}

main().catch(err => { console.error("reply-audit failed:", err); process.exit(1); });
