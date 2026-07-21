/**
 * Scheduler orchestrator — registers all cron jobs.
 * Business logic lives in server/scheduler/jobs/*.ts
 * Shared utilities live in server/scheduler/shared.ts
 */

import cron from "node-cron";
import { pool } from "./db";
import {
  deliveryStats, sendWhatsApp, sendWhatsAppTemplate,
  loadState, saveState, todaySAST, hasRunToday,
  weeklyKeyedSent, dailyProactiveCount, recordJobRun,
  hydrateSchedulerStateFromDb,
  escalations, sentProactive, processedWebhooks,
  db, lt, eq, lte, and, sql,
} from "./scheduler/shared";

// Job imports
import { runMorningCheckin } from "./scheduler/jobs/morning";
import { runEveningAccountability } from "./scheduler/jobs/evening";
import { runMilestoneCelebrations } from "./scheduler/jobs/milestones";
import {
  runWeek3Intervention, runSilenceDetection, runDeepSilenceEscalation,
  runComebackMessages, runBuddyAccountability, runStreakAtRisk,
  runPausedClientLite, runWeightStallIntervention,
} from "./scheduler/jobs/retention";
import {
  runFridayWeekendStrategy, runSundayWeeklyReport, runSundayEveningCheckin,
  runWeekendFoodAudit, runComplianceLevelUpdate, runNsvCheckin,
  runSundayMealPlan,
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
  runStepTargetAdaptation,
} from "./scheduler/jobs/business";
import {
  runWeightReminder, runMondayProgress, runMondayGroceries, runDietBreakCheck,
  runTrainingDataLog,
} from "./scheduler/jobs/monday";
import { runWaterReminder } from "./scheduler/jobs/water";
import { runMidweekSessionCheck, runProteinStreakIntervention, runWednesdaySleepQuestion, runWeeklyFeelingsCheckin } from "./scheduler/jobs/midweek";
import { runCipUpdate } from "./scheduler/jobs/cip-update";
import { runMonthlyNarrative } from "./scheduler/jobs/narrative";
import { runComebackProtocol } from "./scheduler/jobs/comeback";
import { runQualityAudit } from "./scheduler/jobs/quality-audit";
import { runDrillNightly } from "./scheduler/jobs/drill-nightly";
import { runSpendWatchdog } from "./scheduler/jobs/spend-watchdog";
import { runTrialCountdown } from "./scheduler/jobs/trial";
import { runBalanceCheck } from "./scheduler/jobs/balance-check";
import { runMonthlyPhotoCheckin } from "./scheduler/jobs/progress-photo";
import { runDueReminders } from "./scheduler/jobs/reminders";
import { runMediaJobRecovery } from "./scheduler/jobs/media-recovery";

// Re-export for routes.ts + index.ts consumers
export { sendWhatsApp, sendWhatsAppTemplate, deliveryStats };

// ============================================================
// MIDNIGHT PURGE — clears stale in-memory dedupe entries
// ============================================================
cron.schedule("0 22 * * *", async () => {
  const today = todaySAST();
  for (const key of dailyProactiveCount.keys()) {
    if (!key.startsWith(today)) dailyProactiveCount.delete(key);
  }
  for (const key of weeklyKeyedSent.keys()) {
    if (!key.startsWith(today.slice(0, 7))) weeklyKeyedSent.delete(key);
  }
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    await db.delete(sentProactive).where(lt(sentProactive.dedupeWindow as Parameters<typeof lt>[0], thirtyDaysAgo));
  } catch { /* non-fatal */ }
  try {
    const oneDayAgo = new Date(Date.now() - 86_400_000);
    await db.delete(processedWebhooks).where(lt(processedWebhooks.processedAt, oneDayAgo));
  } catch { /* non-fatal */ }
  console.log("[SCHEDULER] dedupe purged — daily budget entries:", dailyProactiveCount.size);
}, { timezone: "UTC" });

