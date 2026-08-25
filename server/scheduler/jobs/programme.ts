import {
  db, users, chatHistory, stepLogs, workoutLogs, weightLogs,
  eq, gte, and, lt, asc, desc,
  sendWhatsApp, canSendProactive, recordProactiveSend,
  getActiveClients, isPaused, loadState, saveState,
  todaySAST, thisWeekUTC, claimProactive, claimDailySlot,
} from "../shared";
import { getGoalProfile } from "../../goal-profiles";
import { getWeightTruth } from "../../day-ledger";

export async function runPhaseAdvancement(): Promise<void> {
  console.log("[SCHEDULER] JOB: Phase advancement check");
  const clients = await getActiveClients();
  const fourWeeksAgo = new Date(Date.now() - 28 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      if ((client.programmeWeek || 1) < 4) continue;
      if (client.phaseReadyToAdvance) continue;
      const plannedSessions = (client.trainingDaysPerWeek || 3) * 4;
      const completedSessions = await db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, fourWeeksAgo)));
      const compliance = completedSessions.length / plannedSessions;
      if (compliance < 0.75) continue;
      const currentPhase = client.programmePhase || 1;
      if (currentPhase >= 5) continue;
      const newPhase = currentPhase + 1;
      // Claim before mutating + sending so a container recycle can't re-advance/re-send.
      if (!(await claimProactive(client.id, "phase_advance", `phase${newPhase}`))) continue;
      const phaseNames: Record<number, string> = { 1: "Foundation", 2: "Build", 3: "Push", 4: "Peak", 5: "Deload" };
      await db.update(users).set({ programmePhase: newPhase, programmeWeek: 1, programmeDayInWeek: 1, phaseReadyToAdvance: false }).where(eq(users.id, client.id));
      const name = client.name || "there";
      await sendWhatsApp(client.phoneNumber, `${name}, you have completed Phase ${currentPhase} (${phaseNames[currentPhase]}). ${completedSessions.length} of ${plannedSessions} planned sessions done — ${Math.round(compliance * 100)}% compliance. You have earned Phase ${newPhase}: ${phaseNames[newPhase]}. Your programme has been updated. Reply "today" for your first Phase ${newPhase} session.`);
    } catch (err) { console.error(`[SCHEDULER] Phase advancement error — ${client.phoneNumber}:`, err); }
  }
}

export async function runGoalCheck(): Promise<void> {
  console.log("[SCHEDULER] JOB: Goal check / programme review");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const currentWeek = client.programmeWeek || 1;
      const lastCheck = client.lastGoalCheckWeek || 0;
      const checkWeeks = [4, 8, 12, 16, 20, 24];
      if (!checkWeeks.includes(currentWeek) || lastCheck >= currentWeek) continue;
      // DB claim per checkpoint week — survives restart; covers both send paths below.
      if (!(await claimProactive(client.id, "goal_check", `week${currentWeek}`))) continue;
      const name = client.name || "there";
      const total = client.totalWorkoutsCompleted || 0;
      const goal = client.goalType || "fat_loss";
      // Goal-aware label for all five goals (was a map missing health_condition → raw enum leaked).
      const goalLabelStr = getGoalProfile(goal).label.toLowerCase();
      let goalMsg = "";
      if (currentWeek === 4) goalMsg = `${name}, you have completed Week 4 — ${total} sessions done. Time for a quick check-in.\n\nThree questions:\n1. Is your goal still *${goalLabelStr}*?\n2. Has anything changed — injury, schedule, budget, life?\n3. How is your energy this week compared to Week 1?\n\nReply to any of these and I will adjust your programme if needed.`;
      else if (currentWeek === 8) {
        goalMsg = `${name}, 8 weeks done. ${total} sessions. This is where most people quit — you didn't.\n\nWeek 9 starts now. You have two directions:\n\n*1 — Maintenance* — 3 days/week, hold your gains, sustainable forever\n*2 — Advanced* — 5 days/week, harder sessions, new exercises, next level\n\nReply *1* or *2* and I will set your programme for the next 8 weeks.`;
        await sendWhatsApp(client.phoneNumber, goalMsg);
        await db.update(users).set({ lastGoalCheckWeek: currentWeek, awaitingInputType: "week9_choice" }).where(eq(users.phoneNumber, client.phoneNumber));
        continue;
      }
      else if (currentWeek === 12) goalMsg = `${name}, 12 weeks with Coach K. ${total} sessions. One quarter of a year of work.\n\nTime for a full review. Tell me:\n1. What is working?\n2. What is not?\n3. What has changed in your body or your life?\n\nYour programme evolves with you. Let me know what to adjust.`;
      else goalMsg = `${name}, Week ${currentWeek} checkpoint — ${total} sessions done. Is your goal still *${goalLabelStr}*? Anything in your life or training that needs to change? Reply and we adjust.`;
      await sendWhatsApp(client.phoneNumber, goalMsg);
      await db.update(users).set({ lastGoalCheckWeek: currentWeek }).where(eq(users.phoneNumber, client.phoneNumber));
    } catch (err) { console.error(`[SCHEDULER] Goal check error — ${client.phoneNumber}:`, err); }
  }
}

