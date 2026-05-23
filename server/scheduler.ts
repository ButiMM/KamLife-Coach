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
  runStepSyncCatchup,
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
import { runWaterReminder } from "./scheduler/jobs/water";

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

  // Safe job runner — catches, logs, and alerts coach on repeated failures
  const jobFailureCounts: Record<string, number> = {};
  function safe(name: string, fn: () => Promise<void>): void {
    fn().then(() => {
      jobFailureCounts[name] = 0; // reset on success
    }).catch(async (e) => {
      jobFailureCounts[name] = (jobFailureCounts[name] || 0) + 1;
      const failures = jobFailureCounts[name];
      console.error(`[SCHEDULER] ${name} failed (x${failures}):`, e);
      // Alert coach after 2 consecutive failures on any critical job
      const criticalJobs = ["runMorningCheckin", "runEveningAccountability", "runSundayWeeklyReport", "runPhaseAdvancement", "runSubscriptionExpiryCheck"];
      if (failures >= 2 && criticalJobs.includes(name)) {
        const coachPhone = process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE;
        if (coachPhone) {
          const alertMsg = `⚠️ KamLife Scheduler Alert: "${name}" has failed ${failures} times in a row.\n\nError: ${String(e).slice(0, 200)}\n\nCheck Railway logs immediately.`;
          sendWhatsApp(`whatsapp:${coachPhone.replace(/\D/g, "")}`, alertMsg).catch(() => {});
        }
      }
    });
  }

  // ── One-time catch-up — runs on startup, self-deactivates via profileNotes flag ──
  safe("runStepSyncCatchup", runStepSyncCatchup);

  // ── Daily jobs ────────────────────────────────────────────────────────────
  cron.schedule("0 4 * * *",    () => safe("runMorningCheckin",         runMorningCheckin),           { timezone: "UTC" }); // 6am SAST
  cron.schedule("0 17 * * *",   () => safe("runEveningAccountability",  runEveningAccountability),    { timezone: "UTC" }); // 7pm SAST
  cron.schedule("2 4 * * *",    () => safe("runWeek3Intervention",      runWeek3Intervention),        { timezone: "UTC" }); // 6am SAST
  cron.schedule("0 6 * * *",    () => safe("runMilestoneCelebrations",  runMilestoneCelebrations),    { timezone: "UTC" }); // 8am SAST
  cron.schedule("0 8 * * *",    () => safe("runEarlyOnboarding",        runEarlyOnboarding),          { timezone: "UTC" }); // 10am SAST
  cron.schedule("0 9 * * *",    () => safe("runGoalReassessment",       runGoalReassessment),         { timezone: "UTC" }); // 11am SAST
  cron.schedule("5 8 * * *",    () => safe("runSubscriptionExpiryCheck",runSubscriptionExpiryCheck),  { timezone: "UTC" }); // 10am SAST
  cron.schedule("0 10 * * *",   () => safe("runPaymentFailureRecovery", runPaymentFailureRecovery),   { timezone: "UTC" }); // 12pm SAST
  cron.schedule("3 9 * * *",    () => safe("runSignupNudge",            runSignupNudge),              { timezone: "UTC" }); // 11am SAST
  cron.schedule("0 9 * * *",    () => safe("runWaterReminder",           runWaterReminder),            { timezone: "UTC" }); // 11am SAST
  cron.schedule("0 5 * * *",    () => safe("runCulturalCalendar",       runCulturalCalendar),         { timezone: "UTC" }); // 7am SAST
  cron.schedule("0 19 * * *",   () => safe("runStreakAtRisk",           runStreakAtRisk),             { timezone: "UTC" }); // 9pm SAST
  cron.schedule("0 7 * * *",    () => safe("runReferralNudge",          runReferralNudge),            { timezone: "UTC" }); // 9am SAST
  cron.schedule("0 4 * * *",    async () => {                                               // 6am SAST diet break
    try {
      const today = todaySAST();
      if (loadState()["diet_break_check"] === today) return;
      saveState("diet_break_check", today);
      await runDietBreakCheck();
    } catch (e) { console.error("[SCHEDULER] runDietBreakCheck failed:", e); }
  }, { timezone: "UTC" });
  cron.schedule("0 6 * * *",    async () => {                                               // 8am SAST supplement
    try {
      const today = todaySAST();
      if (loadState()["supplement_reminder"] === today) return;
      saveState("supplement_reminder", today);
      await runSupplementReminder();
    } catch (e) { console.error("[SCHEDULER] runSupplementReminder failed:", e); }
  }, { timezone: "UTC" });

  // ── Every 12 hours ────────────────────────────────────────────────────────
  cron.schedule("4 4,16 * * *",  () => safe("runSilenceDetection",    runSilenceDetection),    { timezone: "UTC" });
  cron.schedule("0 5,18 * * *",  () => safe("runDeepSilenceEscalation", runDeepSilenceEscalation), { timezone: "UTC" });

  // ── Hourly ────────────────────────────────────────────────────────────────
  cron.schedule("0 * * * *",     () => safe("runBuddyAccountability", runBuddyAccountability));

  // ── Weekly — Monday ───────────────────────────────────────────────────────
  cron.schedule("30 4 * * 1",    async () => {                        // 6:30am SAST weight reminder
    try {
      const today = todaySAST();
      if (hasRunToday("weight_reminder", today)) return;
      saveState("weight_reminder", today);
      await runWeightReminder();
    } catch (e) { console.error("[SCHEDULER] runWeightReminder failed:", e); }
  }, { timezone: "UTC" });
  cron.schedule("0 5 * * 1",     async () => {                        // 7am SAST progress summary
    try {
      const today = todaySAST();
      if (hasRunToday("monday_progress", today)) return;
      saveState("monday_progress", today);
      await runMondayProgress();
    } catch (e) { console.error("[SCHEDULER] runMondayProgress failed:", e); }
  }, { timezone: "UTC" });
  cron.schedule("0 5 * * 1",     () => safe("runWeeklyKpiReport",     runWeeklyKpiReport));    // 7am SAST KPI report
  cron.schedule("0 5 * * 1",     () => safe("runWomensMonth",         runWomensMonth));        // 7am SAST Women's Month (Aug only)
  cron.schedule("0 5 * * 1",     () => safe("runPhaseAdvancement",    runPhaseAdvancement));   // 7am SAST phase check
  cron.schedule("0 4 * * 1",     () => safe("runTrainingDataLog",     runTrainingDataLog));    // 6am SAST training data log
  cron.schedule("0 6 * * 1",     async () => {                        // 8am SAST grocery list
    try {
      const today = todaySAST();
      if (hasRunToday("monday_groceries", today)) return;
      saveState("monday_groceries", today);
      await runMondayGroceries();
    } catch (e) { console.error("[SCHEDULER] runMondayGroceries failed:", e); }
  }, { timezone: "UTC" });
  cron.schedule("0 6 * * 1",     () => safe("runWeeklyMondayCheckin", runWeeklyMondayCheckin)); // 8am SAST
  cron.schedule("0 7 * * 1",     () => safe("runGoalCheck",           runGoalCheck));           // 9am SAST

  // ── Weekly — Tuesday & Thursday ───────────────────────────────────────────
  cron.schedule("0 8 * * 2,4",   async () => {                        // 10am SAST comeback
    try {
      const today = todaySAST();
      if (hasRunToday("comeback_msg", today)) return;
      saveState("comeback_msg", today);
      await runComebackMessages();
    } catch (e) { console.error("[SCHEDULER] runComebackMessages failed:", e); }
  }, { timezone: "UTC" });

  // ── Weekly — Wednesday ────────────────────────────────────────────────────
  cron.schedule("0 8 * * 3",     () => safe("runInjuryFollowup",      runInjuryFollowup),      { timezone: "UTC" }); // 10am SAST

  // ── Weekly — Friday ───────────────────────────────────────────────────────
  cron.schedule("0 14 * * 5",    () => safe("runFridayWeekendStrategy", runFridayWeekendStrategy), { timezone: "UTC" }); // 4pm SAST

  // ── Weekly — Saturday ─────────────────────────────────────────────────────
  cron.schedule("0 8 * * 6",     () => safe("runNsvCheckin",          runNsvCheckin),          { timezone: "UTC" }); // 10am SAST

  // ── Weekly — Sunday ───────────────────────────────────────────────────────
  cron.schedule("0 6 * * 0",     () => safe("runSundayWeeklyReport",  runSundayWeeklyReport),  { timezone: "UTC" }); // 8am SAST
  cron.schedule("0 7 * * 0",     () => safe("runPlateauDetection",    runPlateauDetection),    { timezone: "UTC" }); // 9am SAST
  cron.schedule("0 7 * * 0",     () => safe("runComplianceLevelUpdate", runComplianceLevelUpdate), { timezone: "UTC" }); // 9am SAST
  cron.schedule("0 8 * * 0",     () => safe("runWeekendFoodAudit",    runWeekendFoodAudit),    { timezone: "UTC" }); // 10am SAST
  cron.schedule("0 8 * * 0",     async () => {                        // 10am SAST auto cal adjust
    try {
      const today = todaySAST();
      if (loadState()["auto_cal_adjust"] === today) return;
      saveState("auto_cal_adjust", today);
      await runAutoCalAdjust();
    } catch (e) { console.error("[SCHEDULER] runAutoCalAdjust failed:", e); }
  }, { timezone: "UTC" });
  cron.schedule("0 15 * * 0",    () => safe("runStepLeaderboard",    runStepLeaderboard));    // 5pm SAST
  cron.schedule("0 16 * * 0",    () => safe("runWeeklyWinsCelebration", runWeeklyWinsCelebration)); // 6pm SAST
  cron.schedule("0 17 * * 0",    () => safe("runSundayEveningCheckin",  runSundayEveningCheckin), { timezone: "UTC" }); // 7pm SAST

  // ── Monthly ───────────────────────────────────────────────────────────────
  cron.schedule("0 7 1 * *",     () => safe("runMonthlyMeasurements", runMonthlyMeasurements), { timezone: "UTC" }); // 1st 9am SAST
  cron.schedule("0 8 20 * *",    () => safe("runMonthEndBudget",      runMonthEndBudget),      { timezone: "UTC" }); // 20th 10am SAST
  cron.schedule("0 7 15,25 * *", () => safe("runPaydayShoppingNudge", runPaydayShoppingNudge), { timezone: "UTC" }); // 15th+25th
  cron.schedule("0 17 3 * *",    async () => {                        // 3rd 7pm SAST NPS
    try {
      const today = todaySAST();
      if (loadState()["nps_survey"] === today) return;
      saveState("nps_survey", today);
      await runMonthlyNps();
    } catch (e) { console.error("[SCHEDULER] runMonthlyNps failed:", e); }
  }, { timezone: "UTC" });

  // ── Annual ────────────────────────────────────────────────────────────────
  cron.schedule("0 5 2 1 *",     () => safe("runNewYearReset",        runNewYearReset),        { timezone: "UTC" }); // Jan 2

  console.log("[SCHEDULER] All cron jobs registered.");
}
