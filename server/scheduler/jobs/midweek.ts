/**
 * Mid-week intelligence jobs — proactive interventions that fire when the data
 * shows the client is falling behind, without waiting for them to ask.
 *
 * runMidweekSessionCheck  — Wednesday 2pm SAST
 *   Fires when a client has logged 0 sessions so far this week on a week
 *   where they have planned training days remaining. This is the single
 *   highest-leverage intervention: catching a zero-session week on Wednesday
 *   rather than reporting it on Sunday.
 *
 * runProteinStreakIntervention — Thursday 7am SAST
 *   Fires when protein has been below 50% of target for 4+ consecutive days.
 *   A one-day miss is noise. Four days is a pattern the coach needs to break.
 */

import {
  db, users, workoutLogs, mealLogs, chatHistory,
  eq, gte, and, sql,
  sendWhatsApp, claimDailySlot, canSendProactive,
  getActiveClients, isPaused, dayStart,
  TRAINING_SCHEDULES, claimProactive, thisWeekUTC,
} from "../shared";

// ── Helpers ──────────────────────────────────────────────────────────────────

function weekStartSAST(): Date {
  // Monday 00:00 SAST of current ISO week
  const now = new Date(Date.now() + 2 * 3_600_000); // shift to SAST
  const dow = now.getUTCDay(); // 0=Sun … 6=Sat
  const daysToMon = (dow === 0 ? 6 : dow - 1);
  const monMidnightSAST = new Date(now);
  monMidnightSAST.setUTCHours(0, 0, 0, 0);
  monMidnightSAST.setUTCDate(monMidnightSAST.getUTCDate() - daysToMon);
  // Convert back to UTC
  return new Date(monMidnightSAST.getTime() - 2 * 3_600_000);
}

function plannedSessionsSoFar(trainingDaysPerWeek: number): number {
  // How many sessions were scheduled on Mon/Tue/Wed of this week
  const schedule = TRAINING_SCHEDULES[trainingDaysPerWeek] || TRAINING_SCHEDULES[3];
  const nowDOW = new Date(Date.now() + 2 * 3_600_000).getUTCDay(); // SAST day
  // Days already elapsed this week (Mon=1 through Wed=3 when this job runs)
  const elapsed: number[] = [];
  for (let d = 1; d <= Math.min(nowDOW, 3); d++) elapsed.push(d);
  return elapsed.filter(d => schedule.includes(d)).length;
}

// ── Wednesday: zero-session intervention ─────────────────────────────────────

export async function runMidweekSessionCheck(): Promise<void> {
  console.log("[SCHEDULER] JOB: Mid-week session check");
  const weekStart = weekStartSAST();
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    const daysSilent = client.lastActiveAt
      ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
      : 999; // null = never interacted; comeback job owns these, not midweek check
    // Skip clients already caught by the 3+ day silence re-engagement flow
    if (daysSilent > 4) continue;

    try {
      const trainingDays = client.trainingDaysPerWeek || 3;
      const scheduled = plannedSessionsSoFar(trainingDays);
      if (scheduled === 0) continue; // no training day has passed yet this week

      const [{ count }] = await db.select({
        count: sql<number>`COUNT(*)::int`,
      }).from(workoutLogs)
        .where(and(
          eq(workoutLogs.userId, client.id),
          gte(workoutLogs.loggedAt, weekStart),
        ));

      if (count > 0) continue; // already trained this week — no intervention needed

      if (!await claimDailySlot(client.id, "midweek_session")) continue;

      const name = (client.name || "there").split(" ")[0];
      const remaining = trainingDays - scheduled;
      const msg = [
        `${name}, Wednesday. Halfway through the week.`,
        `Zero sessions logged so far — but you still have ${remaining} training day${remaining > 1 ? "s" : ""} left before Sunday.`,
        `The week is not lost. Reply *1* right now and do today's workout.`,
        `20 minutes changes this whole week.`,
      ].join(" ");

      await sendWhatsApp(client.phoneNumber, msg);
      console.log(`[MIDWEEK] Sent zero-session intervention to ${client.phoneNumber}`);
    } catch (err) {
      console.error(`[MIDWEEK] Session check error — ${client.phoneNumber}:`, err);
    }
  }
}

// ── Wednesday evening: weekly sleep question ─────────────────────────────────
// Sleep deprivation raises ghrelin (hunger hormone) by ~28% and kills training
// recovery. One question per week builds sleep awareness.

export async function runWednesdaySleepQuestion(): Promise<void> {
  console.log("[SCHEDULER] JOB: Wednesday sleep question");
  const clients = await getActiveClients();
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
  let sent = 0;

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const daysSilent = client.lastActiveAt
        ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
        : 999;
      if (daysSilent > 7) continue;
      if (!canSendProactive(client.id)) continue;
      if (!await claimDailySlot(client.id, "sleep_question")) continue;

      const name = (client.name || "there").split(" ")[0];
      await sendWhatsApp(
        client.phoneNumber,
        `${name}, quick mid-week check — how many hours did you sleep last night?\n\nSleep is when your body actually builds the muscle and burns the fat. Less than 7 hours and hunger hormones spike, recovery stalls, and your training output drops. Just reply with a number — no judgement.`,
      );
      sent++;
    } catch (err) { console.error(`[MIDWEEK] Sleep question error — ${client.phoneNumber}:`, err); }
  }
  console.log(`[MIDWEEK] Sleep questions sent: ${sent}`);
}

