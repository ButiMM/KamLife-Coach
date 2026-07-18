/**
 * THE "5 WINNING DAYS" GATE — the operational definition, as code (increment 5b).
 *
 * The reviewers were right: "5 winning days" was a vibe, not a procedure — and a vague
 * gate is an arbitrary gate. This file makes the decision explicit, deterministic, and
 * unit-tested, so flipping ENGINE_ACTIONS=on is a fact the data proves, not a judgement
 * call someone makes on a Friday.
 *
 * THE DEFINITION (precise, on purpose):
 *   • A "day" is a South-African calendar date (SAST = UTC+2, no DST). KamLife is an SA
 *     product; the client's midnight is the one that counts.
 *   • A "winning day" is a SAST date whose best qualifying replay run PASSED the bar
 *     (≥20 samples, ≥90% match, ≤2% false writes, ≤10% missed — from action-score.ts).
 *   • We keep the BEST run per date (a bad re-run can't erase a good one; a good re-run
 *     can rescue a bad one — the day's true best is what stands).
 *   • The streak is CONSECUTIVE winning dates. A recorded LOSING day resets it to zero.
 *     A quiet day with no run is not a loss — you can't win a day you didn't play, but
 *     you don't lose it either; gaps don't punish, losses do.
 *   • The gate OPENS at 5 winning dates AND ≥100 total samples across them AND a
 *     window-aggregate false-write rate ≤2%. The sample floor stops five thin runs from
 *     letting it through; the window false-rate is the "let the data overrule the
 *     calendar" guard — the dangerous error stays capped across the whole run, not just
 *     per-day.
 *
 * Pure + dependency-free so the gate logic is provable in the harness. Persistence
 * (the SAST day-log in scheduler_state) lives in action-replay.ts.
 */

export const GATE_STREAK = 5;
export const GATE_MIN_TOTAL_SAMPLES = 100;
export const GATE_MAX_WINDOW_FALSE_RATE = 0.02;

export interface DayResult {
  day: string;        // SAST calendar date, YYYY-MM-DD
  passed: boolean;    // did the best qualifying run that day clear the WIN bar?
  n: number;          // samples in that best run
  matchRate: number;
  missRate: number;
  falseRate: number;
}

export interface RunSummary {
  passed: boolean;
  n: number;
  matchRate: number;
  missRate: number;
  falseRate: number;
}

/** SAST (UTC+2, fixed — South Africa has no daylight saving) calendar date for an instant. */
export function sastDay(at: Date): string {
  return new Date(at.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
}

/** Is run A a better representative of its day than run B? Higher match wins; on a tie,
 *  the lower false-write rate wins (the dangerous error is the tie-breaker). */
function betterRun(a: RunSummary, b: RunSummary): boolean {
  if (a.matchRate !== b.matchRate) return a.matchRate > b.matchRate;
  return a.falseRate < b.falseRate;
}

/** Fold a fresh run into the day-log, keeping the best run per SAST date. Returns a new,
 *  date-sorted, ring-buffered list (last 60 days) — never mutates the input. */
export function recordRun(days: DayResult[], run: RunSummary, at: Date): DayResult[] {
  const day = sastDay(at);
  const asDay: DayResult = { day, passed: run.passed, n: run.n, matchRate: run.matchRate, missRate: run.missRate, falseRate: run.falseRate };
  const map = new Map<string, DayResult>();
  for (const d of days) map.set(d.day, d);
  const existing = map.get(day);
  if (!existing || betterRun(run, existing)) map.set(day, asDay);
  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day)).slice(-60);
}

export interface GateVerdict {
  open: boolean;
  streak: number;          // consecutive most-recent winning days
  windowSamples: number;   // total samples across the winning streak
  windowFalseRate: number; // aggregate false-write rate across the winning streak
  reason: string;
}

/** THE GATE. Pure decision over the day-log — the only thing that says "flip it". */
export function evaluateGate(days: DayResult[]): GateVerdict {
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  // Walk backwards: count consecutive winning days; a recorded loss stops the streak.
  const streakDays: DayResult[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].passed) streakDays.push(sorted[i]);
    else break;
  }
  const streak = streakDays.length;
  const windowSamples = streakDays.reduce((s, d) => s + d.n, 0);
  // Sample-weighted aggregate false rate across the winning window.
  const falseCount = streakDays.reduce((s, d) => s + d.falseRate * d.n, 0);
  const windowFalseRate = windowSamples ? falseCount / windowSamples : 0;

  const open = streak >= GATE_STREAK
    && windowSamples >= GATE_MIN_TOTAL_SAMPLES
    && windowFalseRate <= GATE_MAX_WINDOW_FALSE_RATE;

  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  let reason: string;
  if (open) {
    const span = `${streakDays[streakDays.length - 1].day} → ${streakDays[0].day}`;
    reason = `GATE OPEN — ${streak} winning days (${span}), ${windowSamples} samples, ${pct(windowFalseRate)} false writes. Safe to flip ENGINE_ACTIONS=on.`;
  } else if (streak < GATE_STREAK) {
    reason = `Not yet — ${streak}/${GATE_STREAK} consecutive winning days.`;
  } else if (windowSamples < GATE_MIN_TOTAL_SAMPLES) {
    reason = `${streak} winning days, but only ${windowSamples}/${GATE_MIN_TOTAL_SAMPLES} samples — need more volume before trusting it.`;
  } else {
    reason = `${streak} winning days, but window false-write rate ${pct(windowFalseRate)} exceeds the ${pct(GATE_MAX_WINDOW_FALSE_RATE)} cap — the dangerous error isn't rare enough yet.`;
  }
  return { open, streak, windowSamples, windowFalseRate, reason };
}
