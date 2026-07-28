/**
 * COACH COMMAND "outcomes" — does this product actually change anyone?
 *
 * (2026-07-28.) The founder holds a phone, not a shell, so the most important number in the
 * company has to be one text message away. Send *outcomes* and get the honest answer; send
 * *outcomes 4* to ask at four weeks instead of eight.
 *
 * NO NEW TABLE, deliberately. The reviewer's spec called for a `cohort_outcomes` table written
 * by a weekly job. Nothing here ages out — weigh-ins, meal logs and signups are all permanent —
 * so a stored snapshot would be denormalisation for speed, not correctness, and it would add a
 * migration and a staleness class of bug for no gain at this scale. Computed live from the
 * source rows, which also means the number can never silently drift from the truth.
 */

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { users, weightLogs, mealLogs, workoutLogs } from "../../shared/schema";
import { formatOutcomesReport, type ClientOutcome } from "../outcomes";
import { sastDayKey, sastDaysBetween } from "../sast";

/**
 * The four aggregate queries, separated from execution so a test can RENDER them without a
 * database (2026-07-28 — this shipped broken for one commit and only the founder found it).
 *
 * The bug: `sql\`${weightLogs.userId} = ANY(${ids})\``. A raw JS array inside a sql template is
 * not a single bound parameter — drizzle flattens arrays into SQL chunks, so it built nonsense
 * and every call threw. `inArray` is the house pattern, the compiler checks it, and the test
 * below now renders all four to real SQL so a malformed query can never ship silently again.
 */
export function outcomesQueries(database: typeof db, ids: string[]) {
  return [
    database.select({ userId: weightLogs.userId, weight: weightLogs.weight, at: weightLogs.loggedAt })
      .from(weightLogs).where(inArray(weightLogs.userId, ids)),
    database.select({
      userId: mealLogs.userId,
      days: sql<number>`COUNT(DISTINCT (${mealLogs.loggedAt} + interval '2 hours')::date)::int`,
    }).from(mealLogs).where(inArray(mealLogs.userId, ids)).groupBy(mealLogs.userId),
    database.select({ userId: workoutLogs.userId, n: sql<number>`COUNT(*)::int` })
      .from(workoutLogs).where(inArray(workoutLogs.userId, ids)).groupBy(workoutLogs.userId),
    database.select({ code: users.referredBy, n: sql<number>`COUNT(*)::int` })
      .from(users).where(isNotNull(users.referredBy)).groupBy(users.referredBy),
  ] as const;
}

/** Build one ClientOutcome per real, onboarded client. */
export async function gatherOutcomes(): Promise<ClientOutcome[]> {
  const clients = await db
    .select({
      id: users.id, goalType: users.goalType, createdAt: users.createdAt,
      referralCode: users.referralCode, totalWorkoutsCompleted: users.totalWorkoutsCompleted,
    })
    .from(users)
    .where(and(eq(users.onboardingState, "COMPLETE"), isNotNull(users.createdAt)));

  if (clients.length === 0) return [];
  const ids = clients.map(c => c.id);

  const [weights, foods, sessions, referrals] = await Promise.all(outcomesQueries(db, ids));

  const foodDays = new Map(foods.map(r => [r.userId, r.days || 0]));
  const sessionCount = new Map(sessions.map(r => [r.userId, r.n]));
  const referralCount = new Map(referrals.filter(r => r.code).map(r => [r.code as string, r.n]));

  // Weigh-ins, oldest first per client — first is the baseline, last is where they are now.
  const byUser = new Map<string, Array<{ kg: number; at: number }>>();
  for (const w of weights) {
    const kg = parseFloat(String(w.weight));
    if (!Number.isFinite(kg) || !w.at) continue;
    const list = byUser.get(w.userId) || [];
    list.push({ kg, at: new Date(w.at).getTime() });
    byUser.set(w.userId, list);
  }
  for (const list of byUser.values()) list.sort((a, b) => a.at - b.at);

  return clients.map(c => {
    const ws = byUser.get(c.id) || [];
    return {
      userId: c.id,
      signupDay: sastDayKey(new Date(c.createdAt!)),
      goal: (c.goalType as any) || "general",
      // Whole weeks, floored — a client on day 55 has completed 7 weeks, not 8.
      weeksOnProgramme: Math.floor(sastDaysBetween(new Date(c.createdAt!)) / 7),
      startWeightKg: ws[0]?.kg,
      latestWeightKg: ws[ws.length - 1]?.kg,
      weighIns: ws.length,
      foodLogDays: foodDays.get(c.id) || 0,
      sessions: sessionCount.get(c.id) ?? (c.totalWorkoutsCompleted || 0),
      referrals: c.referralCode ? (referralCount.get(c.referralCode) || 0) : 0,
    };
  });
}

export async function outcomesCommand(message: string): Promise<string> {
  const asked = parseInt((message.match(/\b(\d{1,2})\b/) || [])[1] || "8", 10);
  const atWeeks = Math.max(1, Math.min(52, asked));
  try {
    return formatOutcomesReport(await gatherOutcomes(), atWeeks);
  } catch (e: any) {
    // SHOW THE REASON. This is a coach-only command, and "try again in a moment" told the founder
    // nothing while the real error sat in a Railway log he was never going to read. A diagnostic
    // command that hides its own diagnosis is worse than no command.
    const why = String(e?.message || e).slice(0, 200);
    console.error("[OUTCOMES]", e);
    return `⚠️ *Outcomes failed.*\n\n\`${why}\`\n\nThat's a bug on my side, not your data. Send this to Claude.`;
  }
}
