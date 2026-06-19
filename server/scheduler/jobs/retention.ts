import {
  db, users, chatHistory, stepLogs, workoutLogs, mealLogs,
  eq, gte, and, lt, desc, sql,
  sendWhatsApp, canSendProactive, recordProactiveSend,
  getActiveClients, isPaused, dayStart, loadState, saveState,
  TRAINING_SCHEDULES, wasSickOrInjured, isSickOrInjuredToday,
  todaySAST, claimProactive, claimDailySlot, isProactivePaused,
  escalations,
} from "../shared";
import { selectVariantMessage, recordDelivery } from "../../ab";

export async function runWeek3Intervention(): Promise<void> {
  console.log("[SCHEDULER] JOB: Week 3 intervention");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      if (client.programmeWeek !== 3) continue;
      // Once ever per client — DB claim survives the container recycle that wiped the state file.
      if (!(await claimProactive(client.id, "week3_intervention", "once"))) continue;
      const name = client.name || "there";
      const workouts = client.totalWorkoutsCompleted || 0;
      const planned = client.trainingDaysPerWeek || 3;
      {
        const daysSinceActive = client.lastActiveAt
          ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
          : 999;
        const isSlipping = daysSinceActive >= 3;
        const week3Msg = isSlipping
          ? `${name}, I have not heard from you in ${daysSinceActive} days. You are in Week 3 — the week most people quit.\n\n${workouts} sessions completed. That work is real and it does not disappear.\n\nI am not asking for a perfect week. I am asking for ONE session today. Reply *1* and I will send your workout. 20 minutes. That is all.`
          : `${name}, you have ${workouts} sessions banked. Week 3 is where 70% of people disappear — not because it got too hard, but because the mirror has not changed yet. The adaptation is happening in your muscles and metabolism. It is not visible yet but it is real. Show up ${planned} more times this week. That is all.`;
        await sendWhatsApp(client.phoneNumber, week3Msg);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Week 3 intervention error — ${client.phoneNumber}:`, err);
    }
  }
}

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
        if (ok) await sendWhatsApp(client.phoneNumber, `${name}, two days quiet. Everything okay? No pressure. Just checking.`);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Silence detection error — ${client.phoneNumber}:`, err);
    }
  }
}

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
    (name: string, wk: number) => `${name}. No judgment. Life happens. But your goals have not changed.\n\n${wk >= 3 ? `You had a ${wk}-session streak going — that is worth protecting.` : "One workout today puts you back on track."}\n\nReply "menu" to see today's workout. That is all I am asking.`,
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

