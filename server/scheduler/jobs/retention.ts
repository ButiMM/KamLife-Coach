import {
  db, users, chatHistory, stepLogs, workoutLogs, mealLogs, weightLogs,
  eq, gte, and, lt, desc, sql,
  sendWhatsApp, canSendProactive, recordProactiveSend,
  getActiveClients, isPaused, dayStart, loadState, saveState,
  TRAINING_SCHEDULES, wasSickOrInjured, isSickOrInjuredToday,
  todaySAST, thisWeekUTC, claimProactive, claimDailySlot, isProactivePaused,
  escalations,
} from "../shared";
import { selectVariantMessage, recordDelivery } from "../../ab";
import { detectWeightStall } from "../../trajectory";
import { getTrajectoryForUser } from "../../trajectory-report";

export async function runSilenceDetection(): Promise<void> {
  console.log("[SCHEDULER] JOB: Silence detection");
  const clients = await getActiveClients();
  const now = Date.now();
  const HOUR = 3_600_000;

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      if (!client.lastActiveAt) continue;
      const name = client.name || "there";
      const silenceMs = now - new Date(client.lastActiveAt).getTime();
      const workouts = client.totalWorkoutsCompleted || 0;
      const week = client.programmeWeek || 1;

      const today = todaySAST();
      if (silenceMs >= 14 * 24 * HOUR && silenceMs < 15 * 24 * HOUR) {
        const ok = await claimProactive(client.id, "silence_14d", today);
        if (ok) {
          await sendWhatsApp(client.phoneNumber,
            `${name}, two weeks. ${workouts} sessions logged. Week ${week} of your programme. All saved.\n\nI am not going anywhere. When you are ready, just say Hi — I will tell you exactly where you left off and what to do next. No judgement. No starting over.`
          );
          try {
            const existingEsc = await db.select({ id: escalations.id })
              .from(escalations).where(and(eq(escalations.userId, client.id), eq(escalations.status, "open"))).limit(1);
            if (existingEsc.length === 0) {
              await db.insert(escalations).values({
                userId: client.id, reason: "14_day_silence", status: "open",
                priority: "urgent", slaDeadline: new Date(Date.now() + 48 * HOUR),
              });
            }
          } catch (flagErr) {
            console.error(`[SCHEDULER] Failed to create escalation for ${client.phoneNumber}:`, flagErr);
          }
        }
      } else if (silenceMs >= 7 * 24 * HOUR && silenceMs < 8 * 24 * HOUR) {
        const ok = await claimProactive(client.id, "silence_7d", today);
        if (ok) await sendWhatsApp(client.phoneNumber,
          `${name}, a week since we spoke. ${workouts > 0 ? `You have ${workouts} sessions in the bank — that does not disappear.` : "Your programme is ready and waiting."} Life gets busy — I get it.\n\nReply *1* to see today's workout. That is all — one session.`
        );
      } else if (silenceMs >= 48 * HOUR && silenceMs < 72 * HOUR) {
        const ok = await claimProactive(client.id, "silence_2d", today);
        // Silence is usually eating-shame, not busyness (2026-07-13 retention reports).
        // Make the hard days SAFE to admit — that breaks the hide→avoid→quit spiral.
        if (ok) await sendWhatsApp(client.phoneNumber, `${name}, two days quiet — and that's completely okay. Life happens. No judgement, ever. 💛\n\nNothing reset and nothing's lost — we just pick up exactly where you left off. And if you ate something off-plan, tell me anyway: I count everything, *especially* the hard days. That's the whole point of me.\n\nWhat did you eat today? One line is all I need.`);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Silence detection error — ${client.phoneNumber}:`, err);
    }
  }
}

/**
 * FADE DETECTION — still replying, stopped logging.
 *
 * (2026-07-28.) runSilenceDetection above keys on `lastActiveAt`, which EVERY inbound message
 * bumps. So a client who still answers "ok" twice a week while logging nothing for a fortnight
 * never trips it — and that is precisely the founder's churn pattern: "people come in excited,
 * then after a month or two they drop it off." They go passive long before they go quiet, and
 * the passive phase is the only window where a nudge still lands.
 *
 * Fires once per client per fortnight, respects every existing gate (pause, friction/life quiet
 * window, the shared daily budget). Silent clients are deliberately left to the silence job so
 * nobody gets both.
 */
export async function runDeepSilenceEscalation(): Promise<void> {
  console.log("[SCHEDULER] JOB: Deep silence escalation");
  const clients = await getActiveClients();
  const now = Date.now();
  const HOUR = 3_600_000;

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      if (!client.lastActiveAt) continue;
      const name = client.name || "there";
      const silenceMs = now - new Date(client.lastActiveAt).getTime();
      const workouts = client.totalWorkoutsCompleted || 0;
      const week = client.programmeWeek || 1;

      // 30-day final message — one send only, then Coach K stops proactively reaching out
      if (silenceMs >= 30 * 24 * HOUR && silenceMs < 31 * 24 * HOUR) {
        const ok = await claimProactive(client.id, "deep_silence_30d", todaySAST());
        if (ok) await sendWhatsApp(client.phoneNumber,
          `${name}, a month of silence. I am not going to keep messaging you after this. Your profile is saved, your programme is saved, everything is exactly as you left it. When life settles and you are ready — just say "back" and we go again. No judgment.`
        );
      }
    } catch (err) {
      console.error(`[SCHEDULER] Deep silence error — ${client.phoneNumber}:`, err);
    }
  }
}

export async function runComebackMessages(): Promise<void> {
  console.log("[SCHEDULER] Running comeback messages...");
  if (isProactivePaused()) { console.log("[SCHEDULER:PAUSED] runComebackMessages blocked"); return; }
  const threeDaysAgo = new Date(Date.now() - 3 * 86400_000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);

  const silentClients = await db.select().from(users)
    .where(and(
      eq(users.onboardingState, "COMPLETE"),
      eq(users.subscriptionStatus, "active"),
      lt(users.lastActiveAt, threeDaysAgo),
      gte(users.lastActiveAt, sevenDaysAgo)
    ));

  const comebacks = [
    (name: string, wk: number) => `${name}, it has been a few days. Your programme is still here waiting. ${wk > 0 ? `You were on ${wk} workouts — do not let that go.` : ""} One session today changes the trajectory. What time are you training?`,
    (name: string, wk: number) => `${name}. No judgment. Life happens. But your goals have not changed.\n\n${wk >= 3 ? `${wk} sessions completed — that work is still yours.` : "One workout today puts you back on track."}\n\nReply "menu" to see today's workout. That is all I am asking.`,
    (name: string, wk: number) => `${name}, quick check — you good? Have not heard from you in a few days.\n\nYour programme is ready whenever you are. Just reply "menu" and we pick up exactly where you left off.\n\nNo reset. No guilt. Just forward.`,
    (name: string, wk: number) => `${name}, noticed you've been quiet — no judgment, life gets busy.\n\n${wk >= 5 ? `${wk} sessions already done — that's real progress, worth picking back up.` : "One session today gets you moving again."}\n\nReply *done* after your next workout. I'll be here.`,
  ];

  let sent = 0;
  for (const client of silentClients) {
    const name = client.name?.split(" ")[0] || "there";
    const wk = client.totalWorkoutsCompleted || 0;
    const msg = comebacks[sent % comebacks.length](name, wk);
    // Once per day per client — DB-backed so a recycle on a comeback day can't re-send.
    if (!(await claimProactive(client.id, "comeback", todaySAST()))) continue;
    await sendWhatsApp(client.phoneNumber, msg);
    sent++;
  }
  console.log(`[SCHEDULER] Comeback messages sent: ${sent}`);
}