export async function runWeeklyMondayCheckin(): Promise<void> {
  console.log("[SCHEDULER] JOB: Weekly Monday check-in");
  const clients = await getActiveClients();
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    if (client.lastActiveAt && new Date(client.lastActiveAt) < fiveDaysAgo) continue;
    try {
      const name = client.name || "there";
      const week = client.programmeWeek || 1;
      const sessions = client.totalWorkoutsCompleted || 0;
      const planned = client.trainingDaysPerWeek || 3;
      const goal = client.goalType || "fat_loss";
      const streak = client.workoutStreak || 0;
      let msg = "";
      if (week === 1) msg = `${name}, Week 1. This week is about building the habit, not the body — the physical changes come later.\n\nExpect: some soreness, hunger changes, maybe lower energy by day 3. All normal. Your only job this week: complete ${planned} sessions and log every meal. Nothing else.\n\nSend me your first meal of the day.`;
      else if (week === 2) msg = `${name}, Week 2. The soreness from last week means your muscles responded. ${sessions} sessions banked.\n\nExpect: energy starts stabilising. Scale might go up slightly (water and glycogen) — ignore it, it normalises by week 3. Focus: hit your step target of ${(client.stepsTarget || 8500).toLocaleString()} every day this week.`;
      else if (week === 3) msg = `${name}, Week 3 — this is the hardest week. Not because it got heavier, but because the mirror has not changed yet and motivation is low.\n\nThis is normal. The physical changes are happening inside — metabolism adapting, muscle fibres rebuilding. Visible results show at week 4–6 for most people. You are 7 days away from seeing the shift.\n\nComplete ${planned} sessions. That is all.`;
      else if (week === 4) msg = `${name}, Week 4 — one full month in. ${sessions} sessions. This is where it starts to show.\n\nExpect: clothes fitting slightly differently, energy more consistent, strength up on at least one exercise. This week: push harder — more reps or more weight on every exercise. You built the foundation. Now use it.`;
      else if (week <= 8) msg = `${name}, Week ${week} — ${sessions} sessions in the bank. Target for this week: ${planned} sessions and ${sessions + planned} total. ${streak >= 3 ? `You are on a ${streak}-session streak — do not break it.` : "Get the streak going."}`;
      else if (week <= 12) {
        const goalMsg = goal === "fat_loss" ? "Fat loss compounds from here — the early weeks built the foundation." : goal === "muscle_gain" ? "Muscle building accelerates after week 8 — progressive overload is everything now." : !getGoalProfile(goal).weightIsGoal ? "This is where the habit becomes who you are — steadier energy, better sleep, movement that just happens. Keep showing up." : "Your body is recomposing — fat down, muscle up. The scale may not move much but the mirror will.";
        msg = `${name}, Week ${week} — ${sessions} total sessions. ${goalMsg} One focus this week: log your lifts and add weight or reps to every exercise.`;
      } else {
        msg = `${name}, Week ${week} — ${sessions} sessions. You are in the top 5% of people who stick with a programme this long. What is your goal for this week? One specific thing.`;
      }
      // MONDAY SCALE ACCOUNTABILITY (2026-07-17 founder: "extremely held accountable
      // ... somebody is there doing it with them"): if the morning weigh-in prompt
      // went unanswered, the evening check-in leads with the scale — one combined
      // message, never a separate nag on an already-busy Monday.
      const sastMidnight = new Date(new Date(Date.now() + 2 * 3_600_000).setUTCHours(0, 0, 0, 0) - 2 * 3_600_000);
      const weighedToday = await db.select({ id: weightLogs.id }).from(weightLogs)
        .where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, sastMidnight))).limit(1);
      if (weighedToday.length === 0) {
        msg = `⚖️ First things first — what did the scale say this morning? Send me the number (e.g. *82.4kg*). Even if it's up, send it: the number is data, not judgment, and Monday's weigh-in is how we steer your whole week.\n\n${msg}`;
      }
      // Daily-slot claim before send (preserves daily-cap reach; DB-backed, restart-safe).
      if (await claimDailySlot(client.id, "weekly_checkin")) { await sendWhatsApp(client.phoneNumber, msg); }
    } catch (err) { console.error(`[SCHEDULER] Weekly check-in error — ${client.phoneNumber}:`, err); }
  }
}

