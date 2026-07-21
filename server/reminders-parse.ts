/**
 * REMINDER PARSER — the pure, deterministic core (no DB, no side effects) so it is fully
 * unit-testable. server/reminders.ts re-exports these and adds the persistence layer.
 *
 * Everything is anchored to SAST (UTC+2, no DST); fireAt comes back as a real-UTC Date.
 * A reminder is a promise — the time maths is deterministic so the promise is kept.
 */

import { nextDayDate } from "./utils";

const SAST_OFFSET_MS = 2 * 3_600_000;
const pad = (n: number) => String(n).padStart(2, "0");

export type Recurrence = "daily" | "weekly" | null;
export type ParsedReminder =
  | { kind: "set"; body: string; fireAt: Date; recurrence: Recurrence }
  | { kind: "need_time"; body: string }
  | { kind: "need_body"; fireAt: Date; recurrence: Recurrence }
  | null;

/** SAST wall-clock "now" as a Date whose UTC fields read the SAST time. */
function sastNow(): Date {
  return new Date(Date.now() + SAST_OFFSET_MS);
}

/** Build a real-UTC Date for a given SAST calendar date (YYYY-MM-DD) at SAST H:M. */
function sastDateTimeToUtc(dateStr: string, h: number, min: number): Date {
  return new Date(`${dateStr}T${pad(h)}:${pad(min)}:00+02:00`);
}

/**
 * Parse a "remind me ..." message into a concrete fire time + reminder body. Returns null
 * if it isn't a reminder request at all. Anchored to SAST.
 */
