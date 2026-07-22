import {
  db, users, chatHistory, stepLogs, weightLogs,
  eq, gte, and, asc, desc,
  sendWhatsApp, canSendProactive, recordProactiveSend, claimDailySlot,
  getActiveClients, isPaused, programmeDaysSince, sastDayStart,
} from "../shared";
import { getGoalProfile } from "../../goal-profiles";

// One-time catch-up: send step sync guide to any active client who has never
// received it (existing beta testers signed up before Day 3 auto-message was added).
export async function runStepSyncCatchup(): Promise<void> {
  console.log("[SCHEDULER] JOB: Step sync catch-up");
  const clients = await getActiveClients();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client) || !canSendProactive(client.id)) continue;
    if (programmeDaysSince(client.programmeStartDate) < 3) continue; // too new — Day 3 will catch them
    try {
      // Skip if they've already received a step sync message or set up steps
      const [alreadySent] = await db.select({ id: chatHistory.id })
        .from(chatHistory)
        .where(and(
          eq(chatHistory.userId, client.id),
          gte(chatHistory.createdAt, thirtyDaysAgo),
        ))
        .limit(1)
        .then(rows => rows.filter(r => {
          // Check via the sent message text — intent not stored for scheduler sends
          return false; // placeholder — check profileNotes instead
        }));

      // Use profileNotes as lightweight flag
      if ((client.profileNotes || "").includes("step_sync_sent")) continue;

      const name = (client.name || "there").split(" ")[0];

      const msg = `${name}, quick one — three ways to log your steps:\n\n*1. Just type the number* — send me a number any time. Like: *8500*\n*2. Send a screenshot* — photo of your steps app and I'll read the number\n*3. Auto-sync* — reply *connect steps* for a one-time setup that sends your steps to me automatically every night\n\nPick what works for you.`;

      if (!(await claimDailySlot(client.id, "step_sync_guide"))) continue;
      await sendWhatsApp(client.phoneNumber, msg);

      // Flag so we don't resend
      const updatedNotes = ((client.profileNotes || "") + " step_sync_sent").trim();
      await db.update(users).set({ profileNotes: updatedNotes }).where(eq(users.id, client.id));
    } catch (err) {
      console.error(`[SCHEDULER] Step sync catch-up error — ${client.phoneNumber}:`, err);
    }
  }
}

