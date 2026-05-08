/**
 * Workout-related commands: gym log, done, my lifts, exercise weight log,
 * goal change, weight update/mention, programme setup, photo correction,
 * elderly/injury programme, programme delivery.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { users, workoutLogs, exerciseLogs } from "../../shared/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import twilio from "twilio";
import {
  buildDayWorkout, buildDay2Workout, buildDay3Workout,
  buildFullProgramme, getKamlifeProgramme, WORKOUT_DONE_RESPONSES,
} from "../programme";
import { checkPerfectDay, getProgressiveOverloadContext } from "./checks";
import { storeMemory } from "../memory";
import { generateVoiceNote } from "../tts";
import { logChat } from "./chat-log";
import { sastDayStart } from "../utils";
import { handleWeightLog } from "./weight";
import { calculateTargets } from "../targets";
import { getPrimaryWorkoutGifUrl } from "../exercise-media";

export async function handleWorkoutCommands(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
}): Promise<string | null> {
  const { phone, message, m } = ctx;
  const user = ctx.user;

  // ---- GYM WORKOUT LOG — "DAY 3 — UPPER / LOWER" with exercise list ----
  const gymLogMatch = m.match(/^(?:day\s*\d+\s*[—\-–:]+\s*)?(upper|lower|push|pull|legs?|full body|back|chest|arms?|shoulders?)\b/i);
  const hasMultipleExerciseLines = (m.match(/\n.*[×x]\d|\n.*\d+\s*[×x]\s*\d|shoulder|lat pull|bench|squat|deadlift|row|press|curl|extension|fly|crunch|plank/gi) || []).length >= 2;
  const looksLikeGymLog = gymLogMatch && hasMultipleExerciseLines && m.split("\n").length >= 3;

  if (looksLikeGymLog) {
    const name = user.name?.split(" ")[0] || "";
    const sessionType = gymLogMatch[1].charAt(0).toUpperCase() + gymLogMatch[1].slice(1).toLowerCase();
    const exerciseLines = m.split("\n").filter(l => /[×x]\d|\d+\s*[×x]|sets?|reps?/i.test(l) || /shoulder|lat|bench|squat|deadlift|row|press|curl|extension|fly/i.test(l));
    const exCount = exerciseLines.length;
    const failedCount = (m.match(/🔴|failed|couldn.?t|could not|did not complete/gi) || []).length;
    const warningCount = (m.match(/⚠️|warning|struggled|nearly/gi) || []).length;

    const todayStartGym = sastDayStart();
    const alreadyLogged = await db.select({ id: workoutLogs.id })
      .from(workoutLogs)
      .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, todayStartGym)))
      .limit(1);

    let gymLogReply = "";
    if (alreadyLogged.length === 0) {
      const newTotal = (user.totalWorkoutsCompleted || 0) + 1;
      let newDay = (user.programmeDayInWeek || 1) + 1;
      let newWeek = user.programmeWeek || 1;
      const daysPerWeek = user.trainingDaysPerWeek || 3;
      if (newDay > daysPerWeek) { newDay = 1; newWeek++; }
      let newPhase = user.programmePhase || 1;
      const gymPhaseLen = newPhase === 5 ? 1 : 4;
      if (newWeek > gymPhaseLen) {
        newWeek = 1;
        if (newPhase >= 5) { newPhase = 1; } else { newPhase = newPhase + 1; }
      }
      await db.update(users).set({
        totalWorkoutsCompleted: newTotal,
        programmeDayInWeek: newDay,
        programmeWeek: newWeek,
        programmePhase: newPhase,
        lastWorkoutDate: new Date(),
      }).where(eq(users.phoneNumber, phone));
      await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true });

      const failNote = failedCount > 0
        ? ` ${failedCount} exercise${failedCount > 1 ? "s" : ""} you couldn't complete — reduce weight by 10% next session and build back up. That is progressive overload working correctly.`
        : warningCount > 0
          ? ` Watch the exercises you struggled with — form first, then add weight.`
          : "";
      gymLogReply = `${sessionType} session logged ✅${name ? ` — ${name}` : ""}. ${exCount} exercises done. Total sessions: ${newTotal}.${failNote}\n\nEat protein within 60 minutes — chicken, eggs, pilchards. Recovery starts now.`;
    } else {
      gymLogReply = `${sessionType} session already logged today. Keep the log — it shows your real numbers. Come back tomorrow.`;
    }
    await logChat(user.id, message, gymLogReply, "WORKOUT_LOG");
    return gymLogReply;
  }

  // ---- DONE — workout complete (direct) ----
  if (/^(done!*|i.?m done!*|im done!*|all done!*|workout done!*|finished!*|completed!*|session done!*|training done!*|workout completed!*|done with workout!*|done with my workout!*|done training!*)$/i.test(m.replace(/[.!?,]+$/, "").trim())) {
    const todayStart = sastDayStart();
    const alreadyLoggedToday = await db.select({ id: workoutLogs.id })
      .from(workoutLogs)
      .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, todayStart)))
      .limit(1);
    if (alreadyLoggedToday.length > 0) {
      const name = user.name || "there";
      return `${name}, today's session is already logged. One workout counted per day — come back tomorrow and keep the streak going.`;
    }

    const newTotal = (user.totalWorkoutsCompleted || 0) + 1;
    let newDay = (user.programmeDayInWeek || 1) + 1;
    let newWeek = user.programmeWeek || 1;
    const daysPerWeek = user.trainingDaysPerWeek || 3;

    if (newDay > daysPerWeek) { newDay = 1; newWeek++; }
    let newPhase = user.programmePhase || 1;
    const phaseLength = newPhase === 5 ? 1 : 4;
    let cycleCompleted = false;
    if (newWeek > phaseLength) {
      newWeek = 1;
      if (newPhase >= 5) { newPhase = 1; cycleCompleted = true; }
      else { newPhase = newPhase + 1; }
    }

    const lastW = user.lastWorkoutDate ? new Date(user.lastWorkoutDate) : null;
    const todayMidnight = sastDayStart();
    let newStreak = 1;
    if (lastW) {
      const lastDay = sastDayStart(new Date(lastW));
      const daysDiff = Math.floor((todayMidnight.getTime() - lastDay.getTime()) / 86400000);
      if (daysDiff >= 1 && daysDiff <= 2) newStreak = (user.workoutStreak || 0) + 1;
    }

    await db.update(users).set({
      totalWorkoutsCompleted: newTotal,
      lastWorkoutDate: new Date(),
      programmeDayInWeek: newDay,
      programmeWeek: newWeek,
      programmePhase: newPhase,
      workoutStreak: newStreak,
    }).where(eq(users.phoneNumber, phone));

    await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true });

    try {
      if ([5, 10, 20, 30, 50].includes(newStreak)) {
        await storeMemory(phone, `Workout streak milestone: ${newStreak} sessions in a row without missing`, "milestone");
      }
      if ([10, 25, 50, 100].includes(newTotal)) {
        await storeMemory(phone, `Workout total milestone: completed ${newTotal} training sessions total with Coach K`, "milestone");
      }
    } catch (e) { console.warn("[non-fatal]", e); }

    const celebrationFn = WORKOUT_DONE_RESPONSES[newTotal % WORKOUT_DONE_RESPONSES.length];
    const celebration = celebrationFn(newTotal, newDay);
    const perfectDay = await checkPerfectDay(user.id, user.proteinTarget || 130);

    if (!user.referralCode && [10, 25, 50].includes(newTotal)) {
      const namePrefix = (user.name || "KAM").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "K");
      let assigned = false;
      for (let attempt = 0; attempt < 5 && !assigned; attempt++) {
        const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
        const candidateCode = `${namePrefix}${randomSuffix}`;
        const existing = await db.select({ id: users.id }).from(users)
          .where(eq(users.referralCode, candidateCode)).limit(1);
        if (existing.length === 0) {
          await db.update(users).set({ referralCode: candidateCode }).where(eq(users.phoneNumber, phone));
          user.referralCode = candidateCode;
          assigned = true;
        }
      }
      if (!assigned) console.warn(`[REFERRAL] Could not assign unique code for ${phone} after 5 attempts`);
    }
    const refCode = user.referralCode;

    const clientFirstName = user.name || "there";
    const milestoneVoiceTexts: Record<number, string> = {
      25:  `${clientFirstName}, 25 workouts. A quarter century of sessions. You are not talking about fitness anymore. You are doing it.`,
      50:  `${clientFirstName}, 50 sessions. Fifty times you chose to show up when you could have stayed home. That is not motivation. That is discipline. Lekker work.`,
      100: `${clientFirstName}, one hundred workouts with Coach K. That number puts you in a category most people never reach. Whatever happens next — you earned this.`,
    };

    const milestoneNote = newTotal === 1
      ? `\n\n🏆 *First workout done.* Most people only talk about starting. You started. Screenshot this.`
      : newTotal === 3
        ? `\n\n🎯 *3 sessions in.* The research says: people who make it to 3 are 4× more likely to hit 30. You're on track.`
        : newTotal === 5
          ? `\n\n🔥 *5 workouts done.* High five. Some people joined the same day as you and have already quit. You haven't.`
          : newTotal === 10
            ? `\n\n🔥 *10 sessions with Coach K.* You are past the hardest part.${refCode ? ` Share code *${refCode}* with someone who needs to start — they get their first month for R50.` : " Send this to someone who said you would quit."}`
            : newTotal === 25
              ? `\n\n💪 *25 sessions completed.* A month of real work. This is a lifestyle now.${refCode ? ` Your referral code is *${refCode}* — share it with one person today.` : " Share your progress — you earned it."}`
              : newTotal === 50
                ? `\n\n🏆 *50 workouts done.* Half a century of sessions.${refCode ? ` Code *${refCode}* — put this number and your code in your family WhatsApp group.` : " Put this in your family WhatsApp group. Genuinely rare."}`
                : newTotal === 100
                  ? `\n\n🎯 *100 SESSIONS WITH COACH K.* Most people never reach 10. You hit 100. Share this.`
                  : "";

    const voiceText = milestoneVoiceTexts[newTotal];
    if (voiceText) {
      generateVoiceNote(voiceText).then(voiceUrl => {
        if (!voiceUrl) return;
        const fromNum = (process.env.TWILIO_WHATSAPP_NUMBER || "").startsWith("whatsapp:")
          ? process.env.TWILIO_WHATSAPP_NUMBER!
          : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
        const tc = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        tc.messages.create({ from: fromNum, to: phone, body: "🎙", mediaUrl: [voiceUrl] })
          .catch(err => console.error("[TTS] Milestone voice send error:", err));
      });
    }

    const streakLine = newStreak >= 30 ? `\n\n🔥 *${newStreak}-session streak. This is who you are now.*`
      : newStreak >= 14 ? `\n\n🔥 *${newStreak} sessions straight. Don't stop.*`
      : newStreak >= 7 ? `\n\n🔥 *7-session streak.* You are building a habit.`
      : newStreak >= 3 ? `\n\n🔥 Streak: ${newStreak}. Keep it going.`
      : "";
    const liftPrompt = newTotal >= 2
      ? `\n\n💡 *Log your lifts to track progress:* "bench 80kg 3x10", "squat 100kg x5", "deadlift 120kg"\nType *my lifts* anytime to see your all-time bests.`
      : newTotal === 1
      ? `\n\n💡 *Next session — log your weights* after each exercise: "bench 60kg 3x10". I track your progress week to week.`
      : "";
    const WORKOUT_SURPRISES = [
      "\n\n🌟 That session is in the bank. Nothing can take it back.",
      "\n\n⚡ You showed up. That's the whole game.",
      "\n\n🔑 Consistency > intensity. You're living proof.",
      "\n\n🏆 No one else did it for you. That was all you.",
      "\n\n💡 The body you're building is being built right now — session by session.",
    ];
    const workoutSurprise = Math.random() < 0.15 && !milestoneNote
      ? WORKOUT_SURPRISES[Math.floor(Math.random() * WORKOUT_SURPRISES.length)]
      : "";

    const cycleNote = cycleCompleted
      ? `\n\n🏆 *Full programme cycle complete.* Foundation → Build → Push → Peak → Deload — you did all of it.\n\nCycle 2 starts now. Same structure, heavier weights, shorter rests. Let's see what you're actually made of.`
      : newPhase === 5 && newWeek === 1
        ? `\n\n😮‍💨 *Deload week.* Drop weights by 40%, keep the movement. Your body repairs during this week — do not skip it.`
        : "";

    const goal = user.goalType || "fat_loss";
    const recoveryHook = goal === "muscle_gain"
      ? `\n\n🍚 *Eat now* — rice or pap + protein (eggs, chicken, pilchards). Within 30 minutes. This is the most important meal of your day.`
      : goal === "recomposition"
        ? `\n\n🥩 *Eat now* — protein + moderate carbs within 60 min. Your muscles need fuel to rebuild.`
        : `\n\n🥚 *Eat now* — protein within 60 min. Eggs, chicken, pilchards. Skip the extra carbs if you're sitting for the rest of the day.`;

    let doneReply = `${celebration}${milestoneNote}${cycleNote}${workoutSurprise}${streakLine}\n\n✅ Workout ${newTotal} logged.${recoveryHook}${perfectDay || ""}${liftPrompt}`;

    try {
      const daysPerWeekDelivery = user.trainingDaysPerWeek || 3;
      const updatedUser = { ...user, programmeDayInWeek: newDay, programmeWeek: newWeek };
      if (newTotal === 1) {
        doneReply += `\n\n---\n\n${buildDay2Workout(updatedUser)}`;
      } else if (newTotal === 2) {
        doneReply += `\n\n---\n\n${buildDay3Workout(updatedUser)}`;
      } else if (newTotal === 3 && daysPerWeekDelivery >= 4) {
        doneReply += `\n\n---\n\n${buildDayWorkout({ ...updatedUser, programmeDayInWeek: 4 })}`;
      }
    } catch (e) { console.warn("[day-delivery]", e); }

    return doneReply;
  }

  // ---- MY LIFTS — show all personal bests ----
  if (["my lifts", "my weights", "lifts", "personal best", "pb", "my pbs", "my records", "exercise log"].includes(m)) {
    try {
      const allLifts = await db.select().from(exerciseLogs)
        .where(eq(exerciseLogs.userId, user.id))
        .orderBy(desc(exerciseLogs.loggedAt));
      if (allLifts.length === 0) {
        return `No lifts logged yet. After a gym session send something like "bench 60kg 3x10" and I track your progress week to week.`;
      }
      const byExercise: Record<string, { recent: any; best: any }> = {};
      for (const lift of allLifts) {
        const ex = lift.exerciseName;
        if (!byExercise[ex]) byExercise[ex] = { recent: lift, best: lift };
        const liftWeight = parseFloat(String(lift.weightKg || 0));
        const bestWeight = parseFloat(String(byExercise[ex].best.weightKg || 0));
        if (liftWeight > bestWeight) byExercise[ex].best = lift;
      }
      const lines = Object.entries(byExercise).map(([ex, { recent, best }]) => {
        const recentW = parseFloat(String(recent.weightKg || 0));
        const bestW = parseFloat(String(best.weightKg || 0));
        const repsStr = recent.reps ? ` × ${recent.sets || 3}×${recent.reps}` : "";
        const pbStr = bestW > recentW ? ` (PB: ${bestW}kg)` : " 🏆 PB";
        return `• ${ex}: ${recentW}kg${repsStr}${pbStr}`;
      });
      const liftsReply = `*Your Lifts — Most Recent*\n\n${lines.join("\n")}\n\nTo log a lift: "bench 80kg 3x8", "squat 100kg x5", "deadlift 120kg"`;
      await logChat(user.id, message, liftsReply, "LIFTS_VIEW");
      return liftsReply;
    } catch (e) {
      console.error("[MY_LIFTS]", e);
      return `Log your lifts like this: "bench 60kg 3x10" and I track your progress.`;
    }
  }

  // ---- EXERCISE WEIGHT LOG — "bench 60kg 3x10", "squatted 80kg", "deadlift 120kg x5" ----
  const EXERCISE_DETECT = /\b(bench|chest press|squat|deadlift|dead lift|rdl|romanian|leg press|shoulder press|overhead press|ohp|military press|lat pulldown|pulldown|seated row|cable row|barbell row|bent over row|pull.?up|chin.?up|dip|hip thrust|glute bridge|leg curl|hamstring curl|leg extension|bicep curl|barbell curl|dumbbell curl|tricep|chest fly|cable fly|face pull|goblet squat|bulgarian|split squat|lunge|row)\b/i;
  const WEIGHT_KG = /\b(\d+(?:\.\d+)?)\s*kg\b/i;
  const isExerciseLog = EXERCISE_DETECT.test(m) && WEIGHT_KG.test(m) && user.trainingMode !== "walk_only";

  if (isExerciseLog) {
    const EXERCISE_MAP: Record<string, string> = {
      bench: "Bench Press", "chest press": "Bench Press",
      squat: "Squat", squatted: "Squat", squats: "Squat", "barbell squat": "Squat", "goblet squat": "Goblet Squat",
      deadlift: "Deadlift", "dead lift": "Deadlift",
      rdl: "Romanian Deadlift", romanian: "Romanian Deadlift",
      "leg press": "Leg Press",
      "shoulder press": "Shoulder Press", "overhead press": "Shoulder Press", ohp: "Shoulder Press", "military press": "Shoulder Press",
      "lat pulldown": "Lat Pulldown", pulldown: "Lat Pulldown",
      "seated row": "Seated Row", "cable row": "Seated Row",
      "barbell row": "Barbell Row", "bent over row": "Barbell Row",
      "pull up": "Pull Up", pullup: "Pull Up", "pull-up": "Pull Up",
      "chin up": "Chin Up", chinup: "Chin Up", "chin-up": "Chin Up",
      dip: "Weighted Dip",
      "hip thrust": "Hip Thrust", "glute bridge": "Glute Bridge",
      "leg curl": "Leg Curl", "hamstring curl": "Leg Curl",
      "leg extension": "Leg Extension",
      "bicep curl": "Bicep Curl", "barbell curl": "Bicep Curl", "dumbbell curl": "Bicep Curl", curl: "Bicep Curl",
      tricep: "Tricep Pushdown", "tricep pushdown": "Tricep Pushdown", "tricep extension": "Tricep Pushdown",
      "chest fly": "Chest Fly", "cable fly": "Chest Fly",
      "face pull": "Face Pull",
      bulgarian: "Bulgarian Split Squat", "split squat": "Bulgarian Split Squat",
      lunge: "Lunge", row: "Seated Row",
    };
    let exerciseName = "Exercise";
    for (const [key, val] of Object.entries(EXERCISE_MAP).sort((a, b) => b[0].length - a[0].length)) {
      if (m.includes(key)) { exerciseName = val; break; }
    }

    const weightMatch = m.match(/\b(\d+(?:\.\d+)?)\s*kg\b/i);
    const weightKg = weightMatch ? parseFloat(weightMatch[1]) : 0;
    if (weightKg > 0 && (weightKg < 0.5 || weightKg > 500)) {
      return `That weight reads as *${weightKg}kg* — looks like a typo. Send the lift again, e.g. "bench press 80kg 3x8".`;
    }
    if (!weightKg) { /* fall through to GPT */ } else {

    const setsRepsMatch = m.match(/\b(\d+)\s*[x×]\s*(\d+)\b/i) || m.match(/(\d+)\s*sets?\s*(?:of\s*)?(\d+)\s*reps?/i);
    const repsOnlyMatch = m.match(/\b[x×]\s*(\d+)\b/i) || m.match(/\b(\d+)\s*reps?\b/i);
    let sets: number | null = null;
    let reps: number | null = null;
    if (setsRepsMatch) { sets = parseInt(setsRepsMatch[1]); reps = parseInt(setsRepsMatch[2]); }
    else if (repsOnlyMatch) { reps = parseInt(repsOnlyMatch[1]); }

    const prevLogs = await db.select().from(exerciseLogs)
      .where(and(eq(exerciseLogs.userId, user.id), eq(exerciseLogs.exerciseName, exerciseName)))
      .orderBy(desc(exerciseLogs.loggedAt))
      .limit(5);

    try {
      await db.insert(exerciseLogs).values({ userId: user.id, exerciseName, weightKg: weightKg.toString(), reps: reps ?? undefined, sets: sets ?? undefined });
    } catch (e) { console.error("[EXERCISE_LOG]", e); }

    const repsStr = sets && reps ? ` ${sets}×${reps}` : reps ? ` ×${reps}` : "";
    let liftReply = "";
    if (prevLogs.length === 0) {
      liftReply = `${exerciseName} ${weightKg}kg${repsStr} logged. Baseline set — every session from here we track against this number. Add reps before adding weight. When you hit ${sets || 3}×${(reps || 10) + 2}, bump the weight by 2.5kg.`;
    } else {
      const prevWeight = parseFloat(String(prevLogs[0].weightKg || 0));
      const allTimeBest = Math.max(...prevLogs.map(l => parseFloat(String(l.weightKg || 0))));
      if (weightKg > allTimeBest) {
        liftReply = `🏆 *New PB — ${exerciseName} ${weightKg}kg${repsStr}.* Previous best was ${allTimeBest}kg. That is progressive overload working exactly as it should. Next session: hit the same weight for more reps before going heavier.`;
      } else if (weightKg > prevWeight) {
        liftReply = `${exerciseName} ${weightKg}kg${repsStr} — up ${(weightKg - prevWeight).toFixed(1)}kg from last time (${prevWeight}kg). Progressive overload on track. Keep adding reps at this weight until you can do ${(reps || 10) + 2} clean, then go heavier.`;
      } else if (weightKg === prevWeight) {
        liftReply = `${exerciseName} ${weightKg}kg${repsStr} logged. Same weight as last session — good. Focus on adding 1–2 reps today. When you hit ${sets || 3}×${(reps || 10) + 2} clean, add 2.5kg next session.`;
      } else {
        liftReply = `${exerciseName} ${weightKg}kg${repsStr} logged — ${(prevWeight - weightKg).toFixed(1)}kg under last time (${prevWeight}kg). Not every session is a PR. Focus on perfect form today and come back stronger next session.`;
      }
    }
    await logChat(user.id, message, liftReply, "EXERCISE_LOG");
    return liftReply;
    } // end weightKg else block
  }

  // ---- GOAL CHANGE: wants muscle but profile says fat loss / low calories ----
  const wantsMuscle = m.includes("gain weight") || m.includes("build muscle") || m.includes("gain muscle") || m.includes("i want to bulk") || m.includes("want to bulk") ||
    (m.includes("muscle") && (m.includes("want") || m.includes("focus on") || m.includes("goal is")));
  if (wantsMuscle && (user.goalType === "fat_loss" || (user.calorieTarget || 0) < 1800)) {
    const bw = parseFloat(user.currentWeight || "75");
    const { calorieTarget: newCals, proteinTarget: newProtein } = calculateTargets(bw, "muscle_gain", user.lifeSituation || "office", user.trainingDaysPerWeek || 3);
    await db.update(users).set({ goalType: "muscle_gain", calorieTarget: newCals, proteinTarget: newProtein }).where(eq(users.phoneNumber, phone));
    ctx.user.goalType = "muscle_gain";
    ctx.user.calorieTarget = newCals;
    ctx.user.proteinTarget = newProtein;
  }

  // ---- WEIGHT UPDATE (explicit) — "I weigh 83kg", "my weight is 83kg", bare "83kg" ----
  const isExplicitWeight = /\b(weigh|weight is|weight now|weighed|weighed in|i am|i'm|my weight|scale says|scale said|came in at)\b/.test(m) || /^\d{2,3}(\.\d)?\s*kg[.!]?$/.test(m.trim()) || /\b\d{2,3}(\.\d)?\s*kg\b/.test(m);
  const explicitKgMatch = m.match(/\b(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg|kilos?)?\b/);
  if (isExplicitWeight && explicitKgMatch) {
    const newKg = parseFloat(explicitKgMatch[1]);
    if (newKg >= 35 && newKg <= 250) {
      const weightReply = await handleWeightLog(phone, user, newKg);
      await logChat(user.id, message, weightReply, "WEIGHT_LOG");
      return weightReply;
    }
  }

  // Passive weight mention guard removed — caused false positives ("my friend weighs 85kg",
  // "the bar is 20kg"). Explicit weight logging via handleWeightLog covers the real case.

  // ---- PROGRAMME SETUP REPLY — detect "3 intermediate lose fat" style answers ----
  const hasDayCount = /\b[3-5]\b/.test(m);
  const hasExpWord = m.includes("beginner") || m.includes("intermediate") || m.includes("advanced");
  const hasGoalWord = m.includes("lose") || m.includes("fat") || m.includes("muscle") || m.includes("both") || m.includes("recomp");

  if (hasDayCount && (hasExpWord || hasGoalWord)) {
    const dayMatch = m.match(/\b([3-5])\b/);
    const days = dayMatch ? parseInt(dayMatch[1]) : 3;

    let exp = "beginner";
    if (m.includes("intermediate")) exp = "intermediate";
    if (m.includes("advanced")) exp = "advanced";

    let goal = "fat_loss";
    if ((m.includes("muscle") || m.includes("build")) && !m.includes("lose") && !m.includes("fat")) goal = "muscle_gain";
    if (m.includes("both") || m.includes("recomp")) goal = "recomposition";

    await db.update(users).set({
      trainingDaysPerWeek: days,
      trainingExperience: exp,
      goalType: goal,
    }).where(eq(users.phoneNumber, phone));

    const updatedUser = { ...user, trainingDaysPerWeek: days, trainingExperience: exp, goalType: goal };
    const day1 = buildFullProgramme(updatedUser);
    const goalLabel = goal === "fat_loss" ? "Fat loss" : goal === "muscle_gain" ? "Muscle gain" : "Body recomposition";

    return `Sharp. ${days} days/week. ${exp.charAt(0).toUpperCase() + exp.slice(1)}. ${goalLabel}. Here is Day 1 — send *done* when finished to unlock Day 2.\n\n${day1}`;
  }

  // ---- EXPLICIT WORKOUT COMMANDS — hardcoded, never touch GPT ----
  const todayWorkoutPhrases = ["today", "today's workout", "todays workout", "workout today", "my workout", "show workout", "give me workout"];
  const fullProgrammePhrases = ["workouts", "my workouts"];
  if (todayWorkoutPhrases.includes(m)) {
    try {
      const workout = buildDayWorkout(user);
      const dayNum = user.programmeDayInWeek || 1;
      const week = user.programmeWeek || 1;
      const totalSessions = user.totalWorkoutsCompleted || 0;
      const poCtx = await getProgressiveOverloadContext(user.id);
      const sessionNote = totalSessions > 0 ? ` | Session ${totalSessions + 1}` : "";
      const workoutGif = getPrimaryWorkoutGifUrl(workout);
      const gifTag = workoutGif ? `\n[MEDIA:${workoutGif}]` : "";
      const r = `*Week ${week}${sessionNote}*\n\n${poCtx}*Day ${dayNum} — Your Workout Today*\n\n${workout}\n\nSend *done* when finished. Log lifts: "bench 80kg 3x10"${gifTag}`;
      await logChat(user.id, message, r.replace(/\[MEDIA:[^\]]+\]/, "").trim(), "WORKOUT_VIEW");
      return r;
    } catch (e) {
      console.error("[TODAY_WORKOUT]", e);
      return getKamlifeProgramme(user);
    }
  }
  if (fullProgrammePhrases.includes(m)) {
    try {
      const prog = getKamlifeProgramme(user);
      const r = `Your programme:\n\n${prog}`;
      await logChat(user.id, message, r, "PROGRAMME_VIEW");
      return r;
    } catch (e) {
      console.error("[WORKOUTS_VIEW]", e);
      return "Send *programme* to see your full workout plan.";
    }
  }

  // ---- PHOTO CORRECTION / CLARIFICATION ----
  const photoCorrectionMatch =
    /\b(?:it'?s|that'?s|this\s+is|that\s+was|it\s+was)\s+(?:just\s+)?(?:a|an|the|my)?\s*(?:photo|pic|picture|image|snap|screenshot|shot)\s+(?:of|showing|is|was)\b/i.test(m)
    || /\b(?:it'?s|that'?s|this\s+is)\s+(?:a|an|my)\s+[a-z]+\s+(?:photo|pic|picture|image)\b/i.test(m)
    || /\b(?:photo|pic|picture|image)\s+(?:shows?|showing|of)\s+(?:an?\s+|my\s+|the\s+)?(?:exercise|workout|gym|food|meal|steps?|progress)\b/i.test(m);

  if (photoCorrectionMatch) {
    const isExercisePhoto = /\b(exercise|workout|gym|training|lift(?:ing)?|squat|bench|deadlift|press|curl|row|form)\b/.test(m);
    const isFoodPhoto = /\b(food|meal|breakfast|lunch|dinner|supper|snack|plate|eating)\b/.test(m);
    const isStepsPhoto = /\b(steps?|pedometer|fitbit|fitness\s*tracker|step\s*count)\b/.test(m);
    const isProgressPhoto = /\b(progress|mirror|scale|transformation|body\s*shot)\b/.test(m);

    let correctionReply = "";
    if (isExercisePhoto) {
      correctionReply = `Got you — an exercise photo. I cannot give form feedback from a still shot (need a short video for that), but I can help you:\n\n• Log the lift: e.g. "bench 80kg 3x10"\n• Log the session: send *done* when finished\n• See today's session: text *today*`;
    } else if (isFoodPhoto) {
      correctionReply = `Got it — a food photo. Re-send it with a quick caption so I know what to log, e.g. "lunch — chicken and rice". That way I can count kilojoules properly.`;
    } else if (isStepsPhoto) {
      correctionReply = `Sharp — a steps photo. Just text me the number, e.g. "8500 steps" and I will log it straight away.`;
    } else if (isProgressPhoto) {
      correctionReply = `Got you — progress photo noted. Keep them coming weekly, same angle, same lighting. Send *progress* anytime to see your trend.`;
    } else {
      correctionReply = `Got it — thanks for the heads-up. Can you re-send the photo with a short caption so I know how to log it? E.g. "lunch", "8500 steps", "squat form".`;
    }
    await logChat(user.id, message, correctionReply, "PHOTO_CORRECTION");
    return correctionReply;
  }

  // ---- PROGRAMME REQUEST WITHOUT PROFILE — check for elderly/injury first ----
  const wordCount_prog = m.split(/\s+/).length;
  const hasComplaintAboutProgram = /\b(you gave|you give|you sent|giving me|gave me|sending me|i got|i received|got a|received a)\b.{0,25}\b(programme|program|workout|plan)\b/i.test(m)
    || /\b(that|the|your|this)\s+(programme|program|workout|plan)\b.{0,30}\b(useless|wrong|bad|terrible|generic|not right|not what|didn't|didn.?t)\b/i.test(m);
  const hasFrustrationSignal_prog = /\b(no no|that.?s not|not true|not right|wrong|terrible|rubbish|nonsense|what the hell|useless|crap|ridiculous|garbage|stupid|shut down|pathetic)\b/i.test(m);
  const hasFoodLogSignal_prog = /\b(ate|had|have|having|eating|breakfast|lunch|dinner|supper|snack|for breakfast|for lunch|for dinner|pre.?workout|post.?workout|before\s+(gym|training|workout)|after\s+(gym|training|workout))\b/.test(m);
  const wordMatchesWorkout = /\b(workout|workouts|programme|program|training\s+plan|workout\s+plan|exercise\s+plan|full\s+body|exercise|training)\b/.test(m);
  const isWorkoutRelated =
    !hasComplaintAboutProgram &&
    wordCount_prog <= 25 &&
    !hasFrustrationSignal_prog &&
    !hasFoodLogSignal_prog &&
    (
      m === "1" || m === "2" || m === "gym" || m === "workout" || m === "workouts" ||
      /\b\d\s*day\b/.test(m) ||
      wordMatchesWorkout ||
      (m.includes("gym") && /\b(need|want|give|plan|programme|program)\b/.test(m))
    );

  // ---- ELDERLY / SERIOUS INJURY ----
  const elderlyAge = m.match(/\bi'?m\s+(6[0-9]|7[0-9]|8[0-9]|9[0-9])\b/i) ||
    m.match(/\b(6[0-9]|7[0-9]|8[0-9]|9[0-9])\s*(year|yr|yo)\b/i) ||
    m.match(/\bage\s+(6[0-9]|7[0-9]|8[0-9]|9[0-9])\b/i);
  const isElderly = !!(elderlyAge || m.includes("elderly") || m.includes("old age") || m.includes("pensioner") || m.includes("senior citizen"));
  const hasSeriousInjury = m.includes("hip replacement") || m.includes("knee replacement") ||
    m.includes("hip surgery") || m.includes("hip problem") || m.includes("bad hip") ||
    m.includes("serious injury") || m.includes("cannot walk") || m.includes("can't walk");

  if ((isElderly || hasSeriousInjury) && isWorkoutRelated) {
    const ageStr = elderlyAge ? elderlyAge[1] : "";
    const prefix = hasSeriousInjury && !isElderly
      ? `With a serious injury, safety is everything.`
      : `At ${ageStr || "your age"} with${hasSeriousInjury ? " a hip problem" : " your history"}, safety is everything.`;
    return `${prefix} This programme builds real strength without risk. Any pain or discomfort — stop immediately and consult your doctor.\n\n*Safety-First Strength Programme — Seated and Machine Only*\nRest 90 seconds between sets. 3 sets of 15 reps. Light weight.\n\n1️⃣ *Seated Leg Press — light weight*\nhttps://www.youtube.com/results?search_query=seated+leg+press+light+weight+elderly\nFeet flat on platform. Push slowly. Never lock the knees.\n\n2️⃣ *Seated Leg Curl Machine*\nhttps://www.youtube.com/results?search_query=seated+leg+curl+machine+tutorial\nSlow and controlled. Only move through pain-free range.\n\n3️⃣ *Chest Press Machine — seated*\nhttps://www.youtube.com/results?search_query=chest+press+machine+tutorial+seniors\nBack flat against pad. Press gently. No locking at the top.\n\n4️⃣ *Seated Cable Row*\nhttps://www.youtube.com/results?search_query=seated+cable+row+elderly+tutorial\nSit tall. Pull elbows back slowly. Keep shoulders down.\n\n5️⃣ *Seated Shoulder Press Machine*\nhttps://www.youtube.com/results?search_query=seated+shoulder+press+machine+seniors\nPress overhead slowly. Stop if any shoulder pain.\n\n6️⃣ *Seated Calf Raise*\nhttps://www.youtube.com/results?search_query=seated+calf+raise+machine+tutorial\nHeel up slowly, lower slowly. Excellent for circulation.\n\n7️⃣ *Balance Work — standing at fixed support*\nHold a wall or fixed bar. Rise slowly onto toes and lower. 3 × 10. Builds ankle stability.\n\nTrain 2 to 3 times per week with at least one rest day between sessions. Reply DONE after each session and I track your progress.`;
  }

  if (isWorkoutRelated && user.trainingDaysPerWeek && user.trainingExperience && user.goalType) {
    const programme = buildFullProgramme(user);
    const modeLabel = user.trainingMode === "gym" ? "Gym" : "Home";
    const reply = `${modeLabel} programme — ${user.trainingDaysPerWeek} days per week, ${user.trainingExperience} level, ${(user.goalType || "").replace(/_/g, " ")} focus.\n\n${programme}`;
    await logChat(user.id, message, reply, "PROGRAMME_DELIVERY");
    return reply;
  }

  if (isWorkoutRelated && (!user.trainingExperience || !user.trainingDaysPerWeek)) {
    await db.update(users).set({ awaitingProgrammeAnswers: true }).where(eq(users.phoneNumber, phone));
    const question = `Sharp. How many days can you train and are you at gym or home?`;
    await logChat(user.id, message, question, "PROGRAMME_QUESTIONS");
    return question;
  }

  return null;
}
