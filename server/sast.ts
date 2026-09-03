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


// Meal/event temporal attribution is colocated with the canonical SAST day owner.
// Deterministic meal slot from the SAST hour — used to label a food log when the client
// doesn't say which meal it is. Total over all 24h (no gaps): the 15:00–17:00 window
// falls to "snack". The 22:00–05:00 window is snack ONLY for genuinely light bites —
// a night-shift client's 02:00 plate of pap and wors is their MAIN meal, not a snack
// (2026-07-17 inference design: infer, don't interrogate — and don't mislabel either).
export function slotFromSastHour(date: Date = new Date(), opts?: { nightWorker?: boolean; substantial?: boolean }): "breakfast" | "lunch" | "dinner" | "snack" | "night meal" {
  const h = new Date(date.getTime() + 2 * 3_600_000).getUTCHours();
  if (h >= 5 && h < 11) return "breakfast";
  if (h >= 11 && h < 15) return "lunch";
  if (h >= 17 && h < 22) return "dinner";
  if ((h >= 22 || h < 5) && (opts?.nightWorker || opts?.substantial)) return "night meal";
  return "snack";
}

// EARLY-HOURS RETRO — the meal that lands in the small hours (00:00–04:59 SAST) almost always
// belongs to the day that just ENDED, not a fresh one: a 4am "dinner" is LAST NIGHT's dinner
// (2026-07-23 live: a dinner photo at 04:07 was filed under the new day, so the whole day's
// numbers were wrong). Shift such a log back to the previous day — UNLESS the client explicitly
// tied it to now/today, or it reads as a genuine early breakfast. Pure + conservative: only the
// ambiguous small hours are ever touched, daytime logs are returned untouched. Known trade-off:
// a true night-shift eater's 2–4am meal is rare next to people reporting the night just gone.
export function effectiveMealLoggedAt(loggedAt: Date, rawMessage: string, mealLabel: string | null | undefined): Date {
  const sastHour = new Date(loggedAt.getTime() + 2 * 3_600_000).getUTCHours();
  if (sastHour >= 5) return loggedAt; // only 00:00–04:59 is ambiguous
  const lo = (rawMessage || "").toLowerCase();
  if (/\b(now|just|right now|just now|today|this morning|currently|about to|going to|tonight|early)\b/.test(lo)) return loggedAt;
  if (mealLabel === "breakfast") return loggedAt; // a 3–4am breakfast is a real early start
  return new Date(loggedAt.getTime() - 24 * 3_600_000); // → the day that just ended
}

// A clock time written in a caption tells us the meal SLOT even when the photo is batch-sent
// hours later (2026-07-22, Puntsa's photo diary: shot at "11:00", the whole day sent at 19:49
// — the send-clock mislabelled it dinner). Requires a colon-time or am/pm so it never fires on
// a quantity ("2 eggs", "500ml"). Returns null when there's no time to read.
export function slotFromCaptionTime(msg: string): "breakfast" | "lunch" | "dinner" | "snack" | null {
  const lo = (msg || "").toLowerCase();
  let hour: number | null = null;
  const hm = lo.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
  const ap = lo.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (hm) {
    hour = parseInt(hm[1], 10);
    if (hm[3] === "pm" && hour < 12) hour += 12;
    if (hm[3] === "am" && hour === 12) hour = 0;
  } else if (ap) {
    hour = parseInt(ap[1], 10);
    if (ap[2] === "pm" && hour < 12) hour += 12;
    if (ap[2] === "am" && hour === 12) hour = 0;
  }
  if (hour === null || hour < 0 || hour > 23) return null;
  if (hour <= 11) return "breakfast"; // includes late-morning brunch (11:00 eggs)
  if (hour <= 15) return "lunch";
  if (hour <= 16) return "snack";
  return "dinner";
}

// Does this client work nights? Read from the onboarding answers we already hold —
// the same data that steers their programme timing.
export function isNightWorker(user: any): boolean {
  return /night/i.test(String(user?.workSchedule || "")) || /night.?shift/i.test(String(user?.lifeSituation || user?.jobType || ""));
}

