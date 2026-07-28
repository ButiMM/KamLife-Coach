/**
 * COACH COMMAND "engagement" — the retention picture, textable.
 *
 * (2026-07-28, ledger D5.) Reads real activity and answers three questions: who is slipping,
 * what the drop-off curve looks like, and what the coach said last to the people who went quiet.
 *
 * Read-only. Never writes, never messages a client — it reports to the founder and nothing else.
 */

import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { users, chatHistory, mealLogs } from "../../shared/schema";
import { summariseEngagement, type ActivityRow } from "../engagement";

const DAY = 86_400_000;

/** Pull the activity picture for every real client. One query per table, not per user. */
export async function loadActivityRows(): Promise<ActivityRow[]> {
  const clients = await db
    .select({ id: users.id, name: users.name, createdAt: users.createdAt })
    .from(users)
    .where(isNotNull(users.createdAt));
  if (clients.length === 0) return [];

  // Every inbound turn (the client actually spoke) and every meal log, in one sweep each.
  const [inbound, meals] = await Promise.all([
    db.select({ userId: chatHistory.userId, createdAt: chatHistory.createdAt, intent: chatHistory.intent, messageOut: chatHistory.messageOut })
      .from(chatHistory)
      .where(isNotNull(chatHistory.messageIn))
      .orderBy(desc(chatHistory.createdAt)),
    db.select({ userId: mealLogs.userId, loggedAt: mealLogs.loggedAt }).from(mealLogs),
  ]);

  const lastIn = new Map<string, Date>();
  const lastIntent = new Map<string, string | null>();
  for (const t of inbound) {                       // newest first, so the first hit wins
    if (!t.userId || !t.createdAt) continue;
    if (!lastIn.has(t.userId)) {
      lastIn.set(t.userId, new Date(t.createdAt));
      lastIntent.set(t.userId, t.intent || null);
    }
  }

  const days = new Map<string, Set<number>>();
  const addDay = (userId: string | null, at: Date | null, start: Date) => {
    if (!userId || !at) return;
    const d = Math.max(0, Math.floor((new Date(at).getTime() - start.getTime()) / DAY));
    if (!days.has(userId)) days.set(userId, new Set());
    days.get(userId)!.add(d);
  };
  const startOf = new Map(clients.map(c => [c.id, new Date(c.createdAt!)]));
  for (const m of meals) {
    const start = startOf.get(m.userId || "");
    if (start) addDay(m.userId, m.loggedAt, start);
  }

  return clients.map(c => ({
    userId: c.id,
    name: c.name,
    createdAt: new Date(c.createdAt!),
    lastInboundAt: lastIn.get(c.id) || null,
    activeDays: [...(days.get(c.id) || [])].sort((a, b) => a - b),
    lastCoachIntent: lastIntent.get(c.id) || null,
  }));
}

export async function engagementCommand(): Promise<string> {
  const rows = await loadActivityRows();
  if (rows.length === 0) return "No clients on record yet — nothing to measure.";

  const s = summariseEngagement(rows, new Date());

  const bands = `👤 *${s.total}* clients\n`
    + `🟢 Active (spoke in 2 days): *${s.byBand.active}*\n`
    + `🟡 Slipping (3–6 days): *${s.byBand.slipping}*\n`
    + `🟠 Quiet (7–13 days): *${s.byBand.quiet}*\n`
    + `🔴 Gone (14+ days): *${s.byBand.gone}*`;

  const curve = s.curve.length
    ? `\n\n📉 *Still logging at:*\n` + s.curve
        .map(p => p.of === 0 ? `Day ${p.day}: — (nobody that old yet)` : `Day ${p.day}: *${p.pct}%* (${p.stillActive} of ${p.of})`)
        .join("\n")
    : "";

  const risk = s.atRisk.length
    ? `\n\n⚠️ *Reach out to these first:*\n` + s.atRisk
        .map(r => `${r.name} — quiet *${r.daysSinceActive}d*, day ${r.journeyDay} of their journey`)
        .join("\n")
    : `\n\n✅ Nobody is slipping right now.`;

  const trig = s.triggers.length
    ? `\n\n🔎 *Last thing the coach said before they went quiet:*\n`
      + s.triggers.slice(0, 5).map(t => `${t.count}× ${t.intent} (${t.share}%)`).join("\n")
      + `\n\n_Correlation, not proof — but if one of those keeps showing up, read those replies._`
    : "";

  return `📊 *Engagement*\n\n${bands}${curve}${risk}${trig}`;
}
