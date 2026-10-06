/**
 * FRICTION MONITOR — surfaces the client who is quietly FIGHTING the bot.
 *
 * (2026-07-22, Kam: "people can't be fighting with the bot all the time… we need to be
 * monitoring them, what they're logging, how they're struggling.") A client can message
 * every single day — so the activity-based triage queue calls them healthy — while hating
 * every reply: correcting a mis-read meal, rejecting a log, getting cold-redirected, venting.
 * Those moments were invisible. This records each one and lets the triage queue rank by them,
 * so a client having a rough week bubbles to the top BEFORE they churn in silence.
 *
 * Storage: reuses the quality_signals table (kind = friction_*), so no migration. Capture is
 * the same fire-and-forget contract as quality signals — it never throws, never blocks a reply.
 */

import { db } from "./db";
import { qualitySignals, turnLedger, users, adminEvents } from "../shared/schema";
import { and, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { captureQualitySignal } from "./quality-signals";

export type FrictionKind =
  | "correction"    // client corrected a mis-read food ("it's not vetkoek, it's magwinya")
  | "rejection"     // client rejected a log outright ("no", "wrong", "that's not it")
  | "redirect"      // the domain gate cold-redirected them ("I'm Coach K…")
  | "frustration";  // client vented at the bot ("useless", "this doesn't work")

/** The quality_signals `kind` value for each friction moment. */
export const frictionSignalKind = (k: FrictionKind): string => `friction_${k}`;

/** Every friction kind as it appears in the table — for the aggregation query. */
export const FRICTION_SIGNAL_KINDS: string[] =
  (["correction", "rejection", "redirect", "frustration"] as FrictionKind[]).map(frictionSignalKind);

/**
 * Record one friction moment. Fire-and-forget (delegates to captureQualitySignal, which never
 * throws or blocks). A friction row is a bonus signal for the operator — it must never be able
 * to delay or break the client's reply.
 */
export function captureFriction(kind: FrictionKind, opts: {
  userId?: string | null;
  phone?: string | null;
  messageIn?: string | null;
  messageOut?: string | null;
  detail?: string | null;
}): void {
  captureQualitySignal(frictionSignalKind(kind) as any, opts);
}

/**
 * Per-client friction count over the last 7 days (userId → count). Read-only; used by the
 * triage endpoint to rank the "needs attention" queue. Anonymous signals (no userId) are
 * dropped — they can't be attributed to a client to act on.
 */
export async function frictionCountsLast7(): Promise<Map<string, number>> {
  const since = new Date(Date.now() - 7 * 86400000);
  const rows = await db
    .select({ userId: qualitySignals.userId, n: sql<number>`COUNT(*)::int` })
    .from(qualitySignals)
    .where(and(
      gte(qualitySignals.createdAt, since),
      isNotNull(qualitySignals.userId),
      inArray(qualitySignals.kind, FRICTION_SIGNAL_KINDS),
    ))
    .groupBy(qualitySignals.userId);
  return new Map(rows.filter(r => r.userId).map(r => [r.userId as string, Number(r.n)]));
}

/**
 * PURE — how a week's friction count should colour a client in the triage queue.
 * Kept separate from the DB so it's unit-testable and its thresholds are one obvious place.
 *   4+ rough moments in a week  → red  (they are fighting the bot; read their chat)
 *   2–3 rough moments           → yellow (something is misfiring; check it)
 *   0–1                         → none (normal — a stray correction isn't a problem)
 */
export type FrictionFlag = { level: "red" | "yellow"; reason: string; nextAction: string } | null;
export function frictionFlag(count: number): FrictionFlag {
  if (count >= 4) {
    return {
      level: "red",
      reason: `Fighting the bot — ${count} rough moments this week`,
      nextAction: "Read their chat; the bot is failing them",
    };
  }
  if (count >= 2) {
    return {
      level: "yellow",
      reason: `${count} rough moments with the bot this week`,
      nextAction: "Check what's misfiring in their chats",
    };
  }
  return null;
}

/**
 * LIVE SCORING FROM SIGNALS (D7, CTO 6 Oct). No model call: every delivered turn is scored by what
 * the client did next, from signals we already record. Friction after it (a correction, a rejection,
 * venting, a cold redirect), "you forgot" / "I told you" within their next two messages, an opt-out
 * within two hours, and silence after a coach question. The worst turns go to the founder once a day.
 */
export type LiveTurn = { id: string; userId: string; at: Date; input: string; reply: string };
export type LiveSignal = { userId: string; at: Date; kind: string };
export type ScoredTurn = LiveTurn & { score: number; why: string[]; next: string };
const SIGNAL_WEIGHT: Record<string, [number, string]> = {
  friction_correction: [3, "corrected"], friction_rejection: [3, "rejected"], friction_frustration: [4, "frustrated"],
  friction_redirect: [1, "redirected"], opt_out: [5, "opted out"],
};
export function scoreLiveTurns(turns: LiveTurn[], signals: LiveSignal[], isMemoryGrievance: (m: string) => boolean, now = Date.now()): ScoredTurn[] {
  const byUser = new Map<string, LiveTurn[]>();
  for (const t of [...turns].sort((a, b) => a.at.getTime() - b.at.getTime())) byUser.set(t.userId, [...(byUser.get(t.userId) ?? []), t]);
  const out: ScoredTurn[] = [];
  for (const list of byUser.values()) list.forEach((t, i) => {
    const after = list.slice(i + 1, i + 3);
    const until = after.length ? after[after.length - 1].at.getTime() + 60_000 : t.at.getTime() + 6 * 3600_000;
    const why: string[] = [];
    let score = 0;
    for (const sg of signals) {
      const at = sg.at.getTime(), w = SIGNAL_WEIGHT[sg.kind];
      if (!w || sg.userId !== t.userId || at <= t.at.getTime()) continue;
      if (at <= (sg.kind === "opt_out" ? Math.min(until, t.at.getTime() + 120 * 60_000) : until)) { score += w[0]; why.push(w[1]); }
    }
    if (after.some(n => isMemoryGrievance(n.input))) { score += 4; why.push("\"you forgot\""); }
    if (!after.length && t.reply.includes("?") && now - t.at.getTime() > 6 * 3600_000) { score += 1; why.push("silence after a question"); }
    if (score > 0) out.push({ ...t, score, why: [...new Set(why)], next: after[0]?.input ?? "" });
  });
  return out.sort((a, b) => b.score - a.score || b.at.getTime() - a.at.getTime());
}
const quote = (t: string, n: number) => { const s = t.replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
/** The digest text: counts, then the worst five, each with the client's last 3 digits, why, and both sides quoted. */
export function liveDigest(scored: ScoredTurn[], turns: number, phoneOf: (userId: string) => string): string {
  const head = `Coach health, last 24h: ${turns} turns, ${scored.length} with a bad sign after them.`;
  if (!scored.length) return `${head} Nothing to read today.`;
  return [head, "Worst " + Math.min(5, scored.length) + ":", ...scored.slice(0, 5).map((t, i) =>
    `${i + 1}. …${phoneOf(t.userId)} · ${t.why.join(", ")}\n   Coach: «${quote(t.reply, 140)}»${t.next ? `\n   Then: «${quote(t.next, 100)}»` : ""}`)].join("\n\n");
}
const LIVE_DIGEST_KEY = "live_digest_day";
/** Build and send today's digest once, from the sweep that runs in the 18:00 SAST hour. */
export async function sendLiveDigestOnce(now = Date.now()): Promise<boolean> {
  const { sastHour, sastDayKey } = await import("./sast");
  const { loadState, saveState } = await import("./scheduler/shared");
  if (sastHour(now) !== 18 || loadState()[LIVE_DIGEST_KEY] === sastDayKey(now)) return false;
  const since = new Date(now - 24 * 3600_000);
  const [rows, signals, opts, phones] = await Promise.all([
    db.select({ id: turnLedger.id, userId: turnLedger.userId, at: turnLedger.createdAt, input: turnLedger.inputText, reply: sql<string>`coalesce(${turnLedger.deliveredBody}, ${turnLedger.reply})` })
      .from(turnLedger).where(gte(turnLedger.createdAt, since)),
    db.execute(sql`SELECT user_id::text u, created_at at, kind FROM quality_signals WHERE created_at >= ${since} AND kind LIKE 'friction_%' AND user_id IS NOT NULL`),
    db.execute(sql`SELECT user_id::text u, created_at at FROM chat_history WHERE created_at >= ${since} AND intent = 'OPT_OUT'`),
    db.select({ id: users.id, phone: users.phoneNumber }).from(users),
  ]);
  const turns: LiveTurn[] = rows.filter(r => r.at && r.reply).map(r => ({ id: String(r.id), userId: String(r.userId), at: new Date(r.at!), input: String(r.input || ""), reply: String(r.reply) }));
  const sig: LiveSignal[] = [
    ...(signals.rows as any[]).map(r => ({ userId: String(r.u), at: new Date(r.at), kind: String(r.kind) })),
    ...(opts.rows as any[]).map(r => ({ userId: String(r.u), at: new Date(r.at), kind: "opt_out" })),
  ];
  const { isMemoryGrievance } = await import("./understanding/actions");
  const phone = new Map(phones.map(p => [String(p.id), String(p.phone || "").slice(-3)]));
  const text = liveDigest(scoreLiveTurns(turns, sig, isMemoryGrievance, now), turns.length, u => phone.get(u) || "???");
  await db.insert(adminEvents).values({ action: "live_digest", meta: { turns: turns.length }, reason: "turn triage" }).catch(() => {}); // a read of client turns is audited
  const sent = await (await import("./scheduler/jobs/balance-check")).alertOps(text);
  saveState(LIVE_DIGEST_KEY, sastDayKey(now));
  return sent;
}