// Parse time references from food log messages and return the appropriate loggedAt date.
// Handles: "yesterday", "last night", "this morning", "earlier", "2 days ago",
// day-of-week names ("Saturday", "on Sunday"), and time-of-day hints within those.
// Returns a Date set to a reasonable SAST-anchored time for that meal.
export function parseMealDate(message: string): Date {
  const m = message.toLowerCase();
  const nowSAST = Date.now() + 2 * 3_600_000; // ms in SAST equivalent

  // Relative days are anchored to the SAST calendar day, not UTC-now. The old
  // "now minus 24h" versions were wrong in the 00:00–02:00 SAST window: at 01:25
  // SAST, "yesterday" resolved to TWO SAST days back, logging the meal to the
  // wrong day and corrupting totals/streaks (caught live by routing-audit,
  // 2026-07-06 23:25 UTC). sastDayStart() is the UTC instant of SAST midnight.
  const todayStartSAST = sastDayStart();

  // "2 days ago", "two days ago" → noon SAST on that day
  const daysAgoMatch = m.match(/\b(\d+|one|two|three)\s+days?\s+ago\b/);
  if (daysAgoMatch) {
    const n = { one: 1, two: 2, three: 3 }[daysAgoMatch[1] as string] || parseInt(daysAgoMatch[1]);
    return new Date(todayStartSAST.getTime() - n * 86_400_000 + 12 * 3_600_000);
  }

  // "last night" → yesterday at 8pm SAST
  if (/\b(last night|tonight|yesterday.?night|previous night)\b/.test(m)) {
    return new Date(todayStartSAST.getTime() - 86_400_000 + 20 * 3_600_000);
  }

  // "yesterday" → yesterday at noon SAST
  if (/\byesterday\b/.test(m)) {
    return new Date(todayStartSAST.getTime() - 86_400_000 + 12 * 3_600_000);
  }

  // Day-of-week references: "on Saturday", "had this Saturday", "Sunday morning", etc.
  // Maps to the most recent past occurrence of that day (never future).
  const DOW_NAMES_MAP: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  const dowMatch = m.match(/\b(on\s+)?(last\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (dowMatch) {
    const targetDow = DOW_NAMES_MAP[dowMatch[3]];
    const nowSASTDate = new Date(nowSAST);
    const currentDow = nowSASTDate.getUTCDay();
    let daysBack = (currentDow - targetDow + 7) % 7;
    if (daysBack === 0) daysBack = 7; // same day name = last week's occurrence
    // SAST midnight of the target day + SAST wall-clock time. Anchoring the DATE
    // to UTC-now put day-name meals one day off between 00:00–02:00 SAST (same
    // midnight-window family as the "yesterday" bug, 2026-07-07).
    const dayStartMs = todayStartSAST.getTime() - daysBack * 86_400_000;
    const timeMatch = m.match(/\b(\d{1,2})[:.h](\d{2})\b/);
    let sastClockMs: number;
    if (timeMatch) {
      sastClockMs = (parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2])) * 60_000;
    } else if (/\b(morning|breakfast|after gym)\b/.test(m)) {
      sastClockMs = 8 * 3_600_000;   // 8am SAST
    } else if (/\b(lunch|midday|afternoon|around noon)\b/.test(m)) {
      sastClockMs = 12 * 3_600_000;  // noon SAST
    } else if (/\b(night|dinner|supper|evening)\b/.test(m)) {
      sastClockMs = 20 * 3_600_000;  // 8pm SAST
    } else {
      sastClockMs = 12 * 3_600_000;  // default noon SAST
    }
    return new Date(dayStartMs + sastClockMs);
  }

  // "this morning" / "for breakfast" early in message → today at 8am SAST (only if current SAST time is past 11am)
  const sastHour = new Date(nowSAST).getUTCHours();
  if (/\b(this morning|had.*breakfast|breakfast.*was|morning meal)\b/.test(m) && sastHour >= 11) {
    const d = new Date();
    d.setUTCHours(6, 0, 0, 0); // 8am SAST = 6am UTC
    return d;
  }

  // "earlier today" / "earlier" → 3 hours ago
  if (/\b(earlier today|earlier|a few hours ago|hours ago)\b/.test(m)) {
    return new Date(Date.now() - 3 * 3_600_000);
  }

  // "forgot to log dinner" / "missed logging lunch" with no explicit day: decide today vs
  // yesterday by whether the named meal's time has passed yet. Dinner asked in the morning =
  // yesterday's dinner; breakfast asked in the afternoon = today's (forgotten earlier today).
  if (/\b(forgot|missed|didn.?t|did\s*not|never)\b/.test(m)
      && /\b(log|logs|logg(?:ed|ing)|add|added|adding|track|tracked|tracking|record|recorded|enter|entered|capture)\b/.test(m)
      && !/\b(today|this\s+morning|this\s+afternoon|this\s+evening|tonight|just\s+now|now)\b/.test(m)) {
    const mealHour = /\b(breakfast|brekkie|morning)\b/.test(m) ? 8
      : /\b(lunch|midday|noon)\b/.test(m) ? 13
      : /\b(dinner|supper|evening|night)\b/.test(m) ? 19
      : null;
    if (mealHour !== null) {
      const base = sastHour < mealHour ? Date.now() - 86_400_000 : Date.now(); // not happened yet today → yesterday
      const d = new Date(base);
      d.setUTCHours(Math.max(0, mealHour - 2), 0, 0, 0); // mealHour SAST → UTC
      return d;
    }
  }

  return new Date(); // default to now
}