export async function runBuddyAccountability(): Promise<void> {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
  const hourUTC = now.getUTCHours();
  if (hourUTC < 5 || hourUTC > 19) return;

  try {
    const recentWorkouts = await db.select({ userId: workoutLogs.userId, loggedAt: workoutLogs.loggedAt })
      .from(workoutLogs).where(gte(workoutLogs.loggedAt, hourAgo)).orderBy(desc(workoutLogs.loggedAt));

    const notifiedPairs = new Set<string>();
    for (const w of recentWorkouts) {
      try {
        const [worker] = await db.select({
          id: users.id, name: users.name, phoneNumber: users.phoneNumber,
          buddyId: users.buddyId, workoutStreak: users.workoutStreak, subscriptionStatus: users.subscriptionStatus,
        }).from(users).where(eq(users.id, w.userId)).limit(1);
        if (!worker || !worker.buddyId || worker.subscriptionStatus !== "active") continue;
        const pairKey = [worker.id, worker.buddyId].sort().join(":");
        if (notifiedPairs.has(pairKey)) continue;
        notifiedPairs.add(pairKey);
        const [buddy] = await db.select({ name: users.name, phoneNumber: users.phoneNumber, subscriptionStatus: users.subscriptionStatus })
          .from(users).where(eq(users.id, worker.buddyId)).limit(1);
        if (!buddy || buddy.subscriptionStatus !== "active") continue;
        const workerFirst = worker.name?.split(" ")[0] || "Your buddy";
        const workerStreak = worker.workoutStreak || 1;
        const streakAdd = workerStreak >= 3 ? ` That's a ${workerStreak}-session streak.` : "";
        const claimed = await claimProactive(worker.buddyId, `buddy_workout_${worker.id}`, todaySAST());
        if (!claimed) continue;
        await sendWhatsApp(buddy.phoneNumber, `🏋️ *${workerFirst} just logged a session.* Don't let them get ahead.${streakAdd}\n\nReply *done* when you finish yours.`);
        recordProactiveSend(worker.buddyId);
      } catch { /* skip pair */ }
    }

    const pairedUsers = await db.select({
      id: users.id, name: users.name, phoneNumber: users.phoneNumber,
      buddyId: users.buddyId, lastActiveAt: users.lastActiveAt, subscriptionStatus: users.subscriptionStatus,
    }).from(users).where(and(eq(users.subscriptionStatus, "active"), sql`${users.buddyId} IS NOT NULL`, lt(users.lastActiveAt, twoDaysAgo))).limit(50);

    for (const silentBuddy of pairedUsers) {
      try {
        if (!silentBuddy.buddyId) continue;
        const [partner] = await db.select({ id: users.id, name: users.name, phoneNumber: users.phoneNumber, subscriptionStatus: users.subscriptionStatus })
          .from(users).where(eq(users.id, silentBuddy.buddyId)).limit(1);
        if (!partner || partner.subscriptionStatus !== "active") continue;
        const silentFirst = silentBuddy.name?.split(" ")[0] || "Your buddy";
        const daysSilent = silentBuddy.lastActiveAt
          ? Math.floor((Date.now() - new Date(silentBuddy.lastActiveAt).getTime()) / 86_400_000)
          : 2;
        const claimed = await claimProactive(partner.id, `buddy_silence_${silentBuddy.id}`, todaySAST());
        if (!claimed) continue;
        await sendWhatsApp(partner.phoneNumber, `👀 *${silentFirst} hasn't logged in ${daysSilent} days.*\n\nYou're pulling ahead — but having an active buddy keeps you both sharper. If you know them, give them a nudge.`);
        recordProactiveSend(partner.id);
      } catch { /* skip */ }
    }
  } catch (err) {
    console.error("[SCHEDULER] Buddy accountability error:", err);
  }
}

export async function runStreakAtRisk(): Promise<void> {
  console.log("[SCHEDULER] JOB: Streak-at-risk alert (9pm SAST)");
  const clients = await getActiveClients();
  const todayStart = dayStart(0);
  const todayDOW = new Date(Date.now() + 2 * 3_600_000).getDay(); // SAST = UTC+2

  function computeStreakFromLogs(logs: { loggedAt: Date | null }[]): number {
    const days = new Set<string>();
    for (const l of logs) {
      if (!l.loggedAt) continue;
      const d = new Date(new Date(l.loggedAt).getTime() + 2 * 3_600_000);
      days.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
    }
    let streak = 0;
    const cur = new Date(Date.now() + 2 * 3_600_000);
    cur.setUTCDate(cur.getUTCDate() - 1);
    while (true) {
      const key = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}-${String(cur.getUTCDate()).padStart(2, "0")}`;
      if (!days.has(key)) break;
      streak++;
      cur.setUTCDate(cur.getUTCDate() - 1);
    }
    return streak;
  }

  let streakAlertsSent = 0;
  // Runaway-protection ceiling only — must exceed the real active base so genuine
  // users are never truncated. The per-user daily budget already bounds volume.
  const STREAK_ALERT_CAP = Math.max(1000, Number(process.env.STREAK_ALERT_CAP) || 20000);

  for (const client of clients) {
    if (streakAlertsSent >= STREAK_ALERT_CAP) { console.warn(`[SCHEDULER] Streak-at-risk cap reached`); break; }
    if (isPaused(client)) continue;
    if (!canSendProactive(client.id)) continue;

    const daysSilent = client.lastActiveAt
      ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
      : 0;
    if (daysSilent > 2) continue;

    try {
      const name = client.name || "there";
      const schedule = TRAINING_SCHEDULES[client.trainingDaysPerWeek || 3] || TRAINING_SCHEDULES[3];
      const isTodayTrainingDay = schedule.includes(todayDOW);
      const wStreak = client.workoutStreak || 0;

      if (isTodayTrainingDay && wStreak >= 2) {
        const todayWorkout = await db.select({ id: workoutLogs.id })
          .from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, todayStart))).limit(1);
        if (todayWorkout.length === 0 && !await isSickOrInjuredToday(client.id)) {
          if (!(await claimDailySlot(client.id, "streak_at_risk"))) continue;
          await sendWhatsApp(client.phoneNumber, `🔥 ${name}, your *${wStreak}-session workout streak* ends at midnight.\n\nLog your session tonight — even a 15-minute walk counts. Reply *done* when finished.`);
          streakAlertsSent++;
          continue;
        }
      }

      const todaySteps = await db.select({ id: stepLogs.id })
        .from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, todayStart))).limit(1);
      if (todaySteps.length === 0) {
        const recentSteps = await db.select({ loggedAt: stepLogs.loggedAt })
          .from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, new Date(Date.now() - 90 * 86400_000)))).orderBy(desc(stepLogs.loggedAt));
        const stepStreak = computeStreakFromLogs(recentSteps);
        if (stepStreak >= 2) {
          if (!(await claimDailySlot(client.id, "streak_at_risk"))) continue;
          await sendWhatsApp(client.phoneNumber, `🚶 ${name}, your *${stepStreak}-day step streak* ends at midnight.\n\nLog your steps now — even if it's only 3,000. Reply with a number or send a screenshot.`);
          streakAlertsSent++;
          continue;
        }
      }

      const todayFood = await db.select({ id: mealLogs.id })
        .from(mealLogs).where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, todayStart))).limit(1);
      if (todayFood.length === 0) {
        const recentMeals = await db.select({ loggedAt: mealLogs.loggedAt })
          .from(mealLogs).where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, new Date(Date.now() - 14 * 86400_000)))).orderBy(desc(mealLogs.loggedAt));
        const foodStreak = computeStreakFromLogs(recentMeals);
        if (foodStreak >= 3) {
          if (!(await claimDailySlot(client.id, "streak_at_risk"))) continue;
          await sendWhatsApp(client.phoneNumber, `📋 ${name}, your *${foodStreak}-day food logging streak* ends at midnight.\n\nTell me one thing you ate today — even "pap and chicken" is enough to keep it alive.`);
          streakAlertsSent++;
        }
      }
    } catch (err) {
      console.error(`[SCHEDULER] Streak-at-risk error — ${client.phoneNumber}:`, err);
    }
  }
  console.log(`[SCHEDULER] Streak-at-risk: ${streakAlertsSent} alerts sent`);
}