export async function runEarlyOnboarding(): Promise<void> {
  console.log("[SCHEDULER] JOB: Early onboarding check");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const days = programmeDaysSince(client.programmeStartDate);
      if (![1, 2, 3, 4, 5, 6, 7].includes(days)) continue;
      const name = client.name || "there";
      // One atomic daily-slot claim per onboarding day — DB-backed, restart-safe.
      if (!(await claimDailySlot(client.id, "early_onboarding"))) continue;

      if (days === 1) {
        await sendWhatsApp(client.phoneNumber, `${name}, Day 1. Your programme is live and ready.\n\nReply:\n• "today" for your workout\n• "2" to log food\n• "3" to log your steps\n\nOne small action today is better than a perfect week planned and not started.`);
      } else if (days === 2) {
        await sendWhatsApp(client.phoneNumber, `Day 2, ${name}. How did Day 1 go? Reply DONE if you completed the session, or just tell me what happened. No judgment — just forward.`);
      } else if (days === 3) {
        const day3Msg = `3 days in, ${name}. Most people have already quit by now. You are still here. That already puts you ahead.\n\n---\n\n*📱 Log your steps — pick what works for you:*\n\n*1. Just type the number* (easiest)\nSend me a number any time. Like: *8500*. I'll log it.\n\n*2. Send a screenshot*\nOpen Samsung Health, Apple Health, or Google Fit. Screenshot your step count. Send me the photo and I'll read it.\n\n*3. Auto-sync* (set up once, never log again)\nReply *connect steps* and I'll send you the one-time setup guide.`;
        await sendWhatsApp(client.phoneNumber, day3Msg);
      } else if (days === 4) {
        // Day 4 — make eating easy: a stocked kitchen removes the daily decision.
        const budget = client.weeklyFoodBudget || "100_300";
        const budgetLine = (budget === "under_100" || budget === "50_100" || budget === "under_50")
          ? "Protein first — eggs, pilchards, sugar beans. Those three carry the week."
          : client.goalType === "muscle_gain"
            ? "Chicken, eggs and oats in bulk — you need the volume to build."
            : "Lean protein first — chicken, tuna, eggs — then carbs around training.";
        await sendWhatsApp(client.phoneNumber, `Day 4, ${name}. Let's make eating easy.\n\nReply *shopping list* and I'll build you a budget-friendly list for the week. ${budgetLine}\n\nWhen the kitchen is stocked right, eating well stops being a daily decision — that's how consistency gets easy.`);
      } else if (days === 5) {
        const fiveDaysAgoOnb = new Date(Date.now() - 5 * 86_400_000);
        const recentSteps = await db.select({ steps: stepLogs.steps }).from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, fiveDaysAgoOnb)));
        const totalStepsLogged = recentSteps.reduce((s, r) => s + (r.steps || 0), 0);
        const recentFoodLogs = await db.select({ id: chatHistory.id }).from(chatHistory).where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, fiveDaysAgoOnb)));
        const workoutsDone = client.totalWorkoutsCompleted || 0;
        await sendWhatsApp(client.phoneNumber, `Day 5, ${name}. Here is what you have built in less than a week:\n\n✅ ${workoutsDone} workout${workoutsDone !== 1 ? "s" : ""} completed\n👟 ${totalStepsLogged.toLocaleString()} steps logged\n🍽 ${recentFoodLogs.length} meal${recentFoodLogs.length !== 1 ? "s" : ""} tracked\n\nThis is data. Data becomes results. Most people never get this far. You did.\n\nKeep logging — reply *1* for today's workout.`);
      } else if (days === 6) {
        // Day 6 — real life includes takeaways: teach the eating-out guide before week's end.
        await sendWhatsApp(client.phoneNumber, `Day 6, ${name}. Real life includes takeaways — let's handle them.\n\nNext time you're getting food out, just ask me: "what should I eat at KFC?" — or Nando's, Steers, Wimpy. I'll give you the smart order for your goal.\n\nEating out isn't the enemy. Not knowing what to order is. Just talk to me like a coach — I'm here all day.`);
      } else if (days === 7) {
        const workoutsDone = client.totalWorkoutsCompleted || 0;
        const goal = client.goalType === "muscle_gain" ? "building muscle" : client.goalType === "recomposition" ? "body recomp" : getGoalProfile(client.goalType).weightIsGoal ? "fat loss" : "wellness";
        await sendWhatsApp(client.phoneNumber, `One week done, ${name}. Seven days of showing up.\n\n${workoutsDone >= 3 ? `${workoutsDone} sessions this week — you are on track.` : workoutsDone > 0 ? `${workoutsDone} session${workoutsDone !== 1 ? "s" : ""} done — aim for ${client.trainingDaysPerWeek || 3} next week.` : "No sessions logged yet — this week, do one. Just one."}\n\n*What happens in Week 2:*\nYour body starts adapting. Energy improves. Soreness decreases. The habit begins to form. Most ${goal} results show at Week 4-6 — you are building the foundation right now.\n\nKeep going — just tell me what you need, whenever you need it.`);
      }
    } catch (err) { console.error(`[SCHEDULER] Early onboarding error — ${client.phoneNumber}:`, err); }
  }
}

export async function runMonthlyMeasurements(): Promise<void> {
  console.log("[SCHEDULER] JOB: Monthly measurements");
  const clients = await getActiveClients();
  const threeMonthsAgo = new Date(Date.now() - 90 * 86_400_000);
  const lastMonthStart = new Date(Date.now() - 35 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    if (!(await claimDailySlot(client.id, "monthly_measurements"))) continue;
    try {
      const name = (client.name || "there").split(" ")[0];
      const [latestWeight] = await db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt }).from(weightLogs).where(eq(weightLogs.userId, client.id)).orderBy(desc(weightLogs.loggedAt)).limit(1);
      const [oldestWeight] = await db.select({ weight: weightLogs.weight }).from(weightLogs).where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, threeMonthsAgo))).orderBy(asc(weightLogs.loggedAt)).limit(1);
      let contextLine = "";
      if (latestWeight && oldestWeight && latestWeight.weight !== oldestWeight.weight) {
        const diff = parseFloat(String(latestWeight.weight)) - parseFloat(String(oldestWeight.weight));
        const direction = diff < 0 ? `down ${Math.abs(diff).toFixed(1)}kg` : `up ${diff.toFixed(1)}kg`;
        const goal = client.goalType || "fat_loss";
        const onTrack = (goal === "fat_loss" && diff < 0) || (goal === "muscle_gain" && diff > 0);
        contextLine = `\n\nScale says you're ${direction} since we started. ${onTrack ? "That's the right direction." : "Let's look at what needs to change."}`;
      }
      const msg = latestWeight
        ? `${name}, it's the 1st — *photo day* 📸\n\nWeigh in this morning (before food, after bathroom) and send me the number.\n\nThen send a *progress photo* — front on, good light, same spot as last month, relaxed. And tell me how your *energy and clothes* are feeling.${contextLine}`
        : `${name}, it's the 1st — *photo day* 📸\n\nStep on the scale this morning, before food, after bathroom. Send me the number.\n\nThen send a *progress photo* — front on, good light, relaxed — and tell me how your *energy* is and how your *clothes* are fitting.\n\nYour shape and your energy show the change long before the scale does. No tape measure — we go on how you look and feel.`;
      await sendWhatsApp(client.phoneNumber, msg);
    } catch (err) { console.error(`[SCHEDULER] Monthly measurements error — ${client.phoneNumber}:`, err); }
  }
}

