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

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const SCHEDULE_MAP: Record<number, number[]> = {
  2: [1, 4],
  3: [1, 3, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 4, 5],
  6: [1, 2, 3, 4, 5, 6],
};

export type WorkoutStateType = "REST" | "NORMAL" | "MISSED" | "ALREADY_DONE";

export type WorkoutState = {
  type: WorkoutStateType;
  todayName: string;       // e.g. "Saturday"
  nextTrainingName: string; // e.g. "Monday"
  missedSessions: string[]; // e.g. ["Wednesday", "Friday"]
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
  const missedSessions: string[] = [];
  const lastWorkout = user.lastWorkoutDate ? new Date(user.lastWorkoutDate) : null;

  if (lastWorkout) {
    const sastLastWorkoutMs = lastWorkout.getTime() + 2 * 3_600_000;
    const daysSinceLast = Math.floor((sastMs - sastLastWorkoutMs) / 86_400_000);

    for (let d = 1; d < daysSinceLast; d++) {
      const candidateMs = lastWorkout.getTime() + d * 86_400_000;
      const dow = new Date(candidateMs + 2 * 3_600_000).getDay();
      if (schedDOWs.includes(dow)) {
        const name = DOW_NAMES[dow];
        if (!missedSessions.includes(name)) missedSessions.push(name);
      }
    }
  }

  // Determine state
  let type: WorkoutStateType;
  if (!isTrainingDay) {
    type = "REST";
  } else if (alreadyDoneToday) {
    type = "ALREADY_DONE";
  } else if (missedSessions.length > 0) {
    type = "MISSED";
  } else {
    type = "NORMAL";
  }

  return { type, todayName, nextTrainingName, missedSessions, alreadyDoneToday, isTrainingDay };
}