export async function runPausedClientLite(): Promise<void> {
  console.log("[SCHEDULER] JOB: Paused client lite check-in");
  if (isProactivePaused()) { console.log("[SCHEDULER:PAUSED] runPausedClientLite blocked"); return; }
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);

  // Compute ISO week start (Monday) in SAST — used as weekly dedup key
  const sast = new Date(Date.now() + 2 * 3_600_000);
  const dow = sast.getUTCDay();
  const thisWeek = new Date(sast.getTime() - (dow === 0 ? 6 : dow - 1) * 86_400_000)
    .toISOString().slice(0, 10);

  // Clients who paused/lapsed but interacted within 60 days — still warm
  const lapsedClients = await db.select({
    id: users.id,
    name: users.name,
    phoneNumber: users.phoneNumber,
    lastActiveAt: users.lastActiveAt,
  }).from(users).where(and(
    sql`${users.onboardingState} = 'COMPLETE'`,
    sql`${users.subscriptionStatus} != 'active'`,
    gte(users.lastActiveAt, sixtyDaysAgo),
  ));

  const MSGS = [
    (n: string) => `${n ? n + ", just" : "Just"} checking in. How have you been?`,
    (n: string) => `Hey${n ? " " + n : ""}. How's the week going?`,
    (n: string) => `${n ? n + " — " : ""}quick check-in. You doing okay?`,
    (n: string) => `${n ? n + ", " : ""}haven't heard from you in a bit. How are you keeping?`,
  ];
  const msgIdx = Math.floor(Date.now() / 604_800_000) % MSGS.length;

  let sent = 0;
  for (const client of lapsedClients) {
    try {
      // DB claim (weekly window) replaces the state-file flag a container recycle would wipe.
      if (!(await claimProactive(client.id, "paused_lite", thisWeek))) continue;
      const name = client.name?.split(" ")[0] || "";
      await sendWhatsApp(client.phoneNumber, MSGS[msgIdx](name));
      sent++;
    } catch (err) {
      console.error(`[SCHEDULER] Paused lite error — ${client.phoneNumber}:`, err);
    }
  }
  console.log(`[SCHEDULER] Paused client lite sent: ${sent}`);
}