export async function runReferralNudge(): Promise<void> {
  console.log("[SCHEDULER] JOB: Referral nudge");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const days = programmeDaysSince(client.programmeStartDate);
      if (![7, 30, 60, 90].includes(days)) continue;
      if (!client.referralCode) continue;
      const name = client.name || "there";
      const code = client.referralCode;
      const msgs: Record<number, string> = {
        7: `${name}, one week in and you are still here — most people are not. If you know someone who needs this, your referral code is *${code}*. When a friend joins, you get a free month. Share it with one person today.`,
        30: `${name}, 30 days with Coach K. You are proof this works. Someone in your contacts needs to hear about this — share your code *${code}* and let them start where you did. One message, one person.`,
        60: `${name}, 60 days in. Two months of real work. People around you have noticed. When they ask what you are doing, tell them — and share code *${code}*. Every friend who joins earns you a free month. No limit.`,
        90: `${name}, 90 days. A quarter year of consistency. That is rare and worth talking about. Your code is *${code}* — share it with someone who has been talking about getting fit. They get a cheaper start. You get rewarded.`,
      };
      if (!(await claimDailySlot(client.id, "referral_nudge"))) continue;
      await sendWhatsApp(client.phoneNumber, msgs[days]);
    } catch (err) { console.error(`[SCHEDULER] Referral nudge error — ${client.phoneNumber}:`, err); }
  }
}

export async function runGoalReassessment(): Promise<void> {
  console.log("[SCHEDULER] JOB: Goal reassessment check");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const days = programmeDaysSince(client.programmeStartDate);
      if (![30, 60, 90].includes(days)) continue;
      const name = client.name || "there";
      const goal = client.goalType || "fat_loss";
      const profile = getGoalProfile(goal);
      const goalLabelStr = profile.label.toLowerCase();
      // Health-led clients (weightIsGoal=false) are NOT chasing the scale — the milestone check-in
      // asks how they FEEL and whether the habits stuck, never "send me your weight" (2026-07-22).
      const chasesWeight = profile.weightIsGoal;
      if (!(await claimDailySlot(client.id, "goal_reassessment"))) continue;
      if (days === 30) {
        await sendWhatsApp(client.phoneNumber, chasesWeight
          ? `${name}, 30 days in. Time to check in properly.\n\nWeigh yourself this morning and send me the number. Also — is your goal still ${goalLabelStr}? Or has something shifted? One reply: your weight in kg, and yes or no if the goal is the same.`
          : `${name}, 30 days in. Time to check in properly.\n\nForget the scale — tell me how you FEEL compared to a month ago. Energy? Sleep? Are the habits starting to feel automatic? And is your goal still ${goalLabelStr}? Reply and let's take stock.`);
      } else if (days === 60) {
        const weight = client.currentWeight ? `You started at ${client.currentWeight}kg.` : "";
        await sendWhatsApp(client.phoneNumber, chasesWeight
          ? `${name}, 60 days. ${weight} Two months of work deserves a proper check-in. Send me your current weight and I will tell you exactly how you are tracking against your ${goalLabelStr} goal. One number, right now.`
          : `${name}, 60 days. Two months of showing up. Tell me the real wins — more energy, better sleep, moving easier, a habit that stuck? That's what we're building. What's changed for you?`);
      } else if (days === 90) {
        await sendWhatsApp(client.phoneNumber, chasesWeight
          ? `${name}, 90 days — a full quarter. This is the reset point. Send me your weight, and tell me if your goal needs to change. People often start on fat loss and find they want to shift toward building muscle once they have lost the first round. Where are you now?`
          : `${name}, 90 days — a full quarter of looking after yourself. This is the reset point. Tell me how you're feeling and whether your goal still fits, or if you want to aim at something new now that the habits are in. Where are you at?`);
      }
    } catch (err) { console.error(`[SCHEDULER] Goal reassessment error — ${client.phoneNumber}:`, err); }
  }
}
