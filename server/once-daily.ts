/**
 * ONCE PER DAY, ACROSS RESTARTS.
 *
 * (2026-07-28, found live: the 30-day achievement card fired TWICE in one day — 13:34 and 21:25.)
 *
 * Three "we already did this today" guards were plain in-memory Maps:
 *
 *   _streakShownToday    (food-scanner)  — the milestone celebration
 *   _lowCalWarnedToday   (food-scanner)  — the under-eating warning
 *   taughtToday          (education)     — the teaching note
 *
 * Every one of them is wiped by a Railway redeploy. We deploy several times a day, so a client
 * can be congratulated for the same thirty-day streak twice, warned twice, taught the same thing
 * twice. It got worse the moment cards became the shareable artifact: the second identical card
 * turns the best moment in the product into something that looks broken.
 *
 * The fix needs no migration. `sent_proactive` already exists with a unique index on
 * (user_id, message_key, dedupe_window) — precisely "we sent X to this person in window W". The
 * insert is the lock: a duplicate hits the unique index and tells us it was already done.
 *
 * The in-memory Map stays in FRONT as a fast path. It is now a cache, not the source of truth,
 * which is the difference between "fast" and "wrong after a deploy".
 */

import { db } from "./db";
import { sentProactive } from "../shared/schema";
import { sastDayKey } from "./sast";

/** Fast path only. Losing it on restart is now harmless — the database still knows. */
const seen = new Set<string>();

function cacheKey(userId: string, key: string, day: string): string {
  return `${userId}|${key}|${day}`;
}

/**
 * Claim the one slot for `key` today. Returns true if THIS call won it — i.e. do the thing.
 * Returns false if it was already done today, by this process or any other.
 *
 * Fail-open on a database error: the client gets the message. Losing a celebration to a blip is
 * worse than sending it twice, and a guard that swallows the moment it was built to protect is
 * the wrong trade.
 */
export async function claimOncePerDay(userId: string, key: string): Promise<boolean> {
  if (!userId) return true;
  const day = sastDayKey();
  const ck = cacheKey(userId, key, day);
  if (seen.has(ck)) return false;

  try {
    const rows = await db.insert(sentProactive)
      .values({ userId, messageKey: key, dedupeWindow: day })
      .onConflictDoNothing()
      .returning({ id: sentProactive.id });
    const won = rows.length > 0;
    if (won) seen.add(ck);
    else seen.add(ck); // already claimed elsewhere — remember, so we don't ask again today
    return won;
  } catch (e) {
    console.warn("[ONCE_DAILY] claim failed, allowing:", (e as any)?.message || e);
    return true;
  }
}

/** Read-only check. Prefer claimOncePerDay — checking then acting has a race between the two. */
export async function alreadyDoneToday(userId: string, key: string): Promise<boolean> {
  if (!userId) return false;
  return seen.has(cacheKey(userId, key, sastDayKey()));
}

/** Test seam — the cache is process-wide and would leak between cases otherwise. */
export function _resetOnceDailyCache(): void {
  seen.clear();
}