export async function runInjuryFollowup(): Promise<void> {
  console.log("[SCHEDULER] JOB: Injury follow-up");
  const clients = await getActiveClients();
  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      if (!client.injuries || client.injuries === "" || client.injuries === "none") continue;
      const name = client.name || "there";
      const injuryNote = client.injuries.slice(0, 60);
      // Once per week per client — DB-backed so a restart can't re-ask the same day.
      if (!(await claimProactive(client.id, "injury_followup", thisWeekUTC()))) continue;
      await sendWhatsApp(client.phoneNumber, `${name}, quick check — how is the ${injuryNote} doing? If it has improved, reply "injury better" and I will update your programme. If it is still affecting you, tell me what you can and cannot do and I will adjust.`);
    } catch (err) { console.error(`[SCHEDULER] Injury follow-up error — ${client.phoneNumber}:`, err); }
  }
}

// Plateau intervention LOOP — detect → intervene → verify after 7 days → iterate.
// State lives in users.profileNotes as `plateau_intervention:YYYY-MM-DD:WEIGHT`,
// durable across container restarts (same pattern as streak_shield/paused_until).
// A plateau isn't "handled" by one message — the loop keeps changing one variable
// at a time and checking the scale until the weight actually moves.
export async function runPlateauDetection(): Promise<void> {
  console.log("[SCHEDULER] JOB: Plateau detection");
  const clients = await getActiveClients();
  const twentyOneDaysAgo = new Date(Date.now() - 21 * 86_400_000);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      if (client.goalType !== "fat_loss" && client.goalType !== "recomposition") continue;
      const recentActivity = await db.select({ id: chatHistory.id }).from(chatHistory).where(and(eq(chatHistory.userId, client.id), gte(chatHistory.createdAt, fourteenDaysAgo))).limit(1);
      if (recentActivity.length === 0) continue;

      const notes = client.profileNotes || "";
      const interventionMatch = notes.match(/plateau_intervention:(\d{4}-\d{2}-\d{2}):([\d.]+)/);

      // ── STAGE 2 — verify an intervention issued ~7 days ago ──────────────────
      if (interventionMatch) {
        const issuedDate = new Date(interventionMatch[1]);
        const baselineWeight = parseFloat(interventionMatch[2]);
        const daysSince = Math.floor((Date.now() - issuedDate.getTime()) / 86_400_000);
        if (daysSince < 7) continue; // give the change time to work

        const sinceWeights = await db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt })
          .from(weightLogs)
          .where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, issuedDate)))
          .orderBy(desc(weightLogs.loggedAt)).limit(1);
        const clearedNotes = notes.replace(/\s*plateau_intervention:\d{4}-\d{2}-\d{2}:[\d.]+/, "").trim();

        if (sinceWeights.length === 0) {
          // Can't verify without a weigh-in — clear the marker and ask for one.
          if (await claimProactive(client.id, "plateau_followup_noweight", thisWeekUTC())) {
            await db.update(users).set({ profileNotes: clearedNotes }).where(eq(users.id, client.id));
            await sendWhatsApp(client.phoneNumber, `${name}, it's been a week since we changed your plan to break the plateau. I need a weigh-in to know if it worked — step on the scale this morning and send me the number.`);
          }
          continue;
        }

        const newWeight = parseFloat(String(sinceWeights[0].weight));
        const moved = baselineWeight - newWeight; // +ve = weight lost (good for fat loss)

        if (moved >= 0.4) {
          // Success — the loop exits, weight is moving again.
          if (await claimProactive(client.id, "plateau_broken", thisWeekUTC())) {
            await db.update(users).set({ profileNotes: clearedNotes }).where(eq(users.id, client.id));
            await sendWhatsApp(client.phoneNumber, `${name}, it worked — down ${moved.toFixed(1)}kg since we changed your plan. The plateau's broken. This is the proof that adjusting one variable at a time works. Hold the carb portions where they are now.`);
          }
        } else {
          // Still stuck — iterate with a DIFFERENT lever and re-arm the loop.
          if (await claimProactive(client.id, "plateau_iterate", thisWeekUTC())) {
            const reStamped = `${clearedNotes} plateau_intervention:${todaySAST()}:${newWeight}`.trim();
            await db.update(users).set({ profileNotes: reStamped }).where(eq(users.id, client.id));
            await sendWhatsApp(client.phoneNumber, `${name}, still holding after the carb change — so we change a different lever this week. Add 2,000 steps to your daily target and move your biggest meal earlier in the day. Same protein. Weigh in again in 7 days. We keep adjusting until it moves.`);
          }
        }
        continue;
      }

      // ── STAGE 1 — detect a fresh 3-week plateau and issue the first change ───
      // THE SCALE COMES FROM ITS OWNER (2026-08-25, P0-5 · weight). A direct weight_logs read
      // whose whole output is a message ABOUT the scale — "your weight has been stable for 3
      // weeks" — sent to a client who may have asked us to stop raising it, on the proactive path
      // where the reactive strip never runs. Withheld now returns no points, so the plateau nudge
      // stands down for that client rather than being stripped into nonsense afterwards.
      const wt = await getWeightTruth(client, { windowDays: 21 }).catch(() => null);
      const recentWeights = wt?.points ?? [];
      if (recentWeights.length < 2) continue;
      const oldest = recentWeights[0].kg;
      const newest = recentWeights[recentWeights.length - 1].kg;
      if (Math.abs(newest - oldest) > 0.5) continue;
      // DB claim (weekly window) replaces the old state-file flag, which a container
      // recycle would wipe — causing a repeat plateau message on restart.
      if (!(await claimProactive(client.id, "plateau", thisWeekUTC()))) continue;
      // Record the intervention + baseline weight so Stage 2 can verify in 7 days.
      const stampedNotes = `${notes} plateau_intervention:${todaySAST()}:${newest}`.trim();
      await db.update(users).set({ profileNotes: stampedNotes }).where(eq(users.id, client.id));
      await sendWhatsApp(client.phoneNumber, `${name}, your weight has been stable for 3 weeks. This is a plateau and it is normal — your body adapts. Here is the fix: this week, cut your carb portions by one third. Keep protein the same. Add a 20-minute walk on top of your normal routine. Weigh in again in 7 days. Plateaus break when you change one variable at a time.`);
    } catch (err) { console.error(`[SCHEDULER] Plateau detection error — ${client.phoneNumber}:`, err); }
  }
}
