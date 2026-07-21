/**
 * MEDIA JOB CRASH-SAFETY NET.
 *
 * The WhatsApp webhook ACKs instantly and processes voice/photo/video in the background. The
 * async handlers already catch their own errors and reply. The ONE gap is a process death (OOM,
 * deploy, restart) between the ACK and the reply: the promise dies, no catch runs, the client
 * sits in silence. This is the lightweight, Redis-free recovery the external review asked for.
 *
 * Each media message records a 'pending' row; the handler marks it 'done' when the reply sends.
 * A scheduler sweep finds rows stuck 'pending' past a few minutes (a crashed job) and nudges the
 * client to resend, then marks them 'recovered'. Twilio media URLs expire, so re-processing isn't
 * reliable — the honest recovery is "please resend", which beats silence every time.
 *
 * All writes are BEST-EFFORT: they never throw into the hot path. If the table write fails, media
 * still processes normally — this is a safety net, not a dependency.
 */

import { db } from "./db";
import { mediaJobs } from "../shared/schema";
import { eq, and, lt, sql } from "drizzle-orm";

/** Record a media message as in-flight. Best-effort; a duplicate sourceMessageId is ignored. */
export async function recordMediaJob(sourceMessageId: string, phone: string, userId: string | null, mediaType: string | null): Promise<void> {
  if (!sourceMessageId) return;
  try {
    await db.insert(mediaJobs)
      .values({ sourceMessageId, phoneNumber: phone, userId: userId ?? null, mediaType: mediaType ?? null })
      .onConflictDoNothing();
  } catch (e) {
    console.warn("[MEDIA_JOB] record failed (non-fatal):", (e as any)?.message || e);
  }
}

/** Mark a media job finished (reply sent, or a handled error was delivered). Best-effort. */
export async function completeMediaJob(sourceMessageId: string | undefined): Promise<void> {
  if (!sourceMessageId) return;
  try {
    await db.update(mediaJobs).set({ status: "done", completedAt: new Date() })
      .where(and(eq(mediaJobs.sourceMessageId, sourceMessageId), eq(mediaJobs.status, "pending")));
  } catch (e) {
    console.warn("[MEDIA_JOB] complete failed (non-fatal):", (e as any)?.message || e);
  }
}

/**
 * Find media jobs stuck 'pending' past the cutoff (a job whose process died before it could
 * finish) and return them for recovery. Marks them 'recovered' so they're nudged exactly once.
 */
export async function claimStuckMediaJobs(olderThanMs = 3 * 60_000): Promise<{ phoneNumber: string; mediaType: string | null }[]> {
  const cutoff = new Date(Date.now() - olderThanMs);
  try {
    // Claim-then-return so a concurrent sweep (or a restart) can't double-nudge the same client.
    const rows = await db.update(mediaJobs)
      .set({ status: "recovered", completedAt: new Date() })
      .where(and(eq(mediaJobs.status, "pending"), lt(mediaJobs.createdAt, cutoff)))
      .returning({ phoneNumber: mediaJobs.phoneNumber, mediaType: mediaJobs.mediaType });
    return rows;
  } catch (e) {
    console.warn("[MEDIA_JOB] sweep failed (non-fatal):", (e as any)?.message || e);
    return [];
  }
}

/** Housekeeping: drop old finished rows so the table stays small. Best-effort. */
export async function purgeOldMediaJobs(olderThanMs = 24 * 3_600_000): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanMs);
  try {
    await db.delete(mediaJobs).where(and(sql`${mediaJobs.status} <> 'pending'`, lt(mediaJobs.createdAt, cutoff)));
  } catch { /* best-effort */ }
}