/**
 * WHEN DID THIS HAPPEN? The temporal classifier a durable write consults (2026-08-22, P0-B).
 * Renamed from trainingWhen 2026-08-24: it reads a MESSAGE, not a workout, and the food
 * correction path needs the same answer — a correction must land on the day being corrected.
 *
 * The workout writer decided this with its own day-word list, and that list was a SUBSET of what
 * parseMealDate below already resolves — so "I trained Monday" (no "on") named a day the parser
 * understands, the detector missed it, and the session was written to TODAY. "I trained last
 * week" named no day at all and also landed on today.
 *
 * The fix is not more day words; it is to stop asking a second question.
 *
 *   historical  parseMealDate resolves it to a SAST day that is not today — every form the
 *               parser knows is inherited, which is the point of asking it.
 *   ambiguous   it points at a SPAN rather than a day ("last week", "over the weekend"), or it
 *               names both today and a past day. A date we cannot pin is not one we may write.
 *   today       an explicit today anchor, or no temporal reference at all — the ordinary case,
 *               behaving exactly as before.
 *
 * The span list is the only literal vocabulary, and it is closed by grammar: the ways English
 * names a period without naming a day. It is not a list of ways to say "I trained".
 */
export type StatedWhen = "today" | "historical" | "ambiguous";

/** "Does this message say TODAY?" — moved here from handlers/food-context.ts (2026-08-22) when
 *  the temporal classifier below needed the same answer. One owner; food-context imports it. */
export const SAYS_TODAY_RE = /\b(today|this morning|this afternoon|this evening|tonight|just now|right now|earlier today)\b/i;
const A_SPAN_NOT_A_DAY = /\b(?:last|past|previous|this)\s+(?:week|month|fortnight)\b|\bweekend\b|\bthe\s+other\s+day\b|\ba\s+while\s+(?:back|ago)\b|\brecently\b|\blately\b|\bpast\s+few\s+days\b|\bcouple\s+of\s+(?:weeks|months)\b/i;

export function statedWhen(message: string): { when: StatedWhen; date: Date } {
  const text = String(message || "");
  const resolved = parseMealDate(text);
  const isToday = sastDayStart(resolved).getTime() === sastDayStart().getTime();

  // A span first: "last week" resolves to nothing, so the parser would hand back today and the
  // write would land on the wrong day silently. This is the case that has no date to fall back on.
  if (A_SPAN_NOT_A_DAY.test(text)) return { when: "ambiguous", date: resolved };
  // Both a today anchor and a past day in one message — we are being told two things and may
  // act on neither. Refusing costs a log; guessing corrupts a date the client cannot see to fix.
  if (!isToday && SAYS_TODAY_RE.test(text)) return { when: "ambiguous", date: resolved };
  return { when: isToday ? "today" : "historical", date: resolved };
}

// Returns true if the message contains a clear retroactive date reference (not today).
export function isRetroactiveMeal(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(yesterday|last night|days? ago|on\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|last\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|had this (saturday|sunday|monday|tuesday|wednesday|thursday|friday)|saturday|sunday)\b/.test(m);
}

// Retro-date hallucination brake for the normalizer. The intent classifier
// (gpt-4o-mini) sometimes adds "yesterday" to a WORKOUT_LOG canonical when the
// client never said it — e.g. "Hack squat 25kg, 6 reps" → "workout done
// yesterday". That invented date makes the workout handler fire its retroactive
// branch and reply "already got yesterday's workout logged" instead of crediting
// today's session. This strips any retro-date token from `canonical` that does
// NOT appear in `original`, so a real "...yesterday" is preserved and an invented
// one is removed. Pure + unit-tested (production bug 2026-06-24).
const RETRO_DATE_RE = /\b(yesterday|last night|last\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d+\s+days?\s+ago)\b/gi;
export function stripInventedRetroDate(canonical: string, original: string): string {
  const orig = original.toLowerCase();
  // Only strip tokens the client did not actually write.
  const cleaned = canonical.replace(RETRO_DATE_RE, (match) =>
    orig.includes(match.toLowerCase()) ? match : "");
  return cleaned.replace(/\s{2,}/g, " ").trim();
}

// Future-intent / hypothetical detector — stops PLANNED actions ("I'll walk 10k
// tomorrow", "going to run 5km", "want to do yoga") from being logged as if already
// done. Used by the step and cardio loggers, which match the activity + number
// regardless of tense. Note: i'll requires the apostrophe so "ill"/"I feel ill"
// does not match; voice transcripts that drop it are covered by tomorrow/going to.
// Narrow on purpose: widening this loses real reports. See script/tracking-contract-tests.ts (#63).
export function isFutureIntent(message: string): boolean {
  const m = message.toLowerCase();
  return /\bi'll\b|\bi\s+will\b|\b(?:wanna|gonna)\b|\bgoing\s+to\b|\bplann?ing\s+to\b|\bplan\s+to\b|\babout\s+to\b|\bhoping\s+to\b|\bwant\s+to\b|\bneeds?\s+to\b|\bhas\s+to\b|\bhave\s+to\b|\bsupposed\s+to\b|\baiming\s+(?:to|for)\b|\bmeant\s+to\b|\bthinking\s+(?:of|about)\b|\btomorrow\b|\bnext\s+week\b|\blater\s+today\b/i.test(m);
}