// ============================================================
// DAILY SLA DIGEST — backlog nudge at 07:00 SAST (05:00 UTC)
// ============================================================
// Moved OFF midnight (2026-07-12, Kam: a "Urgent: 0 | High: 1" alert woke him at
// 00:00). Urgent items already page every 30 min via the URGENT SLA MONITOR, so
// this digest is just a morning backlog nudge — and it stays silent unless there
// is genuinely something to chase, never over a single already-known item.
cron.schedule("0 5 * * *", async () => {
  try {
    const now = new Date();
    const overdueEscalations = await db.select({
      id: escalations.id, userId: escalations.userId,
      reason: escalations.reason, priority: escalations.priority,
      slaDeadline: escalations.slaDeadline,
    }).from(escalations).where(
      and(
        eq(escalations.status, "open"),
        lte(escalations.slaDeadline, now),
      )
    ).limit(20);
    if (overdueEscalations.length > 0) {
      const coachPhone = process.env.COACH_ALERT_PHONE || process.env.COACH_PHONE;
      if (coachPhone) {
        const urgentCount = overdueEscalations.filter(e => e.priority === "urgent").length;
        const highCount = overdueEscalations.filter(e => e.priority === "high").length;
        const urgentDetails = overdueEscalations.filter(e => e.priority === "urgent").map(e => `• ${e.reason} (${e.userId.slice(0, 8)})`).join("\n");
        const header = urgentCount > 0
          ? `🚨 KamLife SLA BREACH — ${overdueEscalations.length} open escalation${overdueEscalations.length > 1 ? "s" : ""} past deadline`
          : `📋 KamLife morning inbox — ${overdueEscalations.length} escalation${overdueEscalations.length > 1 ? "s" : ""} to clear`;
        const body = urgentDetails ? `\n${urgentDetails}` : "";
        const msg = `${header}\n\nUrgent: ${urgentCount} | High: ${highCount}${body}\n\nOpen your dashboard inbox when you're up.`;
        await sendWhatsApp(`whatsapp:${coachPhone}`, msg).catch(e => console.error("[SLA ALERT]", e));
      }
    }
  } catch (slaErr) { console.error("[SCHEDULER] SLA digest failed:", slaErr); }
}, { timezone: "UTC" });

