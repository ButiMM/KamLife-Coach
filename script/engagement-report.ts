/**
 * ENGAGEMENT REPORT — the retention picture, from a terminal.
 *
 * Same numbers as texting *engagement* to the bot. Needs DATABASE_URL. Read-only.
 *   npm run audit:engagement
 */

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("engagement-report: DATABASE_URL is not set — this reads real client activity.");
    process.exit(2);
  }
  const { engagementCommand } = await import("../server/audit/engagement-command");
  const report = await engagementCommand();
  console.log("\n" + report.replace(/\*/g, "") + "\n");
}

main().catch(err => { console.error("engagement-report failed:", err); process.exit(1); });
