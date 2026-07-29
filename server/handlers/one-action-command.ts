/**
 * THE ONE ACTION, wired to a real client.
 *
 * (2026-07-28.) Gathers today's state and hands it to the pure decision in server/one-action.ts.
 * The decision lives there so it can be unit-tested against every shape of day; this file only
 * fetches, and it fetches nothing the decision does not use.
 *
 * Fail-open with a REAL fallback, not a shrug: if a query dies the client still gets a usable
 * instruction rather than "something went wrong". The whole point of this message is that a tired
 * person opens it and knows what to do — an error message fails that worse than a generic answer.
 */

import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../db";
import { mealLogs, weightLogs, workoutLogs, stepLogs } from "../../shared/schema";
import { chooseAction, formatOneAction, type DayState } from "../one-action";
import { getDayLedger } from "../day-ledger";
import { sastDayStart, sastDaysBetween, sastHour } from "../sast";

/** Is this client inside a declared sick window? Stored as a profileNotes token. */
function isSick(user: any): boolean {
  const m = (user?.profileNotes || "").match(/sick_until:(\d{4}-\d{2}-\d{2})/);
  if (!m) return false;
  return new Date(`${m[1]}T23:59:59+02:00`).getTime() >= Date.now();
}

export async function buildDayState(user: any): Promise<DayState> {
  const dayStart = sastDayStart();
  const weekStart = new Date(dayStart.getTime() - 6 * 86_400_000);

  const [ledger, lastMeal, lastWeigh, weekSessions, todaySteps] = await Promise.all([
    getDayLedger(user.id, { user }),
    db.select({ at: mealLogs.loggedAt }).from(mealLogs)
      .where(eq(mealLogs.userId, user.id)).orderBy(desc(mealLogs.loggedAt)).limit(1),
    db.select({ at: weightLogs.loggedAt }).from(weightLogs)
      .where(eq(weightLogs.userId, user.id)).orderBy(desc(weightLogs.loggedAt)).limit(1),
    db.select({ at: workoutLogs.loggedAt }).from(workoutLogs)
      .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, weekStart))),
    db.select({ steps: stepLogs.steps }).from(stepLogs)
      .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, dayStart)))
      .orderBy(desc(stepLogs.loggedAt)).limit(1),
  ]);

  const calTarget = Number(user?.calorieTarget) || 0;
  const protTarget = Number(user?.proteinTarget) || 0;
  const lastMealAt = lastMeal[0]?.at ? new Date(lastMeal[0].at) : null;

  return {
    firstName: String(user?.name || "").trim().split(/\s+/)[0] || undefined,
    goal: (user?.goalType as any) || "general",
    dreamGoal: user?.dreamGoal,
    biggestStruggle: user?.biggestStruggle,
    weeksOnProgramme: user?.createdAt ? Math.floor(sastDaysBetween(new Date(user.createdAt)) / 7) : 0,
    // No log ever = treat as a long silence, which routes them to "come back" rather than to a
    // protein tip about a day that does not exist.
    daysSinceAnyLog: lastMealAt ? sastDaysBetween(lastMealAt) : 99,
    daysSinceWeighIn: lastWeigh[0]?.at ? sastDaysBetween(new Date(lastWeigh[0].at)) : null,
    loggedToday: !!lastMealAt && sastDaysBetween(lastMealAt) === 0,
    proteinPct: protTarget > 0 ? ledger.protein / protTarget : 1,
    caloriePct: calTarget > 0 ? ledger.kcal / calTarget : 1,
    sessionsThisWeek: weekSessions.length,
    sessionsTarget: Number(user?.trainingDaysPerWeek) || 3,
    stepsToday: todaySteps[0]?.steps || 0,
    stepsTarget: Number(user?.stepsTarget) || 0,
    sick: isSick(user),
    hour: sastHour(),
  };
}

/**
 * `atKeyboard` — set it when this goes out as a REPLY to something the client just sent, so the
 * decision does not ask an obviously-present person to come back. Leave it off for proactive
 * sends (the morning message), where they genuinely are not here.
 */
export async function oneActionCommand(user: any, opts?: { atKeyboard?: boolean }): Promise<string> {
  const firstName = String(user?.name || "").trim().split(/\s+/)[0] || undefined;
  try {
    return formatOneAction(chooseAction({ ...await buildDayState(user), atKeyboard: !!opts?.atKeyboard }), firstName);
  } catch (e: any) {
    console.error("[ONE_ACTION]", e?.message || e);
    // A real instruction, not an apology. Protein is the safest single action for every goal we
    // support, so a failed lookup still leaves the client with something worth doing.
    return formatOneAction({
      kind: "protein",
      todo: "Make your next meal a proper protein meal.",
      why: "It's the one thing that moves the needle whichever way you're going.",
    }, firstName);
  }
}
