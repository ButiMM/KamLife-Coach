/**
 * Scheduler orchestrator — registers all cron jobs.
 * Business logic lives in server/scheduler/jobs/*.ts
 * Shared utilities live in server/scheduler/shared.ts
 */

import cron from "node-cron";
import { pool } from "./db";
import {
  deliveryStats, sendWhatsApp,
  loadState, saveState, todaySAST, hasRunToday,
  weeklyKeyedSent, dailySentThisProcess, dailyKey,
  escalations, sentProactive,
  db, lt, eq,
} from "./scheduler/shared";

// Job imports
import { runMorningCheckin } from "./scheduler/jobs/morning";
import { runEveningAccountability } from "./scheduler/jobs/evening";
import { runMilestoneCelebrations } from "./scheduler/jobs/milestones";
import {
  runWeek3Intervention, runSilenceDetection, runDeepSilenceEscalation,
  runComebackMessages, runBuddyAccountability, runStreakAtRisk,
} from "./scheduler/jobs/retention";
import {
  runFridayWeekendStrategy, runSundayWeeklyReport, runSundayEveningCheckin,
  runWeekendFoodAudit, runComplianceLevelUpdate, runNsvCheckin, runWeeklyWinsCelebration,
} from "./scheduler/jobs/weekly";
import {
  runPhaseAdvancement, runGoalCheck, runWeeklyMondayCheckin,
  runInjuryFollowup, runPlateauDetection,
} from "./scheduler/jobs/programme";
import {
  runEarlyOnboarding, runMonthlyMeasurements, runReferralNudge, runGoalReassessment,
} from "./scheduler/jobs/onboarding";
import {
  runCulturalCalendar, runWomensMonth, runNewYearReset,
} from "./scheduler/jobs/cultural";
import {
  runMonthEndBudget, runSubscriptionExpiryCheck, runPaymentFailureRecovery,
  runSignupNudge, runPaydayShoppingNudge, runStepLeaderboard,
  runWeeklyKpiReport, runSupplementReminder, runAutoCalAdjust, runMonthlyNps,
} from "./scheduler/jobs/business";
import {
  runWeightReminder, runMondayProgress, runMondayGroceries, runDietBreakCheck,
  runTrainingDataLog,
} from "./scheduler/jobs/monday";

// Re-export for routes.ts + index.ts consumers
export { sendWhatsApp, deliveryStats };

// ============================================================
// MIDNIGHT PURGE — clears stale in-memory dedupe entries
// ============================================================
cron.schedule("0 22 * * *", async () => {
  const today = todaySAST();
  for (const key of dailySentThisProcess.values()) {
    if (!key.startsWith(today)) dailySentThisProcess.delete(key);
  }
  for (const key of weeklyKeyedSent.keys()) {
    if (!key.startsWith(today.slice(0, 7))) weeklyKeyedSent.delete(key);
  }
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    await db.delete(sentProactive).where(lt(sentProactive.dedupeWindow as Parameters<typeof lt>[0], thirtyDaysAgo));
  } catch { /* non-fatal */ }
  console.log("[SCHEDULER] dedupe purged — daily set size:", dailySentThisProcess.size);

  // Escalation SLA check
  try {
    const overdueEscalations = await db.select({
      id: escalations.id, userId: escalations.userId,
      reason: escalations.reason, priority: escalations.priority,
    }).from(escalations).where(
      eq(escalations.status, "open") as Parameters<typeof db.select>[0]
    ).limit(20);
    if (overdueEscalations.length > 0) {
      const coachPhone = process.env.COACH_ALERT_PHONE || process.env.COACH_PHONE;
      if (coachPhone) {
        const urgentCount = overdueEscalations.filter(e => e.priority === "urgent").length;
        const highCount = overdueEscalations.filter(e => e.priority === "high").length;
        const urgentDetails = overdueEscalations.filter(e => e.priority === "urgent").map(e => `• ${e.reason} (${e.userId.slice(0, 8)})`).join("\n");
        const msg = `🚨 KamLife SLA BREACH — ${overdueEscalations.length} open escalation${overdueEscalations.length > 1 ? "s" : ""} past deadline\n\nUrgent: ${urgentCount} | High: ${highCount}\n${urgentDetails}\n\nOpen your dashboard inbox now.`;
        await sendWhatsApp(`whatsapp:${coachPhone}`, msg).catch(e => console.error("[SLA ALERT]", e));
      }
    }
  } catch (slaErr) { console.error("[SCHEDULER] SLA check failed:", slaErr); }
}, { timezone: "UTC" });

