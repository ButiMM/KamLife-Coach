/**
 * SAST — the one place that decides which DAY something happened on.
 *
 * (Ledger D6, 2026-07-28.) Every third-party reviewer landed on the same finding about this
 * codebase, in different words: "policy leakage", "copy-paste inheritance", "the same protective
 * rule implemented at one call site and missing at four others". This module is the first slice
 * of the fix, and it starts here because day boundaries are where that pattern does real damage.
 *
 * The offset `2 * 3_600_000` appears 98 times across 20+ files, and the hand-rolled versions do
 * NOT agree with each other:
 *
 *   utils.sastToday()            → "2026-07-08"   (zero-padded, via toISOString)
 *   food-scanner._todaySastKey() → "2026-7-8"     (NOT padded — built by hand)
 *
 * Both are "the SAST day key". They will never be equal for the same day. Nothing compares them
 * today, which is precisely the kind of latent bug that surfaces months later as "my streak
 * reset for no reason" — and no test would have caught it, because each function is correct on
 * its own terms. That is the whole shape of the systemic defect.
 *
 * So: one module, one format, one definition of a day. SAST is UTC+2 with no daylight saving,
 * which is what makes this tractable — there is exactly one right answer.
 *
 * Pure — no DB, no clock of its own beyond Date.now(). Unit-tested.
 */

/** South Africa is UTC+2 year-round. No DST, ever — this is a constant, not an approximation. */
export const SAST_OFFSET_MS = 2 * 3_600_000;

/** The wall-clock SAST instant for a UTC time, as a Date whose UTC fields read as SAST. */
function inSast(at?: Date | number): Date {
  const base = at == null ? Date.now() : at instanceof Date ? at.getTime() : at;
  return new Date(base + SAST_OFFSET_MS);
}

/**
 * THE day key: "2026-07-08", always zero-padded, always SAST.
 *
 * Every map key, every grouping, every "have we already done this today" check uses this one
 * format, so two of them can never silently fail to match.
 */
export function sastDayKey(at?: Date | number): string {
  return inSast(at).toISOString().slice(0, 10);
}

/** The UTC instant of SAST midnight for the day containing `at` (default: now). */
export function sastDayStart(at?: Date | number): Date {
  return new Date(`${sastDayKey(at)}T00:00:00+02:00`);
}

/** SAST hour, 0–23. The basis of every meal-slot and small-hours decision. */
export function sastHour(at?: Date | number): number {
  return inSast(at).getUTCHours();
}

/** True when `at` falls on an earlier SAST day than `now` — i.e. a retroactive log. */
export function isPastSastDay(at: Date | number, now?: Date | number): boolean {
  return sastDayStart(at).getTime() < sastDayStart(now).getTime();
}

/** Whole SAST days between two instants. Same day = 0. Never negative unless `to` is earlier. */
export function sastDaysBetween(from: Date | number, to?: Date | number): number {
  return Math.round((sastDayStart(to).getTime() - sastDayStart(from).getTime()) / 86_400_000);
}

/**
 * The SAST day key `n` days before the day containing `at`. Built by walking day starts rather
 * than subtracting 86_400_000 from a timestamp, so it stays correct across month and year ends.
 */
export function sastDayKeyBefore(n: number, at?: Date | number): string {
  return sastDayKey(sastDayStart(at).getTime() - n * 86_400_000);
}

/**
 * Monday 00:00 SAST of the week containing `at`. "This week" is this window, never a rolling
 * 7-day lookback. Rolling windows on a Monday steal last week's sessions and call them this week's.
 */
export function sastWeekStart(at?: Date | number): Date {
  const start = sastDayStart(at);
  const dow = inSast(start).getUTCDay(); // 0 Sun … 6 Sat
  const daysFromMonday = (dow + 6) % 7;
  return new Date(start.getTime() - daysFromMonday * 86_400_000);
}

/** Exclusive end of that SAST calendar week (next Monday 00:00). */
export function sastWeekEnd(at?: Date | number): Date {
  return new Date(sastWeekStart(at).getTime() + 7 * 86_400_000);
}
