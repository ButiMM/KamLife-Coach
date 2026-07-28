/**
 * COACH COMMAND "audit" — the reply defect scanner, over WhatsApp.
 *
 * (2026-07-27.) The CLI (script/reply-audit.ts) needs a shell and DATABASE_URL, which is no
 * use to a founder holding a phone. This is the same scan, textable: send *audit* and get back
 * what is actually wrong with the last few thousand replies the coach sent real clients.
 *
 * The point is to end the pattern where defects are found one at a time by reading
 * screenshots. Numbers here are counts of real replies — nothing is estimated or sampled.
 */

import { desc, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { chatHistory } from "../../shared/schema";
import { summarise } from "./reply-defects";
import { guardStatsLine } from "../malformed-guard";
import { assessJobs, jobHealthLines } from "../job-health";
import { jobSnapshots, schedulerStartedAt } from "../scheduler/shared";

/** Plain-language name for each detector, so the report reads like coaching, not like a log. */
const LABELS: Record<string, string> = {
  "invented-food": "Logged a food the client never said",
  "meal-offered-after-logging": "Offered a meal they had just logged",
  "protein-contradiction": "Said protein was done AND still owing",
  "removal-nonsequitur": "Answered a deletion nobody asked for",
  "menu-dump": "Sent the whole help menu instead of an answer",
  "therapy-speak-to-reaction": "Answered a one-word reaction with feelings-talk",
  "train-after-session": "Told them to train after they said they trained",
  "capability-lie": "Claimed it cannot read photos",
  "dead-promise": "Promised a follow-up that never comes",
  "duplicate-claim": "Printed the same claim twice",
  "food-not-in-database": "Food missing from the database (coach handled it correctly)",
};

export async function replyAuditCommand(message: string, _user?: unknown): Promise<string> {
  const asked = parseInt((message.match(/(\d{2,5})/) || [])[1] || "2000", 10);
  const limit = Math.max(100, Math.min(20000, asked));

  const rows = await db
    .select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut, intent: chatHistory.intent })
    .from(chatHistory)
    .where(isNotNull(chatHistory.messageOut))
    .orderBy(desc(chatHistory.createdAt))
    .limit(limit);

  const turns = rows
    .filter(r => (r.messageOut || "").trim() && !/^\s*\[/.test(r.messageOut || ""))
    .map(r => ({ messageIn: r.messageIn || "", messageOut: r.messageOut || "", intent: r.intent }));

  if (turns.length === 0) return "No replies found to audit yet.";

  const s = summarise(turns);
  const pct = ((s.defects / s.scanned) * 100).toFixed(1);

  // TREND (2026-07-27): the founder ran this and saw 55 protein contradictions — all from
  // BEFORE the fix shipped that afternoon. A single lifetime number can't show whether a fix
  // worked, so the newest slice is reported separately. Rows arrive newest-first.
  const recent = turns.slice(0, Math.min(200, turns.length));
  const rs = summarise(recent);
  const recentPct = rs.scanned ? ((rs.defects / rs.scanned) * 100).toFixed(1) : "0.0";
  const trend = `\n\n📈 *Last ${rs.scanned} replies:* ${rs.defects} defective (${recentPct}%) — vs ${pct}% over the whole sample. This is the number that shows whether a fix landed.`;

  // Don't invite a wider scan once every stored reply has been read.
  const hitCeiling = turns.length < limit;
  const wider = hitCeiling
    ? `\n\nThat's every reply on record — nothing further back to scan.`
    : `\n\nSend *audit ${Math.min(20000, limit * 2)}* to scan wider.`;

  // The scheduler block rides along: the founder asks "is it working" once, not three times, and
  // an overdue job is invisible until a client says the messages stopped (2026-07-28 review).
  // Computed BEFORE the clean-replies early return — a quiet audit is exactly when a stalled
  // job is the only bad news there is.
  const snaps = jobSnapshots();
  const jobs = jobHealthLines(assessJobs(snaps, Date.now(), Date.now() - schedulerStartedAt), snaps.length);

  if (s.byCode.length === 0) {
    return `🔍 *Reply audit*\n\nScanned *${s.scanned}* real replies.\n\n✅ No defects detected.\n\nThat means none of the ${Object.keys(LABELS).length} known failure patterns appear. It does not mean the coach is perfect — it means these specific bugs are not recurring.\n\n${guardStatsLine()}\n\n${jobs}`;
  }

  const lines = s.byCode.map(r => {
    const label = LABELS[r.code] || r.code;
    return `*${r.count}×* ${label}`;
  }).join("\n");

  const worst = s.byCode[0];
  const ex = worst.examples[0];
  const example = ex
    ? `\n\n*Worst one — ${LABELS[worst.code] || worst.code}:*\nThey said: _"${ex.in || "(nothing)"}"_\nCoach said: _"${ex.out.replace(/\n/g, " ").slice(0, 160)}"_`
    : "";

  return `🔍 *Reply audit*\n\nScanned *${s.scanned}* real replies — *${s.defects}* carry a defect (${pct}%).\n\n${lines}${trend}${example}\n\n${guardStatsLine()}\n\n${jobs}${wider}`;
}