// ============================================================
// URGENT SLA MONITOR — checks urgent/high escalations every 30 min
// ============================================================
cron.schedule("*/30 * * * *", async () => {
  try {
    const now = new Date();
    const urgent = await db.select({
      id: escalations.id, userId: escalations.userId,
      reason: escalations.reason, priority: escalations.priority,
    }).from(escalations).where(
      and(
        eq(escalations.status, "open"),
        lte(escalations.slaDeadline, now),
        // Only urgent/high — normal and low are covered by the daily digest
        eq(escalations.priority, "urgent"),
      )
    ).limit(5);
    if (urgent.length > 0) {
      const coachPhone = process.env.COACH_ALERT_PHONE || process.env.COACH_PHONE;
      if (coachPhone) {
        const details = urgent.map(e => `• ${e.reason}`).join("\n");
        await sendWhatsApp(`whatsapp:${coachPhone}`,
          `🆘 URGENT escalation past 1h SLA — action required now\n\n${details}\n\nOpen dashboard immediately.`
        ).catch(e => console.error("[SLA URGENT]", e));
      }
    }
  } catch (e) { console.error("[SCHEDULER] Urgent SLA check failed:", e); }

  // WhatsApp delivery-quality early warning. A spiking failure rate is the first
  // sign the channel is degrading (sender-quality drop, mass opt-outs) — the path
  // to a number ban. Alert the coach once/day so it can be acted on before a block.
  try {
    const total = deliveryStats.sent + deliveryStats.failed;
    if (total >= 50 && deliveryStats.failed / total > 0.3) {
      const today = todaySAST();
      if (loadState()["delivery_quality_alert"] !== today) {
        saveState("delivery_quality_alert", today);
        const coachPhone = process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE;
        if (coachPhone) {
          const pct = Math.round((deliveryStats.failed / total) * 100);
          await sendWhatsApp(`whatsapp:${coachPhone.replace(/\D/g, "")}`,
            `⚠️ KamLife delivery alert: ${deliveryStats.failed}/${total} WhatsApp sends failed today (${pct}%).\n\nCheck Twilio status and your WhatsApp sender quality rating now — a high failure/block rate is the path to a number suspension.`
          ).catch(e => console.error("[DELIVERY_ALERT_SEND]", e?.message || e));
        }
      }
    }
  } catch (e) { console.error("[SCHEDULER] Delivery-quality check failed:", e); }
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

  // Hydrate scheduler state from DB so job guards survive container restarts
  await hydrateSchedulerStateFromDb();

  // Safe job runner — catches, logs, records run telemetry, and alerts coach on failure.
  // opts.critical = true → alert on the VERY FIRST failure (default: alert after 2 in a row).
  const jobFailureCounts: Record<string, number> = {};
  function safe(name: string, fn: () => Promise<void>, opts?: { critical?: boolean }): void {
    const started = Date.now();
    fn().then(() => {
      recordJobRun(name, true, Date.now() - started);
      jobFailureCounts[name] = 0; // reset on success
    }).catch(async (e) => {
      recordJobRun(name, false, Date.now() - started, String(e));
      jobFailureCounts[name] = (jobFailureCounts[name] || 0) + 1;
      const failures = jobFailureCounts[name];
      console.error(`[SCHEDULER] ${name} failed (x${failures}):`, e);
      const isCritical = opts?.critical ?? false;
      const alertThreshold = isCritical ? 1 : 2;
      const criticalJobs = ["runMorningCheckin", "runEveningAccountability", "runSundayWeeklyReport", "runPhaseAdvancement", "runSubscriptionExpiryCheck"];
      if (failures >= alertThreshold && (isCritical || criticalJobs.includes(name))) {
        const coachPhone = process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE;
        if (coachPhone) {
          const alertMsg = `⚠️ KamLife Scheduler Alert: "${name}" has failed ${failures} time${failures === 1 ? "" : "s"}${failures === 1 ? "" : " in a row"}.\n\nError: ${String(e).slice(0, 200)}\n\nCheck Railway logs immediately.`;
          sendWhatsApp(`whatsapp:${coachPhone.replace(/\D/g, "")}`, alertMsg).catch(alertErr => console.error("[SCHEDULER_ALERT_SEND]", alertErr?.message || alertErr));
        }
      }
    });
  }

  // ── One-time catch-up — runs on startup, self-deactivates via profileNotes flag ──
  safe("runStepSyncCatchup", runStepSyncCatchup);

  // ── Daily jobs ────────────────────────────────────────────────────────────
  cron.schedule("0 3 * * *",    () => safe("runBalanceCheck",           runBalanceCheck),             { timezone: "UTC" }); // 5am SAST — warn on low Twilio balance BEFORE the 6am fan-out drains it
  cron.schedule("30 8 * * *",   () => safe("runMonthlyPhotoCheckin",    runMonthlyPhotoCheckin),      { timezone: "UTC" }); // 10:30am SAST — monthly front/side/back re-shoot prompt (self-gates on 30 days)
  cron.schedule("0 4 * * *",    () => safe("runMorningCheckin",         runMorningCheckin, { critical: true }), { timezone: "UTC" }); // 6am SAST
  cron.schedule("0 17 * * *",   () => safe("runEveningAccountability",  runEveningAccountability),    { timezone: "UTC" }); // 7pm SAST
  cron.schedule("2 4 * * *",    () => safe("runWeek3Intervention",      runWeek3Intervention),        { timezone: "UTC" }); // 6am SAST
  cron.schedule("0 6 * * *",    () => safe("runMilestoneCelebrations",  runMilestoneCelebrations),    { timezone: "UTC" }); // 8am SAST
  cron.schedule("0 8 * * *",    () => safe("runEarlyOnboarding",        runEarlyOnboarding),          { timezone: "UTC" }); // 10am SAST
  cron.schedule("0 9 * * *",    () => safe("runGoalReassessment",       runGoalReassessment),         { timezone: "UTC" }); // 11am SAST
  cron.schedule("5 8 * * *",    () => safe("runSubscriptionExpiryCheck",runSubscriptionExpiryCheck),  { timezone: "UTC" }); // 10am SAST
  cron.schedule("0 10 * * *",   () => safe("runPaymentFailureRecovery", runPaymentFailureRecovery),   { timezone: "UTC" }); // 12pm SAST
  cron.schedule("3 9 * * *",    () => safe("runSignupNudge",            runSignupNudge),              { timezone: "UTC" }); // 11am SAST
  cron.schedule("0 9 * * *",    () => safe("runWaterReminder",           runWaterReminder),            { timezone: "UTC" }); // 11am SAST
  cron.schedule("30 7 * * *",   () => safe("runTrialCountdown",          runTrialCountdown),           { timezone: "UTC" }); // 9:30am SAST — trial Day 2/5/7 conversion
  cron.schedule("0 5 * * *",    () => safe("runCulturalCalendar",       runCulturalCalendar),         { timezone: "UTC" }); // 7am SAST
  cron.schedule("0 19 * * *",   () => safe("runStreakAtRisk",           runStreakAtRisk),             { timezone: "UTC" }); // 9pm SAST
  cron.schedule("0 8 * * 3",    () => safe("runWeightStallIntervention", runWeightStallIntervention), { timezone: "UTC" }); // 10am SAST Wed — engaged-but-plateaued churn catch
  cron.schedule("0 15 * * *",   () => safe("runComebackProtocol",       runComebackProtocol),         { timezone: "UTC" }); // 5pm SAST — structured 7-day return arc
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

  // ── Every minute — fire user-set reminders whose time has come ─────────────
  cron.schedule("* * * * *",     () => safe("runDueReminders",       runDueReminders),             { timezone: "UTC" });

  // ── Every 2 minutes — recover media jobs whose process died mid-flight (no silent loss) ──
  cron.schedule("*/2 * * * *",   () => safe("runMediaJobRecovery",   runMediaJobRecovery),         { timezone: "UTC" });

  // ── Hourly ────────────────────────────────────────────────────────────────
  cron.schedule("0 * * * *",     () => safe("runBuddyAccountability", runBuddyAccountability),     { timezone: "UTC" });

  // ── Weekly — Monday ───────────────────────────────────────────────────────
  cron.schedule("30 4 * * 1",    async () => {                        // 6:30am SAST weight reminder
    try {
      const today = todaySAST();
      if (hasRunToday("weight_reminder", today)) return;
      saveState("weight_reminder", today);
      await runWeightReminder();
    } catch (e) { console.error("[SCHEDULER] runWeightReminder failed:", e); }
  }, { timezone: "UTC" });
  cron.schedule("0 10 * * 1",    async () => {                        // 12pm SAST progress summary — moved off the 6–7am cluster so the morning brief + weigh-in aren't followed by a third message minutes later
    try {
      const today = todaySAST();
      if (hasRunToday("monday_progress", today)) return;
      saveState("monday_progress", today);
      await runMondayProgress();
    } catch (e) { console.error("[SCHEDULER] runMondayProgress failed:", e); }
  }, { timezone: "UTC" });
  cron.schedule("0 5 * * 1",     () => safe("runWeeklyKpiReport",     runWeeklyKpiReport),     { timezone: "UTC" }); // 7am SAST KPI report
  cron.schedule("0 5 * * 1",     () => safe("runWomensMonth",         runWomensMonth),         { timezone: "UTC" }); // 7am SAST Women's Month (Aug only)
  cron.schedule("0 5 * * 1",     () => safe("runPhaseAdvancement",    runPhaseAdvancement),    { timezone: "UTC" }); // 7am SAST phase check
  cron.schedule("0 4 * * 1",     () => safe("runTrainingDataLog",     runTrainingDataLog),     { timezone: "UTC" }); // 6am SAST training data log
  cron.schedule("0 11 * * 1",    async () => {                        // 1pm SAST grocery list — early afternoon, in time to plan the week's shop without stacking on the morning
    try {
      const today = todaySAST();
      if (hasRunToday("monday_groceries", today)) return;
      saveState("monday_groceries", today);
      await runMondayGroceries();
    } catch (e) { console.error("[SCHEDULER] runMondayGroceries failed:", e); }
  }, { timezone: "UTC" });
  cron.schedule("0 16 * * 1",    () => safe("runWeeklyMondayCheckin", runWeeklyMondayCheckin), { timezone: "UTC" }); // 6pm SAST — evening check-in lands when people have time to reply
  cron.schedule("0 7 * * 1",     () => safe("runGoalCheck",           runGoalCheck),           { timezone: "UTC" }); // 9am SAST

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
  cron.schedule("30 9 * * 3",    () => safe("runPausedClientLite",    runPausedClientLite),    { timezone: "UTC" }); // 11:30am SAST
  cron.schedule("0 12 * * 3",    () => safe("runMidweekSessionCheck", runMidweekSessionCheck), { timezone: "UTC" }); // 2pm SAST — zero-session intervention
  cron.schedule("0 18 * * 3",    () => safe("runWednesdaySleepQuestion", runWednesdaySleepQuestion), { timezone: "UTC" }); // 8pm SAST — weekly sleep question
  cron.schedule("0 17 * * 2",    () => safe("runWeeklyFeelingsCheckin", runWeeklyFeelingsCheckin), { timezone: "UTC" }); // 7pm SAST Tuesday — weekly "how are you feeling" emotional check-in (the door to deep support)

  // ── Weekly — Thursday ─────────────────────────────────────────────────────
  cron.schedule("0 5 * * 4",     () => safe("runProteinStreakIntervention", runProteinStreakIntervention), { timezone: "UTC" }); // 7am SAST — protein pattern

  // ── Weekly — Friday ───────────────────────────────────────────────────────
  cron.schedule("0 14 * * 5",    () => safe("runFridayWeekendStrategy", runFridayWeekendStrategy), { timezone: "UTC" }); // 4pm SAST

  // ── Weekly — Saturday ─────────────────────────────────────────────────────
  cron.schedule("0 8 * * 6",     () => safe("runNsvCheckin",          runNsvCheckin),          { timezone: "UTC" }); // 10am SAST

  // ── Weekly — Sunday ───────────────────────────────────────────────────────
  cron.schedule("0 13 * * 0",    () => safe("runSundayMealPlan",      runSundayMealPlan),      { timezone: "UTC" }); // 3pm SAST — proactive meal plan for the week ahead
  cron.schedule("0 20 * * 0",    () => safe("runCipUpdate",           runCipUpdate),           { timezone: "UTC" }); // 10pm SAST — rebuild all CIPs after the week closes
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
  cron.schedule("0 9 * * 0",     () => safe("runStepTargetAdaptation", runStepTargetAdaptation), { timezone: "UTC" }); // 11am SAST
  cron.schedule("0 15 * * 0",    () => safe("runStepLeaderboard",    runStepLeaderboard),     { timezone: "UTC" }); // 5pm SAST
  cron.schedule("0 17 * * 0",    () => safe("runSundayEveningCheckin",  runSundayEveningCheckin), { timezone: "UTC" }); // 7pm SAST

  // ── Monthly ───────────────────────────────────────────────────────────────
  cron.schedule("0 17 1 * *",    () => safe("runMonthlyNarrative",    runMonthlyNarrative),    { timezone: "UTC" }); // 1st 7pm SAST — identity narrative
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

  // ── Self-audit: coaching-quality loop (maker/checker) ─────────────────────
  // Samples the day's exchanges, scores them with a separate model, alerts the
  // coach if quality drifts below the bar. Runs late evening after the day's traffic.
  cron.schedule("30 21 * * *",   () => safe("runQualityAudit",        runQualityAudit),        { timezone: "UTC" }); // 11:30pm SAST
  cron.schedule("0 1 * * *",     () => safe("runDrillNightly",        runDrillNightly),        { timezone: "UTC" }); // 3am SAST — replay every tester failure against the live brain; failures WhatsApp Kam (stabilization contract, box one)

  // ── Global AI-spend tripwire ──────────────────────────────────────────────
  // Hourly: sums the day's model spend across ALL users and pings Kam at 50%/100%
  // of a soft daily budget. Catches the account-wide runaway ("$20→$200 overnight")
  // that per-user caps never see. Alert only — never stops coaching.
  cron.schedule("0 * * * *",     () => safe("runSpendWatchdog",       runSpendWatchdog),       { timezone: "UTC" }); // top of every hour

  // ── Daily setup-checklist reminder ────────────────────────────────────────
  // Fires once/day at 9am SAST (7am UTC). Builds a WhatsApp message listing
  // every uncompleted infrastructure item that requires a human action.
  // Each line silences itself the moment the corresponding env var / DB table
  // is present — the whole message disappears when everything is done.
  cron.schedule("0 7 * * *", async () => {
    const coachPhone = process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE;
    if (!coachPhone) return;

    const items: string[] = [];

    // DB-backup check REMOVED (2026-07-11): the backup's 5 secrets live in GITHUB
    // (the backup runs in GitHub Actions — see .github/workflows/db-backup.yml), so
    // the app's env can never see them. This check nagged "no backup running" every
    // morning DESPITE the backup being live and verified (run #73, 2026-07-08) — a
    // permanent false alarm that erodes trust in every real alert. Backup health is
    // visible in the Actions tab; the app cannot verify it and must not claim to.

    // 2. Schema migration — gptCosts table + cascade deletes + indexes
    try {
      await db.execute(sql`SELECT 1 FROM gpt_costs LIMIT 1`);
    } catch (e: any) {
      if (String(e?.message).includes("does not exist")) {
        items.push(
          "🔴 *Schema migration pending* — new tables/indexes not applied. Run: npm run db:push (from Railway shell or local with DATABASE_URL set)"
        );
      }
    }

    // 3. Coach alert phone — required for all scheduler + safety alerts
    if (!process.env.COACH_ALERT_PHONE) {
      items.push(
        "🟠 *COACH_ALERT_PHONE missing* — crisis alerts, scheduler failures, and SLA breaches won't reach you. Set in Railway env vars."
      );
    }

    // 4. SMS fallback — critical payment alerts need this for redundancy
    if (!process.env.TWILIO_SMS_NUMBER) {
      items.push(
        "🟠 *TWILIO_SMS_NUMBER missing* — payment failure SMS fallback is disabled. Buy a Twilio number and set this in Railway."
      );
    }

    // 5. Exercise GIF CDN — missing = workout messages send text-only
    if (!process.env.MEDIA_BASE_URL) {
      items.push(
        "🟡 *MEDIA_BASE_URL missing* — exercise GIFs won't load in workout messages. Set CDN root in Railway, then upload 21 GIF files."
      );
    }

    if (items.length === 0) return; // everything done — go silent

    const today = todaySAST();
    if (loadState()["setup_checklist_reminder"] === today) return;
    saveState("setup_checklist_reminder", today);

    const msg = [
      `📋 *KamLife Setup Checklist* — ${items.length} item${items.length > 1 ? "s" : ""} pending`,
      "",
      items.join("\n\n"),
      "",
      "This message disappears item-by-item as you complete each one.",
    ].join("\n");

    await sendWhatsApp(`whatsapp:${coachPhone.replace(/\D/g, "")}`, msg)
      .catch(e => console.error("[SETUP CHECKLIST] send failed:", e));
  }, { timezone: "UTC" });

  console.log("[SCHEDULER] All cron jobs registered.");
}
