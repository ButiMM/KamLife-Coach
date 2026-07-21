/**
 * USER-SET REMINDERS — persistence layer. The pure parser (parseReminderRequest,
 * describeFireTime) lives in reminders-parse.ts so it is unit-testable without the DB;
 * this module re-exports it and adds the create/list/cancel/fetch-due operations.
 *
 * A scheduler poll (scheduler/jobs/reminders.ts) fires the ones whose fireAt has passed.
 * fireAt is stored in real UTC; the parser anchors everything to SAST (UTC+2, no DST).
 */

import { db } from "./db";
import { reminders } from "../shared/schema";
import { eq, and, lte } from "drizzle-orm";

import { returnNudgeTime, describeFireTime } from "./reminders-parse";
import type { Recurrence } from "./reminders-parse";
export { parseReminderRequest, describeFireTime, returnNudgeTime } from "./reminders-parse";
export type { ParsedReminder, Recurrence } from "./reminders-parse";

export async function createReminder(userId: string, phone: string, body: string, fireAt: Date, recurrence: Recurrence = null): Promise<void> {
  await db.insert(reminders).values({ userId, phoneNumber: phone, body, fireAt, recurrence });
}

/** "every day at 8:00am" / "every Monday at 6:00am" — the recurring form of describeFireTime. */
export function describeRecurring(fireAt: Date, recurrence: Recurrence): string {
  const one = describeFireTime(fireAt); // "today at 8:00am" / "Mon 21 Jul at 6:00am"
  const time = one.replace(/^.*\bat\s+/, "at "); // keep just "at H:MMxm"
  if (recurrence === "daily") return `every day ${time}`;
  if (recurrence === "weekly") {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const d = new Date(fireAt.getTime() + 2 * 3_600_000).getUTCDay();
    return `every ${days[d]} ${time}`;
  }
  return one;
}

/** Client-facing reminders only ('my reminders' should never list system nudges). */
export async function listPendingReminders(userId: string) {
  return db.select().from(reminders)
    .where(and(eq(reminders.userId, userId), eq(reminders.status, "pending"), eq(reminders.kind, "user")))
    .orderBy(reminders.fireAt);
}

/** Cancel all pending CLIENT-SET reminders for a user. Returns how many were cancelled. */
export async function cancelAllReminders(userId: string): Promise<number> {
  const pending = await listPendingReminders(userId);
  if (!pending.length) return 0;
  await db.update(reminders).set({ status: "cancelled" })
    .where(and(eq(reminders.userId, userId), eq(reminders.status, "pending"), eq(reminders.kind, "user")));
  return pending.length;
}

/** Cancel any pending auto 'return' nudge for a user (dedupe when the date changes, or on recovery). */
export async function cancelReturnNudges(userId: string): Promise<void> {
  await db.update(reminders).set({ status: "cancelled" })
    .where(and(eq(reminders.userId, userId), eq(reminders.status, "pending"), eq(reminders.kind, "return")));
}

/**
 * THE TEMPORAL LOOP — auto-schedule a night-before "you're back tomorrow" nudge from a captured
 * return date, so a sick / away client is never met with silence (they never come back if we go
 * quiet). dateStr is the SAST return date (YYYY-MM-DD); the nudge fires at 19:00 SAST the evening
 * before. One active return nudge per client (deduped). No-op if the evening-before is already past.
 */
export async function scheduleReturnNudge(userId: string, phone: string, dateStr: string, kind: "sick" | "away"): Promise<void> {
  const nudgeAt = returnNudgeTime(dateStr);
  if (!nudgeAt) return; // malformed date, or the evening-before is already past
  await cancelReturnNudges(userId);
  const body = kind === "sick"
    ? "Tomorrow's the day you're cleared to get back to it. 💪 How are you feeling? If you're good, we start easy — session one at about 70%. Reply *I'm back* and I'll set it up. No rush if you need another day."
    : "Tomorrow you're back! Ready to pick up right where you left off — nothing reset, your plan's exactly where you left it. Reply *I'm back* and we go again. 💪";
  await db.insert(reminders).values({ userId, phoneNumber: phone, body, fireAt: nudgeAt, kind: "return" });
}

/** Fetch + claim all reminders due now (status flips to 'sent' atomically-ish per row). */
export async function fetchDueReminders(nowUtc: Date = new Date()) {
  return db.select().from(reminders)
    .where(and(eq(reminders.status, "pending"), lte(reminders.fireAt, nowUtc)))
    .orderBy(reminders.fireAt)
    .limit(200);
}

export async function markReminderSent(id: string): Promise<void> {
  await db.update(reminders).set({ status: "sent", sentAt: new Date() }).where(eq(reminders.id, id));
}

/** Next fire time for a recurring reminder, skipping any occurrences missed during downtime. */
export function nextRecurrenceTime(fireAt: Date, recurrence: Recurrence): Date {
  const ms = recurrence === "weekly" ? 7 * 86_400_000 : 86_400_000;
  let next = fireAt.getTime() + ms;
  const now = Date.now();
  while (next <= now) next += ms; // after downtime, jump to the next FUTURE occurrence — never spam a backlog
  return new Date(next);
}

/** Advance a recurring reminder to its next occurrence (stays pending). */
export async function advanceRecurring(id: string, nextFireAt: Date): Promise<void> {
  await db.update(reminders).set({ fireAt: nextFireAt }).where(eq(reminders.id, id));
}