// ── Weekly FEELINGS check-in (2026-07-14) — the proactive door to emotional support.
// Kam's manual clients stay for the accountability + being asked how they ACTUALLY
// feel. This reaches out once a week, before they spiral — not about the numbers, about
// THEM. When they open up, the deep-emotional-support path (agents.ts, deep mode) catches
// the reply. Catch them before Sunday's report, not after they've already quit.
// ─────────────────────────────────────────────────────────────────────────────────────

const FEELINGS_PROMPTS: Array<(name: string) => string> = [
  (name) => `${name}, quick one — and forget the numbers for a second. How are you actually *feeling* about all this this week? Good, tired, frustrated, proud — be honest with me. I'm not just here for the food and the sessions; if something's weighing on you, I want to hear it. 💛`,
  (name) => `${name}, real talk — how's your head this week, not your body? Some weeks are heavy. If you're feeling low, stuck, or even like giving up, tell me. That's exactly when I'm most useful. No judgement, ever.`,
  (name) => `${name}, checking in on *you*, not your stats. How are you doing this week — honestly? Whatever it is, you can tell me. We figure it out together, always.`,
  (name) => `${name}, one honest question: what's the hardest part for you right now? Not the workouts — the *real* thing. Talk to me. Getting it out of your head is half the battle, and you're not carrying it alone.`,
];

export async function runWeeklyFeelingsCheckin(): Promise<void> {
  console.log("[SCHEDULER] JOB: Weekly feelings check-in");
  const clients = await getActiveClients();
  let sent = 0;

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      // Reach clients who are still engaged (the comeback/re-engagement flow owns the
      // long-silent), and not brand-new (they just met us at onboarding).
      const daysSilent = client.lastActiveAt
        ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
        : 999;
      if (daysSilent > 14) continue;
      const daysSinceJoin = client.createdAt
        ? Math.floor((Date.now() - new Date(client.createdAt).getTime()) / 86_400_000)
        : 999;
      if (daysSinceJoin < 3) continue;
      if (!canSendProactive(client.id)) continue;
      // Once per week per client — DB-backed so a restart can't re-send.
      if (!(await claimProactive(client.id, "feelings_checkin", thisWeekUTC()))) continue;

      const name = (client.name || "there").split(" ")[0];
      const prompt = FEELINGS_PROMPTS[sent % FEELINGS_PROMPTS.length](name);
      if (await claimDailySlot(client.id, "feelings_checkin")) {
        await sendWhatsApp(client.phoneNumber, prompt);
        sent++;
      }
    } catch (err) { console.error(`[MIDWEEK] Feelings check-in error — ${client.phoneNumber}:`, err); }
  }
  console.log(`[MIDWEEK] Feelings check-ins sent: ${sent}`);
}

// ── Thursday: protein pattern intervention ────────────────────────────────────

export async function runProteinStreakIntervention(): Promise<void> {
  console.log("[SCHEDULER] JOB: Protein streak intervention");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    const daysSilent = client.lastActiveAt
      ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
      : 0;
    if (daysSilent > 4) continue;

    try {
      const proteinTarget = client.proteinTarget || 120;
      // Query daily protein totals for the last 5 days
      const fiveDaysAgo = dayStart(-4); // 5-day window: -4 through today
      const dailyProt = await db.select({
        day: sql<string>`DATE(${mealLogs.loggedAt} AT TIME ZONE 'Africa/Johannesburg')`,
        total: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
      }).from(mealLogs)
        .where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, fiveDaysAgo)))
        .groupBy(sql`DATE(${mealLogs.loggedAt} AT TIME ZONE 'Africa/Johannesburg')`);

      // Need at least 4 days of data to detect a pattern
      if (dailyProt.length < 4) continue;

      const lowDays = dailyProt.filter(d => d.total < proteinTarget * 0.5 && d.total > 0);
      if (lowDays.length < 4) continue;

      // All 4+ qualifying days must be consecutive (no gaps above threshold in between)
      const sortedDays = [...dailyProt].sort((a, b) => a.day.localeCompare(b.day));
      let consecutiveLow = 0;
      for (const d of sortedDays) {
        if (d.total > 0 && d.total < proteinTarget * 0.5) {
          consecutiveLow++;
        } else if (d.total >= proteinTarget * 0.5) {
          consecutiveLow = 0; // reset on a good day
        }
        // skip days with zero (not logged — don't reset the streak)
      }
      if (consecutiveLow < 4) continue;

      if (!await claimDailySlot(client.id, "protein_streak")) continue;

      const name = (client.name || "there").split(" ")[0];
      const avgLow = Math.round(lowDays.reduce((s, d) => s + d.total, 0) / lowDays.length);
      const gap = proteinTarget - avgLow;
      const msg = [
        `${name}, your protein has been under ${Math.round(proteinTarget * 0.5)}g for ${consecutiveLow} days straight.`,
        `That's not a bad day — it's a pattern. At ${avgLow}g avg you're ${gap}g short of your ${proteinTarget}g target every single day.`,
        `Today: every meal needs a protein anchor. Breakfast first — reply with what you're having right now and I'll confirm it.`,
      ].join(" ");

      await sendWhatsApp(client.phoneNumber, msg);
      console.log(`[MIDWEEK] Sent protein streak intervention to ${client.phoneNumber}`);
    } catch (err) {
      console.error(`[MIDWEEK] Protein check error — ${client.phoneNumber}:`, err);
    }
  }
}
