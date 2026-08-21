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
import { formatOneAction, dayStateFrom, decideProactive,
  type DayState, type ProactiveStateForDecision, type ProactiveProfile } from "../one-action";
import { sql } from "drizzle-orm";
import { getDayLedger } from "../day-ledger";
import { sastDayStart, sastDaysBetween, sastHour } from "../sast";
import { readHealthState } from "../health-state";

/** Is this client inside a declared sick window? Asked of the state owner, not of the text. */
const isSick = (user: any): boolean => readHealthState(user).isSick;

async function buildDecisionInputs(user: any): Promise<{ state: ProactiveStateForDecision; profile: ProactiveProfile }> {
  const dayStart = sastDayStart();
  const weekStart = new Date(dayStart.getTime() - 6 * 86_400_000);

  const [ledger, lastMeal, lastWeigh, weekSessions, todaySteps, loggedDays] = await Promise.all([
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
    // EVIDENCE SUFFICIENCY, so the reactive path is held to the same standard as the proactive
    // one (2026-08-18, verdict enforcement). This file used to hardcode both flags to false,
    // which was honest — it did not compute them — but it meant decideProactive could not be
    // applied here without downgrading every single prescription. One aggregate closes that.
    db.select({ days: sql<number>`COUNT(DISTINCT DATE(${mealLogs.loggedAt} AT TIME ZONE 'UTC' + INTERVAL '2 hours'))::int` })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, new Date(dayStart.getTime() - 6 * 86_400_000))))
      .catch(() => [{ days: 0 }]),
  ]);
  const distinctLoggedDays = Number((loggedDays as { days: number }[])[0]?.days || 0);

  const lastMealAt = lastMeal[0]?.at ? new Date(lastMeal[0].at) : null;

  // ONE PROJECTION (2026-08-18, Issue #49 step 4). This file used to map every field into DayState
  // itself, and the morning job reached DayState by a different route — so the two could disagree
  // about what "never logged" or an unset target meant, and nothing would have caught it. The
  // mapping now lives in one-action.ts beside the decision that consumes it; this file only
  // FETCHES, which is what its own header always claimed it did.
  return {
    state: {
      name: String(user?.name || "").trim().split(/\s+/)[0] || "there",
      goalType: user?.goalType || "general",
      health: { sick: isSick(user) },
      food: {
        loggedDays7d: null,
        daysSinceAnyLog: lastMealAt ? sastDaysBetween(lastMealAt) : null,
      },
      workout: { sessionsLast7d: weekSessions.length },
      steps: { avg7d: null },
      weight: {
        daysSinceWeighIn: lastWeigh[0]?.at ? sastDaysBetween(new Date(lastWeigh[0].at)) : null,
        trendUsable: false,
      },
      today: {
        kcal: ledger.kcal, protein: ledger.protein,
        steps: todaySteps[0]?.steps || 0,
        logged: !!lastMealAt && sastDaysBetween(lastMealAt) === 0,
        hour: sastHour(),
      },
      // REAL, not hardcoded false. The reactive path is now held to the same evidence standard
      // as the proactive one: below four logged days in seven an intake average is not evidence,
      // the same floor PROACTIVE_LOG_FLOOR and ADEQUATE_LOG_DAYS use.
      evidence: {
        foodSufficient: distinctLoggedDays >= 4,
        // A trend needs a recent number. One weigh-in inside the last three days is the same
        // recency the proactive downgrade uses before it asks for another.
        weightSufficient: lastWeigh[0]?.at ? sastDaysBetween(new Date(lastWeigh[0].at)) < 3 : false,
      },
    },
    profile: {
      dreamGoal: user?.dreamGoal,
      biggestStruggle: user?.biggestStruggle,
      weeksOnProgramme: user?.createdAt ? Math.floor(sastDaysBetween(new Date(user.createdAt)) / 7) : 0,
      sessionsTarget: Number(user?.trainingDaysPerWeek) || 3,
      calorieTarget: Number(user?.calorieTarget) || 0,
      proteinTarget: Number(user?.proteinTarget) || 0,
      stepsTarget: Number(user?.stepsTarget) || 0,
    },
  };
}

/** DayState for callers that want the raw projection rather than a gated decision. */
export async function buildDayState(user: any): Promise<DayState> {
  const { state, profile } = await buildDecisionInputs(user);
  return dayStateFrom(state, profile);
}

/**
 * `atKeyboard` — set it when this goes out as a REPLY to something the client just sent, so the
 * decision does not ask an obviously-present person to come back. Leave it off for proactive
 * sends (the morning message), where they genuinely are not here.
 */
export async function oneActionCommand(user: any, opts?: { atKeyboard?: boolean }): Promise<string> {
  const firstName = String(user?.name || "").trim().split(/\s+/)[0] || undefined;
  try {
    // THROUGH THE GATED DECISION (2026-08-18, verdict enforcement). This called chooseAction
    // directly, so the reactive one-action reply could prescribe on evidence the proactive path
    // would have refused to prescribe on — the same client, the same ledgers, two standards
    // depending on who spoke first. decideProactive applies the verdict, and its downgrade turns
    // an unjustifiable prescription into the measurement that would justify it.
    const { state, profile } = await buildDecisionInputs(user);
    const decision = decideProactive(state, profile, { atKeyboard: !!opts?.atKeyboard });
    return formatOneAction(decision.action, firstName);
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
