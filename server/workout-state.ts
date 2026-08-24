/**
 * Workout State Engine
 *
 * Answers: "What is the right response when this user asks for their workout today?"
 *
 * States:
 *   REST         — today is not a scheduled training day
 *   ALREADY_DONE — user completed today's session
 *   MISSED       — user has missed ≥1 scheduled sessions since last workout
 *   NORMAL       — scheduled training day, nothing done yet, no backlog
 *
 * No DB schema changes — calculated on the fly from lastWorkoutDate + TRAINING_SCHEDULES.
 */

import { db } from "./db";
import { workoutLogs } from "../shared/schema";
import { eq, and, gte } from "drizzle-orm";
import { sastDayStart } from "./utils";
import { sastDayKey, sastWeekStart } from "./sast";

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const SCHEDULE_MAP: Record<number, number[]> = {
  2: [1, 4],
  3: [1, 3, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 4, 5],
  6: [1, 2, 3, 4, 5, 6],
};

/**
 * Which slot (1-indexed) does today's calendar day represent in the training schedule?
 * e.g. Mon/Wed/Fri schedule: Monday=1, Wednesday=2, Friday=3
 * Returns user.programmeDayInWeek as fallback on non-training days.
 */
export function getTodaySlot(user: any): number {
  const sastDOW = new Date(Date.now() + 2 * 3_600_000).getDay();
  const trainingDays = Math.min(6, Math.max(2, user.trainingDaysPerWeek || 3));
  const schedDOWs = SCHEDULE_MAP[trainingDays] || SCHEDULE_MAP[3];
  const idx = schedDOWs.indexOf(sastDOW);
  if (idx === -1) return user.programmeDayInWeek || 1; // rest day — fall back
  return idx + 1; // 1-indexed
}

/**
 * A week-count claim ("I did all four this week") may become dated rows ONLY when every
 * assigned date is deterministically attributable: claimed count equals the schedule length,
 * every scheduled day of that week is already past, and none of those days already have a row.
 * Otherwise return null — the caller abstains. Never invents a Friday for a Monday.
 */
export function weekStartForTrainingClaim(message: string, now?: Date | number): Date | null {
  const t = String(message || "");
  if (/\blast\s+week\b/i.test(t)) {
    return new Date(sastWeekStart(now).getTime() - 7 * 86_400_000);
  }
  if (/\bthis\s+week\b/i.test(t)) return sastWeekStart(now);
  return null;
}

export function attributableWeekSessionDates(opts: {
  claimed: number;
  trainingDaysPerWeek: number;
  weekStart: Date;
  existingDayKeys: string[];
  now?: Date | number;
}): Date[] | null {
  const schedule = SCHEDULE_MAP[Math.min(6, Math.max(2, opts.trainingDaysPerWeek || 3))] || SCHEDULE_MAP[3];
  if (opts.claimed !== schedule.length) return null;
  if ((opts.existingDayKeys || []).length > 0) return null;
  const today = sastDayStart(opts.now).getTime();
  const dates: Date[] = [];
  for (const dow of schedule) {
    const offset = dow === 0 ? 6 : dow - 1; // Mon=1 → 0 days from weekStart
    const day = new Date(opts.weekStart.getTime() + offset * 86_400_000);
    if (day.getTime() >= today) return null;
    dates.push(day);
  }
  if (dates.length !== opts.claimed) return null;
  return dates;
}

/** SAST day keys for those dates — the write record and the existing-row check use the same key. */
export function weekSessionDayKeys(dates: Date[]): string[] {
  return dates.map(d => sastDayKey(d));
}

export type WorkoutStateType = "REST" | "NORMAL" | "MISSED" | "ALREADY_DONE";

export type WorkoutState = {
  type: WorkoutStateType;
  todayName: string;       // e.g. "Saturday"
  nextTrainingName: string; // e.g. "Monday"
  missedSessions: string[]; // named ONLY when unambiguous (last 6 days, never today)
  missedCount: number;      // total missed, including ones too old to name safely
  alreadyDoneToday: boolean;
  isTrainingDay: boolean;
};

export async function getTodayWorkoutState(user: any): Promise<WorkoutState> {
  // Resolve today's day of week in SAST (UTC+2)
  const sastMs = Date.now() + 2 * 3_600_000;
  const sastDOW = new Date(sastMs).getDay();

  const trainingDays = Math.min(6, Math.max(2, user.trainingDaysPerWeek || 3));
  const schedDOWs = SCHEDULE_MAP[trainingDays] || SCHEDULE_MAP[3];
  const isTrainingDay = schedDOWs.includes(sastDOW);

  const todayName = DOW_NAMES[sastDOW];

  // Next scheduled training day (looking forward)
  let nextDOW = sastDOW;
  for (let i = 1; i <= 7; i++) {
    const candidate = (sastDOW + i) % 7;
    if (schedDOWs.includes(candidate)) { nextDOW = candidate; break; }
  }
  const nextTrainingName = DOW_NAMES[nextDOW];

  // Has user already logged a workout today?
  let alreadyDoneToday = false;
  try {
    const todayStart = sastDayStart();
    const [existing] = await db.select({ id: workoutLogs.id }).from(workoutLogs)
      .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, todayStart)))
      .limit(1);
    alreadyDoneToday = !!existing;
  } catch { /* non-fatal */ }

  // Calculate missed sessions: scheduled training days between lastWorkoutDate and today
  // (exclusive of today, exclusive of lastWorkoutDate itself)
  // NAMES MUST BE UNAMBIGUOUS (2026-07-27 live: "You missed Thursday + Friday + Monday +
  // Tuesday. Monday is still a training day" — on a Monday. The loop ran past a full week, so
  // it named a PREVIOUS Monday, and today's own weekday appeared in the missed list.)
  // Only the last 6 days are named; anything older is counted, never named. Today's weekday is
  // never listed — it hasn't been missed while it's still happening.
  const missedSessions: string[] = [];
  let missedCount = 0;
  const lastWorkout = user.lastWorkoutDate ? new Date(user.lastWorkoutDate) : null;

  if (lastWorkout) {
    const sastLastWorkoutMs = lastWorkout.getTime() + 2 * 3_600_000;
    const daysSinceLast = Math.floor((sastMs - sastLastWorkoutMs) / 86_400_000);

    for (let d = 1; d < daysSinceLast; d++) {
      const candidateMs = lastWorkout.getTime() + d * 86_400_000;
      const dow = new Date(candidateMs + 2 * 3_600_000).getDay();
      if (!schedDOWs.includes(dow)) continue;
      missedCount++;
      const daysAgo = daysSinceLast - d;
      if (daysAgo > 6 || dow === sastDOW) continue;   // ambiguous or is today
      const name = DOW_NAMES[dow];
      if (!missedSessions.includes(name)) missedSessions.push(name);
    }
  }

  // Determine state
  let type: WorkoutStateType;
  if (!isTrainingDay) {
    type = "REST";
  } else if (alreadyDoneToday) {
    type = "ALREADY_DONE";
  } else if (missedCount > 0) {
    type = "MISSED";
  } else {
    type = "NORMAL";
  }

  return { type, todayName, nextTrainingName, missedSessions, missedCount, alreadyDoneToday, isTrainingDay };
}
