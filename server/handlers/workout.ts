/**
 * Workout-related commands: gym log, done, my lifts, exercise weight log,
 * goal change, weight update/mention, programme setup, photo correction,
 * elderly/injury programme, programme delivery.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { users, workoutLogs, exerciseLogs } from "../../shared/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import {
  buildDayWorkout, buildDay2Workout, buildDay3Workout,
  buildFullProgramme, getKamlifeProgramme, WORKOUT_DONE_RESPONSES,
} from "../programme";
import { checkPerfectDay, getProgressiveOverloadContext } from "./checks";
import { storeMemory } from "../memory";
import { generateVoiceNote } from "../tts";
import { generateMilestoneVoiceScript } from "../gpt";
import { logChat } from "./chat-log";
import { sastDayStart } from "../utils";
import { handleWeightLog } from "./weight";
import { calculateTargets } from "../targets";
import { getPrimaryWorkoutGifUrl } from "../exercise-media";
import { sendWhatsApp, saveState } from "../scheduler/shared";

// Exercise name keywords used to identify lift-format messages
const EXERCISE_PATTERN = /\b(?:bench\s*press?|squat|deadlift|leg\s*press?|leg\s*curl|leg\s*extension|hip\s*thrust|rdl|romanian|lunge|lateral\s*raise|shoulder\s*press?|overhead\s*press?|lat\s*pull[- ]?down|seated\s*row|cable\s*row|face\s*pull|bicep\s*curl|tricep|pushdown|push[- ]?up|pull[- ]?up|dip|plank|fly|chest\s*press?|incline|decline|cable|barbell|dumbbell|db|calf\s*raise|glute|hip|press)\b/i;

function parseLiftLog(m: string): Array<{ name: string; weight: number; sets?: number; reps?: number }> {
  const results: Array<{ name: string; weight: number; sets?: number; reps?: number }> = [];

  const parts = m.split(/\s*(?:,\s*|\s+and\s+)/i);
  for (const part of parts) {
    const trimmed = part.trim();
    // {exercise words} {weight}[kg] [{sets}x{reps}]
    const match = trimmed.match(
      /^([a-z][a-z\s\-]{1,30}?)\s+(\d+(?:\.\d+)?)\s*(?:kg|kgs?)?\s*(?:(\d+)\s*[x×]\s*(\d+))?\s*$/i,
    );
    if (!match) continue;

    const name = match[1].trim().toLowerCase().replace(/\s+/g, " ");
    const weight = parseFloat(match[2]);
    const sets = match[3] ? parseInt(match[3]) : undefined;
    const reps = match[4] ? parseInt(match[4]) : undefined;

    if (
      name.length < 2
      || !Number.isFinite(weight)
      || weight < 1
      || weight > 500
      || /\b(?:water|steps?|sleep|slept|ate|had|food|weigh|today|morning|kg\s*body|i(?:'m| am)|body)\b/i.test(name)
      || !EXERCISE_PATTERN.test(name + " " + trimmed)
    ) continue;

    results.push({ name, weight, sets, reps });
  }

  return results;
}

export async function handleWorkoutCommands(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
}): Promise<string | null> {
  const { phone, message, m, user } = ctx;
  const firstName = user.name?.split(" ")[0] || "";

  // ---- "MY LIFTS" — show recent exercise history ----
  if (["my lifts", "lifts", "lift history", "my lift history", "my exercises", "exercise history"].includes(m)) {
    const recent = await db.select().from(exerciseLogs)
      .where(eq(exerciseLogs.userId, user.id))
      .orderBy(desc(exerciseLogs.loggedAt))
      .limit(30);
    if (recent.length === 0) {
      return `No lifts logged yet. After your workout, send "done" then log lifts — e.g. "bench 80kg 3x10".`;
    }
    const seen = new Map<string, typeof recent[0]>();
    for (const lift of recent) {
      if (!seen.has(lift.exerciseName)) seen.set(lift.exerciseName, lift);
    }
    const lines = [...seen.values()].map(lift => {
      const w = parseFloat(String(lift.weightKg || 0));
      const setsReps = lift.sets && lift.reps ? ` ${lift.sets}×${lift.reps}` : lift.reps ? ` ×${lift.reps}` : "";
      const next = (w + 2.5).toFixed(1).replace(".0", "");
      return `• ${lift.exerciseName}: *${w}kg${setsReps}* → aim ${next}kg next`;
    });
    return `*Last logged lifts:*\n\n${lines.join("\n")}\n\n_Log today's lifts: "bench 80kg 3x10"_`;
  }

  // ---- WEIGHT LOG — standalone "84kg" or brief weight check-in ----
  // Only fires if message is clearly about body weight, not exercise weight
  const isStandaloneWeight = /^(\d{2,3}(?:\.\d+)?)\s*kg[.!]?$/i.test(m);
  const isWeightCheckIn = (
    /\b(?:weigh(?:ed|s|ing)?|morning weight|body weight|on the scale|scale said|scale reads|weighed in|my weight)\b.*\b(\d{2,3}(?:\.\d+)?)\s*kg\b/i.test(m)
    || /\b(\d{2,3}(?:\.\d+)?)\s*kg\b.*\b(?:today|this morning|just weighed)\b/i.test(m)
  );

  if ((isStandaloneWeight || isWeightCheckIn) && !EXERCISE_PATTERN.test(m)) {
    const kgMatch = m.match(/(\d{2,3}(?:\.\d+)?)\s*kg/i);
    if (kgMatch) {
      const kg = parseFloat(kgMatch[1]);
      if (Number.isFinite(kg) && kg >= 30 && kg <= 250) {
        return handleWeightLog(phone, user, kg);
      }
    }
  }

  // ---- WORKOUT DONE — log completion ----
  const isDone = (
    /^(done|finished|complete|completed|trained)[.!?]?$/i.test(m)
    || /^(?:workout|session|training|gym)\s+(?:done|complete|finished)[.!?]?$/i.test(m)
    || /^(?:just\s+)?(?:done|finished)\s+(?:my\s+)?(?:workout|session|training|gym)[.!?]?$/i.test(m)
    || m === "done today" || m === "finished today"
  ) && !/\b(?:steps?|km|walked|walk)\b/i.test(m)
    && !/\b(?:ate|had|food|meal|eaten|eating|calories)\b/i.test(m);

  if (isDone) {
    const todayStart = sastDayStart();
    const existing = await db.select({ id: workoutLogs.id }).from(workoutLogs)
      .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, todayStart)))
      .limit(1);

    if (existing.length > 0) {
      const poCtx = await getProgressiveOverloadContext(user.id);
      return `${firstName ? firstName + ", " : ""}workout already logged today.${poCtx ? "\n\n" + poCtx.trim() : ""}\n\nLog your lifts: "bench 80kg 3x10" or ask for tomorrow's session.`;
    }

    await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true });

    const newTotal = (user.totalWorkoutsCompleted || 0) + 1;
    const trainingDays = user.trainingDaysPerWeek || 3;
    const currentDay = user.programmeDayInWeek || 1;
    const nextDay = (currentDay % trainingDays) + 1;
    const weekAdvance = nextDay === 1;
    const newWeek = weekAdvance ? (user.programmeWeek || 1) + 1 : (user.programmeWeek || 1);

    // Workout streak calculation
    const lastWorkout = user.lastWorkoutDate ? new Date(user.lastWorkoutDate) : null;
    const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const yesterdayStart = dayStart(new Date(Date.now() - 86_400_000));
    const wasYesterday = lastWorkout && dayStart(lastWorkout) === yesterdayStart;
    const newStreak = wasYesterday ? (user.workoutStreak || 0) + 1 : 1;

    await db.update(users).set({
      totalWorkoutsCompleted: newTotal,
      programmeDayInWeek: nextDay,
      programmeWeek: newWeek,
      lastWorkoutDate: new Date(),
      lastActiveAt: new Date(),
      workoutStreak: newStreak,
    }).where(eq(users.phoneNumber, phone));

    const doneResponse = WORKOUT_DONE_RESPONSES[newTotal % WORKOUT_DONE_RESPONSES.length](newTotal, currentDay);

    let milestoneMsg = "";
    const MILESTONE_TEXTS: Record<number, string> = {
      1:   `\n\n🎉 *Session 1 — done.* The hardest one is always the first. Every one from here is proof you're not just talking about it.`,
      3:   `\n\n🔥 *3 sessions in.* The habit is starting. Most people who hit 3 make it to 10.`,
      5:   `\n\n🔥 *5 sessions.* You've officially started. Some people joined the same day and have already quit — you haven't.`,
      10:  `\n\n🏆 *10 sessions done.* Most people never get here. The habit is forming. Don't stop now.`,
      25:  `\n\n🏆 *25 workouts.* A quarter century of sessions. You are not talking about fitness anymore — you are doing it.`,
      50:  `\n\n🏆 *50 sessions.* Fifty times you showed up when you could have stayed home. That is not motivation — that is discipline.`,
      100: `\n\n🏆 *100 workouts.* One hundred sessions. Whatever happens next — you earned this.`,
    };

    if (MILESTONE_TEXTS[newTotal]) {
      milestoneMsg = MILESTONE_TEXTS[newTotal];

      if ([25, 50, 100].includes(newTotal)) {
        const updatedUser = { ...user, totalWorkoutsCompleted: newTotal };
        generateMilestoneVoiceScript(updatedUser, "workout_sessions", { sessions: newTotal })
          .then(script => generateVoiceNote(script))
          .then(url => { if (url) return sendWhatsApp(phone, "", url); })
          .catch(err => console.warn("[TTS] Workout milestone voice failed:", err));
      }

      try {
        saveState(`workout_milestone_${newTotal}_${user.id}`, "sent");
      } catch { /* non-fatal */ }
    }

    const perfectDay = await checkPerfectDay(user.id, user.proteinTarget || 130);

    await logChat(user.id, message, doneResponse, "WORKOUT_DONE");

    return `${doneResponse}${milestoneMsg}${perfectDay || ""}\n\nLog your lifts: "bench 80kg 3x10" (or skip if cardio/bodyweight)[BUTTONS:Log my lifts|Tomorrow's session|Log food]`;
  }

  // ---- LIFT LOG — parse and store exercise data ----
  const lifts = parseLiftLog(m);
  if (lifts.length > 0) {
    const inserts = lifts.map(lift =>
      db.insert(exerciseLogs).values({
        userId: user.id,
        exerciseName: lift.name,
        weightKg: lift.weight.toString(),
        sets: lift.sets,
        reps: lift.reps,
      }),
    );
    await Promise.all(inserts);

    const lines = lifts.map(lift => {
      const setsReps = lift.sets && lift.reps ? ` ${lift.sets}×${lift.reps}` : lift.reps ? ` ×${lift.reps}` : "";
      const next = (lift.weight + 2.5).toFixed(1).replace(".0", "");
      return `${lift.name}: *${lift.weight}kg${setsReps}* → aim *${next}kg* or +1 rep next session`;
    });

    return `Logged 💪\n\n${lines.join("\n")}\n\n_I'll show these targets before your next session._`;
  }

  // ---- GOAL CHANGE ----
  const goalChangeMatch = m.match(/\b(?:change|switch|update|new)\s+(?:my\s+)?goal\s+to\s+(fat[\s_]?loss|lose\s+weight|cut|muscle[\s_]?gain|muscle|build|bulk|maintenance|maintain|recomp(?:osition)?)\b/i);
  if (goalChangeMatch) {
    const raw = goalChangeMatch[1].toLowerCase();
    const goalType = /fat|lose|cut/.test(raw) ? "fat_loss"
      : /muscle|build|bulk/.test(raw) ? "muscle_gain"
      : /recomp/.test(raw) ? "recomposition"
      : "maintenance";
    const goalLabels: Record<string, string> = {
      fat_loss: "Fat Loss",
      muscle_gain: "Muscle Gain",
      recomposition: "Recomposition",
      maintenance: "Maintenance",
    };
    const currentWt = parseFloat(String(user.currentWeight || "0")) || 75;
    const newTargets = calculateTargets(currentWt, goalType, user.lifeSituation || "office", user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, user.heightCm || 170);
    await db.update(users).set({ goalType, calorieTarget: newTargets.calorieTarget, proteinTarget: newTargets.proteinTarget }).where(eq(users.phoneNumber, phone));
    const label = goalLabels[goalType] || goalType;
    return `Goal updated to *${label}*.\n\nTargets adjusted: ${newTargets.calorieTarget} kcal/day | ${newTargets.proteinTarget}g protein.\n\n${goalType === "muscle_gain" ? "Eat in a slight surplus. Hit protein every meal. Push weights up every session." : goalType === "fat_loss" ? "Stay in your calorie range. Hit protein first — it preserves muscle while cutting." : "Hold calories at maintenance. Weight training stays the same."}`;
  }

  return null;
}