export function parseReminderRequest(message: string): ParsedReminder {
  const raw = String(message || "").trim();
  const m = raw.toLowerCase();

  // Trigger — must actually be a reminder request.
  if (!/\b(remind me|remind us|set (a |an )?reminder|give me a reminder)\b/i.test(m)) return null;

  const now = sastNow();
  const todayStr = now.toISOString().slice(0, 10);
  const nowSastMs = now.getTime();

  // Substrings we strip out of the body once matched.
  const strip: RegExp[] = [];

  // ---- 0. RECURRENCE: "every day", "daily", "every morning", "every Monday" ----
  let recurrence: Recurrence = null;
  if (/\b(every ?day|everyday|daily|each day|every (morning|evening|night|afternoon))\b/i.test(m)) recurrence = "daily";
  else if (/\bevery (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(m)) recurrence = "weekly";
  if (recurrence) strip.push(/\b(every ?day|everyday|daily|each day|every)\b/i);

  // ---- 1. RELATIVE: "in 2 hours", "in 30 minutes", "in 3 days" ----
  let fireAt: Date | null = null;
  const rel = m.match(/\bin\s+(\d{1,3})\s*(min(?:ute)?s?|h(?:ou)?rs?|days?|weeks?)\b/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    let ms = 0;
    if (/^m/.test(unit)) ms = n * 60_000;
    else if (/^h/.test(unit)) ms = n * 3_600_000;
    else if (/^d/.test(unit)) ms = n * 86_400_000;
    else if (/^w/.test(unit)) ms = n * 7 * 86_400_000;
    if (ms > 0 && ms <= 60 * 86_400_000) {
      fireAt = new Date(Date.now() + ms);
      strip.push(new RegExp(`\\bin\\s+${n}\\s*${rel[2]}\\b`, "i"));
    }
  }

  // ---- 2. ABSOLUTE: a DATE word + a TIME-OF-DAY ----
  if (!fireAt) {
    // Target DATE — a day word bumps it; otherwise today.
    let dateStr = todayStr;
    const dayWord = m.match(/\b(today|tomorrow|tonight|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i);
    if (dayWord) {
      const w = dayWord[1].toLowerCase();
      if (w === "today" || w === "tonight") dateStr = todayStr;
      else {
        const nd = nextDayDate(w === "tomorrow" ? "tomorrow" : w);
        if (nd) dateStr = nd;
      }
      strip.push(new RegExp(`\\b${dayWord[1]}\\b`, "i"));
    }

    // Target TIME — an explicit clock, else a part-of-day default.
    let hh: number | null = null;
    let mm = 0;
    const clock = m.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i) || m.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
    if (clock) {
      let h = parseInt(clock[1], 10);
      mm = clock[2] ? parseInt(clock[2], 10) : 0;
      const ap = (clock[3] || "").toLowerCase();
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      if (h >= 0 && h <= 23 && mm >= 0 && mm <= 59) hh = h;
      strip.push(new RegExp(clock[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    } else if (/\btonight\b/i.test(m) || /\b(this |tomorrow )?evening\b/i.test(m)) {
      hh = 19; strip.push(/\b(this |tomorrow )?evening\b/i);
    } else if (/\b(this |tomorrow |in the )?morning\b/i.test(m)) {
      hh = 7; strip.push(/\b(this |tomorrow |in the )?morning\b/i);
    } else if (/\b(this |tomorrow |in the )?afternoon\b/i.test(m)) {
      hh = 14; strip.push(/\b(this |tomorrow |in the )?afternoon\b/i);
    } else if (/\b(noon|midday|lunch ?time)\b/i.test(m)) {
      hh = 12; strip.push(/\b(noon|midday|lunch ?time)\b/i);
    } else if (dayWord) {
      hh = 8; // a bare day ("remind me on Monday") defaults to 8am SAST
    } else if (recurrence) {
      hh = 8; // a recurring reminder with no stated time defaults to 8am SAST
    }

    if (hh !== null) {
      fireAt = sastDateTimeToUtc(dateStr, hh, mm);
      // A bare time today that has already passed rolls to tomorrow (a day word fixes the date).
      if (!dayWord && fireAt.getTime() <= Date.now()) {
        fireAt = sastDateTimeToUtc(new Date(nowSastMs + 86_400_000).toISOString().slice(0, 10), hh, mm);
      }
    }
  }

  // ---- 3. BODY — strip the trigger + every matched time phrase, keep the task ----
  let body = raw
    .replace(/\b(can you |could you |would you |please |pls |kindly )?(remind me|remind us|set (a |an )?reminder|give me a reminder)\b/i, " ")
    .replace(/\bfor me\b/i, " ");
  for (const rx of strip) body = body.replace(rx, " ");
  body = body
    .replace(/^[\s,.:;-]*(to|that|about|for|of)\b/i, " ")   // leading connective
    .replace(/\bplease\b|\bpls\b|\bkindly\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
    .trim();
  body = body.replace(/^to\s+/i, "").trim();
  // Drop a dangling trailing preposition left when the time phrase was cut out of the middle
  // ("weigh in on <monday>" → "weigh in on" → "weigh in").
  body = body.replace(/\s+\b(on|at|by|to|about|for|of|this|next)\b\s*$/i, "").trim();

  if (fireAt && !body) return { kind: "need_body", fireAt, recurrence };
  if (!fireAt && body) return { kind: "need_time", body };
  if (!fireAt && !body) return { kind: "need_time", body: "" };
  return { kind: "set", body: body.slice(0, 240), fireAt: fireAt!, recurrence };
}

/**
 * 19:00 SAST the EVENING BEFORE a YYYY-MM-DD return date — the moment to nudge a sick/away
 * client so they're never met with silence. Returns null if the date is malformed or the
 * evening-before is already past. Pure so the temporal loop is unit-testable.
 */
export function returnNudgeTime(dateStr: string, now: number = Date.now()): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const returnMidnight = new Date(`${dateStr}T00:00:00+02:00`); // 00:00 SAST on the return day
  const t = returnMidnight.getTime() - 5 * 3_600_000;           // minus 5h = 19:00 SAST the day before
  if (!Number.isFinite(t) || t <= now) return null;
  return new Date(t);
}

/** Human "today at 8:00pm" / "tomorrow at 7:00am" / "Mon 20 Jul at 6:00am" — SAST. */
export function describeFireTime(fireAt: Date): string {
  const sast = new Date(fireAt.getTime() + SAST_OFFSET_MS);
  const nowSast = sastNow();
  const dayDiff = Math.floor((Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate()) -
    Date.UTC(nowSast.getUTCFullYear(), nowSast.getUTCMonth(), nowSast.getUTCDate())) / 86_400_000);
  let h = sast.getUTCHours();
  const min = sast.getUTCMinutes();
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12; if (h === 0) h = 12;
  const time = `${h}:${pad(min)}${ap}`;
  if (dayDiff === 0) return `today at ${time}`;
  if (dayDiff === 1) return `tomorrow at ${time}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[sast.getUTCDay()]} ${sast.getUTCDate()} ${months[sast.getUTCMonth()]} at ${time}`;
}
