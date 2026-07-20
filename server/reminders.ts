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

export { parseReminderRequest, describeFireTime } from "./reminders-parse";
export type { ParsedReminder } from "./reminders-parse";

export async function createReminder(userId: string, phone: string, body: string, fireAt: Date): Promise<void> {
  await db.insert(reminders).values({ userId, phoneNumber: phone, body, fireAt });
}

export async function listPendingReminders(userId: string) {
  return db.select().from(reminders)
    .where(and(eq(reminders.userId, userId), eq(reminders.status, "pending")))
    .orderBy(reminders.fireAt);
}

/** Cancel all pending reminders for a user. Returns how many were cancelled. */
export async function cancelAllReminders(userId: string): Promise<number> {
  const pending = await listPendingReminders(userId);
  if (!pending.length) return 0;
  await db.update(reminders).set({ status: "cancelled" })
    .where(and(eq(reminders.userId, userId), eq(reminders.status, "pending")));
  return pending.length;
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