// ============================================================
// INIT
// ============================================================

let schedulerInitialised = false;

export async function initScheduler(): Promise<void> {
  if (schedulerInitialised) {
    console.log("[SCHEDULER] Already initialised — skipping duplicate registration");
    return;
  }

  try {
    const { rows } = await pool.query<{ pg_try_advisory_lock: boolean }>("SELECT pg_try_advisory_lock(8675309)");
    if (!rows[0].pg_try_advisory_lock) {
      console.log("[SCHEDULER] Another instance holds the leader lock — cron jobs skipped on this replica");
      return;
    }
    console.log("[SCHEDULER] Acquired leader lock — this replica will run all cron jobs");
  } catch (e) {
    console.warn("[SCHEDULER] Could not acquire advisory lock — starting scheduler anyway:", e);
  }

  schedulerInitialised = true;

  // ── Daily jobs ────────────────────────────────────────────────────────────
  cron.schedule("0 4 * * *",    () => runMorningCheckin(),           { timezone: "UTC" }); // 6am SAST
  cron.schedule("0 17 * * *",   () => runEveningAccountability(),    { timezone: "UTC" }); // 7pm SAST
  cron.schedule("2 4 * * *",    () => runWeek3Intervention(),        { timezone: "UTC" }); // 6am SAST
  cron.schedule("0 6 * * *",    () => runMilestoneCelebrations(),    { timezone: "UTC" }); // 8am SAST
  cron.schedule("0 8 * * *",    () => runEarlyOnboarding(),          { timezone: "UTC" }); // 10am SAST
  cron.schedule("0 9 * * *",    () => runGoalReassessment(),         { timezone: "UTC" }); // 11am SAST
  cron.schedule("5 8 * * *",    () => runSubscriptionExpiryCheck(),  { timezone: "UTC" }); // 10am SAST
  cron.schedule("0 10 * * *",   () => runPaymentFailureRecovery(),   { timezone: "UTC" }); // 12pm SAST
  cron.schedule("3 9 * * *",    () => runSignupNudge(),              { timezone: "UTC" }); // 11am SAST
  cron.schedule("0 5 * * *",    () => runCulturalCalendar(),         { timezone: "UTC" }); // 7am SAST
  cron.schedule("0 19 * * *",   () => runStreakAtRisk(),             { timezone: "UTC" }); // 9pm SAST
  cron.schedule("0 7 * * *",    () => runReferralNudge(),            { timezone: "UTC" }); // 9am SAST
  cron.schedule("0 4 * * *",    async () => {                                               // 6am SAST diet break
    const today = todaySAST();
    if (loadState()["diet_break_check"] === today) return;
    saveState("diet_break_check", today);
    await runDietBreakCheck();
  }, { timezone: "UTC" });
  cron.schedule("0 6 * * *",    async () => {                                               // 8am SAST supplement
    const today = todaySAST();
    if (loadState()["supplement_reminder"] === today) return;
    saveState("supplement_reminder", today);
    await runSupplementReminder();
  }, { timezone: "UTC" });

  // ── Every 12 hours ────────────────────────────────────────────────────────
  cron.schedule("4 4,16 * * *",  () => runSilenceDetection(),        { timezone: "UTC" });
  cron.schedule("0 5,18 * * *",  () => runDeepSilenceEscalation(),   { timezone: "UTC" });

  // ── Hourly ────────────────────────────────────────────────────────────────
  cron.schedule("0 * * * *",     () => runBuddyAccountability());

  // ── Weekly — Monday ───────────────────────────────────────────────────────
  cron.schedule("30 4 * * 1",    async () => {                        // 6:30am SAST weight reminder
    const today = todaySAST();
    if (hasRunToday("weight_reminder", today)) return;
    saveState("weight_reminder", today);
    await runWeightReminder();
  }, { timezone: "UTC" });
  cron.schedule("0 5 * * 1",     async () => {                        // 7am SAST progress summary
    const today = todaySAST();
    if (hasRunToday("monday_progress", today)) return;
    saveState("monday_progress", today);
    await runMondayProgress();
  }, { timezone: "UTC" });
  cron.schedule("0 5 * * 1",     () => runWeeklyKpiReport());         // 7am SAST KPI report to coach
  cron.schedule("0 5 * * 1",     () => runWomensMonth());             // 7am SAST Women's Month (Aug only)
  cron.schedule("0 5 * * 1",     () => runPhaseAdvancement());        // 7am SAST phase check
  cron.schedule("0 4 * * 1",     () => runTrainingDataLog());          // 6am SAST training data log
  cron.schedule("0 6 * * 1",     async () => {                        // 8am SAST grocery list
    const today = todaySAST();
    if (hasRunToday("monday_groceries", today)) return;
    saveState("monday_groceries", today);
    await runMondayGroceries();
  }, { timezone: "UTC" });
  cron.schedule("0 6 * * 1",     () => runWeeklyMondayCheckin());     // 8am SAST programme check-in
  cron.schedule("0 7 * * 1",     () => runGoalCheck());               // 9am SAST goal/programme review

  // ── Weekly — Tuesday & Thursday ───────────────────────────────────────────
  cron.schedule("0 8 * * 2,4",   async () => {                        // 10am SAST comeback
    const today = todaySAST();
    if (hasRunToday("comeback_msg", today)) return;
    saveState("comeback_msg", today);
    await runComebackMessages();
  }, { timezone: "UTC" });

  // ── Weekly — Wednesday ────────────────────────────────────────────────────
  cron.schedule("0 8 * * 3",     () => runInjuryFollowup(),           { timezone: "UTC" }); // 10am SAST

  // ── Weekly — Friday ───────────────────────────────────────────────────────
  cron.schedule("0 14 * * 5",    () => runFridayWeekendStrategy(),    { timezone: "UTC" }); // 4pm SAST

  // ── Weekly — Saturday ─────────────────────────────────────────────────────
  cron.schedule("0 8 * * 6",     () => runNsvCheckin(),               { timezone: "UTC" }); // 10am SAST

  // ── Weekly — Sunday ───────────────────────────────────────────────────────
  cron.schedule("0 6 * * 0",     () => runSundayWeeklyReport(),       { timezone: "UTC" }); // 8am SAST
  cron.schedule("0 7 * * 0",     () => runPlateauDetection(),         { timezone: "UTC" }); // 9am SAST
  cron.schedule("0 7 * * 0",     () => runComplianceLevelUpdate(),    { timezone: "UTC" }); // 9am SAST
  cron.schedule("10 7 * * 0",    () => runComplianceLevelUpdate(),    { timezone: "UTC" }); // slight offset
  cron.schedule("0 8 * * 0",     () => runWeekendFoodAudit(),         { timezone: "UTC" }); // 10am SAST
  cron.schedule("0 8 * * 0",     async () => {                        // 10am SAST auto cal adjust
    const today = todaySAST();
    if (loadState()["auto_cal_adjust"] === today) return;
    saveState("auto_cal_adjust", today);
    await runAutoCalAdjust();
  }, { timezone: "UTC" });
  cron.schedule("0 15 * * 0",    () => runStepLeaderboard());         // 5pm SAST leaderboard
  cron.schedule("0 16 * * 0",    () => runWeeklyWinsCelebration());   // 6pm SAST wins
  cron.schedule("0 17 * * 0",    () => runSundayEveningCheckin(),     { timezone: "UTC" }); // 7pm SAST

  // ── Monthly ───────────────────────────────────────────────────────────────
  cron.schedule("0 7 1 * *",     () => runMonthlyMeasurements(),      { timezone: "UTC" }); // 1st 9am SAST
  cron.schedule("0 8 20 * *",    () => runMonthEndBudget(),           { timezone: "UTC" }); // 20th 10am SAST
  cron.schedule("0 7 15,25 * *", () => runPaydayShoppingNudge(),      { timezone: "UTC" }); // 15th+25th
  cron.schedule("0 17 3 * *",    async () => {                        // 3rd 7pm SAST NPS
    const today = todaySAST();
    if (loadState()["nps_survey"] === today) return;
    saveState("nps_survey", today);
    await runMonthlyNps();
  }, { timezone: "UTC" });

  // ── Annual ────────────────────────────────────────────────────────────────
  cron.schedule("0 5 2 1 *",     () => runNewYearReset(),             { timezone: "UTC" }); // Jan 2

  console.log("[SCHEDULER] All cron jobs registered.");
}
