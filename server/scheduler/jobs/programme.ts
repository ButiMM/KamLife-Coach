import {
  db, users, chatHistory, stepLogs, workoutLogs, weightLogs,
  eq, gte, and, lt, asc, desc,
  sendWhatsApp, canSendProactive, recordProactiveSend,
  getActiveClients, isPaused, loadState, saveState,
  todaySAST, thisWeekUTC,
} from "../shared";

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
      const name = client.name || "there";
      const total = client.totalWorkoutsCompleted || 0;
      const goal = client.goalType || "fat_loss";
      const goalLabel: Record<string, string> = { fat_loss: "fat loss", muscle_gain: "muscle gain", recomposition: "body recomposition", general: "general fitness" };
      let goalMsg = "";
      if (currentWeek === 4) goalMsg = `${name}, you have completed Week 4 — ${total} sessions done. Time for a quick check-in.\n\nThree questions:\n1. Is your goal still *${goalLabel[goal] || goal}*?\n2. Has anything changed — injury, schedule, budget, life?\n3. How is your energy this week compared to Week 1?\n\nReply to any of these and I will adjust your programme if needed.`;
      else if (currentWeek === 8) goalMsg = `${name}, 8 weeks in. ${total} sessions. This is the point where real results start showing up — and where a lot of people shift their goal.\n\n*Is your current goal still right?* ${goalLabel[goal] || goal}.\n\nIf the goal has changed, or if something in your life has changed, tell me now. Your programme adjusts to your reality — not the other way around.`;
      else if (currentWeek === 12) goalMsg = `${name}, 12 weeks with Coach K. ${total} sessions. One quarter of a year of work.\n\nTime for a full review. Tell me:\n1. What is working?\n2. What is not?\n3. What has changed in your body or your life?\n\nYour programme evolves with you. Let me know what to adjust.`;
      else goalMsg = `${name}, Week ${currentWeek} checkpoint — ${total} sessions done. Is your goal still *${goalLabel[goal] || goal}*? Anything in your life or training that needs to change? Reply and we adjust.`;
      await sendWhatsApp(client.phoneNumber, goalMsg);
      await db.update(users).set({ lastGoalCheckWeek: currentWeek }).where(eq(users.phoneNumber, client.phoneNumber));
    } catch (err) { console.error(`[SCHEDULER] Goal check error — ${client.phoneNumber}:`, err); }
  }
}

export async function runWeeklyMondayCheckin(): Promise<void> {
  console.log("[SCHEDULER] JOB: Weekly Monday check-in");
  const clients = await getActiveClients();
  const thisWeek = thisWeekUTC();
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    if (client.lastActiveAt && new Date(client.lastActiveAt) < fiveDaysAgo) continue;
    try {
      const stateKey = `weekly_checkin_${client.id}`;
      if (loadState()[stateKey] === thisWeek) continue;
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
        const goalMsg = goal === "fat_loss" ? "Fat loss compounds from here — the early weeks built the foundation." : goal === "muscle_gain" ? "Muscle building accelerates after week 8 — progressive overload is everything now." : "Your body is recomposing — fat down, muscle up. The scale may not move much but the mirror will.";
        msg = `${name}, Week ${week} — ${sessions} total sessions. ${goalMsg} One focus this week: log your lifts and add weight or reps to every exercise.`;
      } else {
        msg = `${name}, Week ${week} — ${sessions} sessions. You are in the top 5% of people who stick with a programme this long. What is your goal for this week? One specific thing.`;
      }
      if (canSendProactive(client.id)) { await sendWhatsApp(client.phoneNumber, msg); saveState(stateKey, thisWeek); recordProactiveSend(client.id); }
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
      await sendWhatsApp(client.phoneNumber, `${name}, quick check — how is the ${injuryNote} doing? If it has improved, reply "injury better" and I will update your programme. If it is still affecting you, tell me what you can and cannot do and I will adjust.`);
    } catch (err) { console.error(`[SCHEDULER] Injury follow-up error — ${client.phoneNumber}:`, err); }
  }
}

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
      const recentWeights = await db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt }).from(weightLogs).where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, twentyOneDaysAgo))).orderBy(asc(weightLogs.loggedAt));
      if (recentWeights.length < 2) continue;
      const oldest = parseFloat(String(recentWeights[0].weight));
      const newest = parseFloat(String(recentWeights[recentWeights.length - 1].weight));
      if (Math.abs(newest - oldest) > 0.5) continue;
      await sendWhatsApp(client.phoneNumber, `${name}, your weight has been stable for 3 weeks. This is a plateau and it is normal — your body adapts. Here is the fix: this week, cut your carb portions by one third. Keep protein the same. Add a 20-minute walk on top of your normal routine. Weigh in again in 7 days. Plateaus break when you change one variable at a time.`);
      saveState(`plateau_sent_${client.id}`, todaySAST());
    } catch (err) { console.error(`[SCHEDULER] Plateau detection error — ${client.phoneNumber}:`, err); }
  }
}
