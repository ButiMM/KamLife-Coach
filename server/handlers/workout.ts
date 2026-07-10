/**
 * Workout-related commands: gym log, done, my lifts, exercise weight log,
 * goal change, weight update/mention, programme setup, photo correction,
 * elderly/injury programme, programme delivery.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { users, workoutLogs, exerciseLogs, stepLogs, chatHistory } from "../../shared/schema";
import { eq, and, gte, lt, desc } from "drizzle-orm";
import { classifyWorkoutFeedback, workoutFeedbackReply } from "../workout-feedback";
import {
  buildDayWorkout,
  buildFullProgramme, getKamlifeProgramme, WORKOUT_DONE_RESPONSES,
  cleanExerciseName,
} from "../programme";
import { checkPerfectDay, getProgressiveOverloadContext } from "./checks";
import { storeMemory } from "../memory";
import { generateVoiceNote } from "../tts";
import { generateMilestoneVoiceScript } from "../gpt";
import { logChat } from "./chat-log";
import { sastDayStart, parseMealDate, mealDateLabel, isFutureIntent, looksLikeQuestion, mentionsNotDone } from "../utils";
import { invalidatePatternCache } from "../cache";
import { getTodayWorkoutState, getTodaySlot } from "../workout-state";
import { handleWeightLog } from "./weight";
import { calculateTargets } from "../targets";
import { getPrimaryWorkoutGifUrl } from "../exercise-media";
import { sendWhatsApp, saveState } from "../scheduler/shared";

// Exercise name keywords used to identify lift-format messages
const EXERCISE_PATTERN = /\b(?:bench\s*press?|squat|deadlift|leg\s*press?|leg\s*curl|leg\s*extension|hip\s*thrust|rdl|romanian|lunge|lateral\s*raise|shoulder\s*press?|overhead\s*press?|ohp|lat\s*pull[- ]?down|seated\s*row|cable\s*row|face\s*pull|bicep\s*curl|tricep|pushdown|push[- ]?ups?|pull[- ]?ups?|chin[- ]?ups?|dip|plank|fly|chest\s*press?|incline|decline|cable|barbell|bb|dumbbell|db|calf\s*raise|glute|hip|press|rows?|rdls?|step\s*up|abduction|adduction|pull\s*through|hip\s*hinge)\b/i;

export function parseLiftLog(m: string): Array<{ name: string; weight: number; sets?: number; reps?: number }> {
  const results: Array<{ name: string; weight: number; sets?: number; reps?: number }> = [];

  const parts = m.split(/\s*(?:,\s*|\s+and\s+)/i);
  for (const part of parts) {
    const trimmed = part.trim();
    // {exercise words} {weight}[kg] [{sets}x{reps}]
    const match = trimmed.match(
      /^([a-z][a-z\s\-]{1,30}?)\s+(\d+(?:\.\d+)?)\s*(?:kg|kgs?)?\s*(?:(\d+)\s*[x×]\s*(\d+))?\s*$/i,
    );
    if (!match) continue;

    const rawName = match[1].trim().toLowerCase().replace(/\s+/g, " ");
    const name = cleanExerciseName(rawName) || rawName;  // "my chest fly is" → "chest fly"
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
    ) continue;  // weight >500 (fat-finger) already handled above; a heavy machine fly is REAL and kept

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

  // ---- WORKOUT DIFFICULTY FEEDBACK — the post-session "how was it?" loop ----
  // Only interpret "too easy / just right / too hard" as session feedback when a
  // workout was actually delivered or logged in the last 6 hours, and the message
  // isn't about food/money/the app. This recency gate is what keeps "this diet is
  // too hard" from being misread as workout feedback — no state machine needed.
  const feedbackKind = classifyWorkoutFeedback(m);
  if (
    feedbackKind
    && !/\b(diet|eat|eating|food|meal|protein|carbs?|expensive|money|afford|app|bot|coach|subscription|price|pay)\b/i.test(m)
    && (m.split(/\s+/).length <= 8 || /\b(workout|session|training|gym|that|it|today)\b/i.test(m))
  ) {
    const sixHoursAgo = new Date(Date.now() - 6 * 3600_000);
    const recent = await db.select({ intent: chatHistory.intent }).from(chatHistory)
      .where(and(eq(chatHistory.userId, user.id), gte(chatHistory.createdAt, sixHoursAgo)))
      .orderBy(desc(chatHistory.createdAt)).limit(12);
    const hadWorkout = recent.some(r => ["WORKOUT_DONE", "WORKOUT_VIEW", "WORKOUT_MISSED_CATCHUP", "WORKOUT_HOLIDAY"].includes(r.intent || ""));
    if (hadWorkout) {
      const reply = workoutFeedbackReply(feedbackKind, firstName);
      storeMemory(phone, `Workout difficulty: last session felt "${feedbackKind.replace("_", " ")}"`, "workout").catch(() => {});
      await logChat(user.id, message, reply, "WORKOUT_FEEDBACK");
      return reply;
    }
  }

  // ---- "MY LIFTS" — show recent exercise history ----
  if (["my lifts", "lifts", "lift history", "my lift history", "my exercises", "exercise history", "log my lifts"].includes(m)) {
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
  // Retrospective brake: "I weighed 83kg last week", "I started at 95kg", "used to be 90kg"
  // are HISTORICAL — they must not overwrite today's weight or recalc targets off a past number.
  const isRetrospectiveWeight = /\b(last\s+(?:week|month|year|time)|used\s+to|back\s+(?:then|in|when)|previously|a\s+(?:week|month|year)\s+ago|(?:weeks?|months?|years?)\s+ago|started\s+(?:at|on|out|off)|when\s+i\s+(?:started|began))\b/i.test(m);

  // Question brake: "I weighed 84kg, is that too much?" / "84kg today?" is asking —
  // logging it silently recalculates calorie & protein targets and can flip the goal,
  // all off a message the user framed as a question. Let it reach GPT; a clean "84kg"
  // still logs.
  if ((isStandaloneWeight || isWeightCheckIn) && !isRetrospectiveWeight && !looksLikeQuestion(m) && !EXERCISE_PATTERN.test(m)) {
    const kgMatch = m.match(/(\d{2,3}(?:\.\d+)?)\s*kg/i);
    if (kgMatch) {
      const kg = parseFloat(kgMatch[1]);
      if (Number.isFinite(kg) && kg >= 30 && kg <= 250) {
        return handleWeightLog(phone, user, kg);
      }
    }
  }

  // ---- CARDIO LOG — running, walking, cycling, yoga, HIIT, Zumba, parkrun, etc. ----
  // Fat-loss clients (the majority) do cardio-only sessions that isDone/EXERCISE_PATTERN never catches.
  // Catches these and logs a workout session + converts km distance to step count where applicable.
  // Question/future guard: "Should I do 30 min yoga?" / "is 5km good?" / "going to run 5km
  // tomorrow" must NOT auto-log a completed session — those reach GPT for coaching instead.
  // Negation guard: "I couldn't run 5km", "missed my 5km", "skipped my run" report a
  // MISS — the bare-distance branch below would otherwise log a full session and
  // advance the programme off a run that never happened.
  const isCardioLog = !looksLikeQuestion(m) && !isFutureIntent(m) && !mentionsNotDone(m) && (
    // "went for a {activity}"
    /\b(?:went\s+for\s+(?:a\s+)?(?:run|jog|walk|swim|cycle|hike))\b/i.test(m)
    // "I ran / jogged / cycled / swam" (exercise-specific verbs — no context required)
    || /\b(?:i(?:\s+just)?)\s+(?:ran|jogged|cycled|biked|swam|hiked)\b/i.test(m)
    // "I walked + km distance" (require distance to distinguish from "walked to kitchen")
    || (/\bi(?:\s+just)?\s+walked\b/i.test(m) && /\b\d+(?:\.\d+)?\s*km\b/i.test(m))
    // "did / done / finished / completed [a] {cardio activity}"
    || /\b(?:just\s+)?(?:did|done|finished|completed)\s+(?:a\s+|my\s+)?(?:run|jog|walk|swim|hike|hiit|yoga|pilates|zumba|spinning|bootcamp|crossfit|aerobics|cardio|parkrun|park\s*run|gym\s*class|fitness\s*class|dance\s*class)\b/i.test(m)
    // Stand-alone cardio declarations: "parkrun", "HIIT done", "yoga class"
    || /^(?:hiit|yoga|pilates|zumba|spinning|parkrun|park\s*run|bootcamp|crossfit|aerobics)(?:\s+(?:done|complete[d]?|finished|class|session|today))?[.!?]?\s*$/i.test(m)
    // "{X}km" — distance-based logging (run/walk/cycle)
    || /\b\d+(?:\.\d+)?\s*km\b/i.test(m)
    // "X minutes of {cardio type}" or "{cardio type} X minutes"
    || /\b\d+\s*(?:min(?:utes?)?)\s+(?:of\s+)?(?:cardio|running|jogging|walking|yoga|hiit|zumba|cycling|spinning|aerobics)\b/i.test(m)
    || /\b(?:cardio|running|jogging|yoga|hiit|zumba|cycling|spinning|aerobics)\s+\d+\s*(?:min(?:utes?)?)\b/i.test(m)
  ) && !EXERCISE_PATTERN.test(m)  // not a weight training message
    && !/\b(?:ate|had|food|meal|eaten|eating|calories|breakfast|lunch|dinner|supper)\b/i.test(m)
    && !/\b\d[\d,]*\s*steps?\b/i.test(m); // explicit step counts go to the step handler

  if (isCardioLog) {
    const todayStart = sastDayStart();
    const existingToday = await db.select({ id: workoutLogs.id }).from(workoutLogs)
      .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, todayStart)))
      .limit(1);

    if (existingToday.length > 0) {
      return `${firstName ? firstName + ", " : ""}session already logged today. Good work staying active.`;
    }

    // Detect activity type for personalised response
    const cardioType = /parkrun|park\s*run/i.test(m) ? "parkrun"
      : /\bhiit\b|interval\s*training/i.test(m) ? "HIIT"
      : /\byoga\b/i.test(m) ? "yoga"
      : /\bpilates\b/i.test(m) ? "Pilates"
      : /\bzumba\b/i.test(m) ? "Zumba"
      : /spinning|spin\s*class/i.test(m) ? "spinning"
      : /bootcamp|boot\s*camp/i.test(m) ? "bootcamp"
      : /crossfit/i.test(m) ? "CrossFit"
      : /aerobics/i.test(m) ? "aerobics"
      : /run|ran|jog/i.test(m) ? "run"
      : /swim|swam/i.test(m) ? "swim"
      : /cycl|bike|bik/i.test(m) ? "cycle"
      : /walk|walked/i.test(m) ? "walk"
      : /danc/i.test(m) ? "dance class"
      : "cardio";

    // Extract duration and distance from message
    const durationMatch = m.match(/(\d+)\s*(?:min(?:utes?)?|mins?)\b/i);
    const hourMatch = m.match(/(\d+(?:\.\d+)?)\s*(?:hrs?|hours?)\b/i);
    const distanceMatch = m.match(/(\d+(?:\.\d+)?)\s*km\b/i);
    const durationMin = durationMatch ? parseInt(durationMatch[1])
      : hourMatch ? Math.round(parseFloat(hourMatch[1]) * 60)
      : null;
    const distanceKm = distanceMatch ? parseFloat(distanceMatch[1]) : null;

    // Calorie burn estimate (kcal/min × body-weight factor)
    const BURN_RATE: Record<string, number> = {
      run: 10, parkrun: 10, HIIT: 11, bootcamp: 11, CrossFit: 11,
      swim: 9, cycle: 8, spinning: 9,
      Zumba: 7, aerobics: 7, "dance class": 7,
      walk: 5, yoga: 4, Pilates: 4, cardio: 8,
    };
    const burnPerMin = BURN_RATE[cardioType] || 8;
    const weightKg = parseFloat(String(user.currentWeight || 75));
    const weightFactor = weightKg / 75;
    const burnEstimate = durationMin
      ? Math.round(durationMin * burnPerMin * weightFactor)
      : distanceKm
        ? Math.round(distanceKm * (/run|ran|jog|parkrun/i.test(m) ? 72 : 55) * weightFactor)
        : null;

    // km → steps: log to stepLogs so step streak / target tracking reflects the activity
    if (distanceKm && distanceKm > 0 && distanceKm < 120) {
      const stepsPerKm = /run|ran|jog|parkrun/i.test(m) ? 1100 : 1300;
      const derivedSteps = Math.round(distanceKm * stepsPerKm);
      try {
        await db.insert(stepLogs).values({ userId: user.id, steps: derivedSteps });
      } catch (e) { console.warn("[CARDIO] step insert failed:", e); }
    }

    // Log workout session
    await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true });
    invalidatePatternCache(user.id); // GPT's cached pattern summary must see this session immediately

    const newTotal = (user.totalWorkoutsCompleted || 0) + 1;
    const trainingDays = user.trainingDaysPerWeek || 3;
    const todaySlot = getTodaySlot(user);
    const nextDay = (todaySlot % trainingDays) + 1;
    const weekAdvance = todaySlot === trainingDays;
    const newWeek = weekAdvance ? (user.programmeWeek || 1) + 1 : (user.programmeWeek || 1);

    const lastWorkout = user.lastWorkoutDate ? new Date(user.lastWorkoutDate) : null;
    const toSASTDayStart = (d: Date) => {
      const s = new Date(d.getTime() + 2 * 3_600_000);
      return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate())).getTime();
    };
    const yestStart = toSASTDayStart(new Date(Date.now() - 86_400_000));
    const wasYesterday = lastWorkout && toSASTDayStart(lastWorkout) === yestStart;
    const newStreak = wasYesterday ? (user.workoutStreak || 0) + 1 : 1;

    await db.update(users).set({
      totalWorkoutsCompleted: newTotal,
      programmeDayInWeek: nextDay,
      programmeWeek: newWeek,
      lastWorkoutDate: new Date(),
      lastActiveAt: new Date(),
      workoutStreak: newStreak,
    }).where(eq(users.phoneNumber, phone));

    // Build response
    const typeLabel = { run: "Run", walk: "Walk", cycle: "Cycle", swim: "Swim",
      parkrun: "Parkrun", HIIT: "HIIT", yoga: "Yoga", Pilates: "Pilates",
      Zumba: "Zumba", spinning: "Spinning", bootcamp: "Bootcamp", CrossFit: "CrossFit",
      aerobics: "Aerobics", "dance class": "Dance class", cardio: "Cardio" }[cardioType] || cardioType;
    const distNote = distanceKm ? ` — ${distanceKm}km` : "";
    const durNote = !distanceKm && durationMin ? ` — ${durationMin}min` : "";
    const burnNote = burnEstimate ? ` (~${burnEstimate} kcal)` : "";
    const stepsNote = distanceKm
      ? `\n\nStep count from ${distanceKm}km: ~${Math.round(distanceKm * (/run|ran|jog|parkrun/i.test(m) ? 1100 : 1300)).toLocaleString()} steps added.`
      : "";
    const streakNote = newStreak >= 3 ? `\n\n🔥 *${newStreak}-session streak.* Keep it going.` : "";

    const CARDIO_RESPONSES = [
      `${typeLabel}${distNote || durNote} done. ✅${burnNote} Session ${newTotal} logged.`,
      `${typeLabel}${distNote || durNote} complete. 💪${burnNote} ${newTotal} sessions in.`,
      `Session ${newTotal} — ${typeLabel}${distNote || durNote}.${burnNote} Logged. ✅`,
      `${typeLabel}${distNote || durNote} — logged. ✅${burnNote} ${newTotal} sessions done.`,
    ];
    const cardioReply = CARDIO_RESPONSES[newTotal % CARDIO_RESPONSES.length];

    await logChat(user.id, message, cardioReply, "WORKOUT_DONE");

    // Fire first-workout referral nudge (same as isDone handler)
    if (newTotal === 1) {
      const userId = user.id;
      setTimeout(async () => {
        try {
          const [freshUser] = await db.select({ referralCode: users.referralCode }).from(users)
            .where(eq(users.phoneNumber, phone)).limit(1);
          let referralCode = freshUser?.referralCode;
          if (!referralCode) {
            const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            const rand = Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
            referralCode = `KAM${rand}`;
            await db.update(users).set({ referralCode }).where(eq(users.phoneNumber, phone));
          }
          const referralMsg = `One more thing — you just completed your first session. That already puts you ahead of most people who sign up and never start.\n\nIf you know someone who needs this, share your code: *${referralCode}*\n\nThey get their first month for R50. You get R20 off yours.`;
          await sendWhatsApp(phone, referralMsg);
          await logChat(userId, "", referralMsg, "REFERRAL_NUDGE_POST_WORKOUT");
        } catch (err) { console.warn("[REFERRAL_NUDGE] Cardio first-workout:", err); }
      }, 60_000);
    }

    return `${cardioReply}${stepsNote}${streakNote}\n\nLog your food: tell me what you ate today.[BUTTONS:Log food|My progress|Tomorrow's session]`;
  }

  // ---- RETROACTIVE WORKOUT — "trained yesterday", "did legs yesterday", "done on Sunday" ----
  const hasRetroDayRef = /\b(yesterday|last night|2 days ago|two days ago|on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|last\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(m);
  // "done/finished/completed" alone is too generic — must appear beside a workout word.
  // "trained", "did my workout/session/legs/etc." are workout-specific by themselves.
  const hasCompletionWord =
    /\b(trained|did\s+(?:my\s+)?(?:workout|session|training|gym|legs?|upper(?:\s+body)?|lower(?:\s+body)?|chest|back|push|pull|cardio|arms?|shoulders?|squats?)|workout\s+(?:done|complete[d]?|finished)|session\s+(?:done|complete[d]?|finished)|training\s+(?:done|complete[d]?|finished)|gym\s+(?:done|complete[d]?|finished))\b/i.test(m)
    || /\b(?:done|finished|complete[d]?)\b.{0,40}\b(?:workout|session|training|gym|legs?|upper|lower|chest|back|push|pull|cardio)\b/i.test(m)
    || /\b(?:workout|session|training|gym|legs?|upper|lower|chest|back|push|pull|cardio)\b.{0,40}\b(?:done|finished|complete[d]?)\b/i.test(m);
  const hasMissWord = /\b(missed?|couldn.?t|skipped?|didn.?t|won.?t|rest\s+day|sick|injur|cancel)\b/i.test(m);

  // Question guard uses the shared looksLikeQuestion (not a bare "?" check): a voice
  // transcript that drops the mark — "is yesterday's session logged", "should that
  // have counted" — must not retro-log a session it's only asking about.
  const isRetroDone = !looksLikeQuestion(m) && hasRetroDayRef && hasCompletionWord && !hasMissWord;

  if (isRetroDone) {
    const retroDate = parseMealDate(m);
    const retroStart = new Date(retroDate);
    retroStart.setUTCHours(0, 0, 0, 0);
    const retroEnd = new Date(retroStart.getTime() + 86_400_000);
    const dateLabel = mealDateLabel(retroDate);

    const existing = await db.select({ id: workoutLogs.id }).from(workoutLogs)
      .where(and(
        eq(workoutLogs.userId, user.id),
        gte(workoutLogs.loggedAt, retroStart),
        lt(workoutLogs.loggedAt, retroEnd),
      ))
      .limit(1);

    if (existing.length > 0) {
      return `${firstName ? firstName + ", already" : "Already"} got ${dateLabel}'s workout logged.`;
    }

    await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true, loggedAt: retroDate });
    invalidatePatternCache(user.id);

    const newTotal = (user.totalWorkoutsCompleted || 0) + 1;
    const trainingDays = user.trainingDaysPerWeek || 3;
    const todaySlot = getTodaySlot(user);
    const nextDay = (todaySlot % trainingDays) + 1;
    const weekAdvance = todaySlot === trainingDays;
    const newWeek = weekAdvance ? (user.programmeWeek || 1) + 1 : (user.programmeWeek || 1);

    // Advance lastWorkoutDate only if the retroactive session is more recent — keeps
    // streak tracking correct when someone logs yesterday before doing today's session.
    const currentLastWorkout = user.lastWorkoutDate ? new Date(user.lastWorkoutDate).getTime() : 0;
    const updateLastWorkout = retroDate.getTime() > currentLastWorkout;

    await db.update(users).set({
      totalWorkoutsCompleted: newTotal,
      programmeDayInWeek: nextDay,
      programmeWeek: newWeek,
      lastActiveAt: new Date(),
      ...(updateLastWorkout ? { lastWorkoutDate: retroDate } : {}),
    }).where(eq(users.phoneNumber, phone));

    await logChat(user.id, message, `[RETRO WORKOUT: ${dateLabel}]`, "WORKOUT_LOG");
    const n = firstName || "";
    return `${n ? n + " — " : ""}got it, logged to ${dateLabel}. ${newTotal} session${newTotal !== 1 ? "s" : ""} in total.\n\nNow log your food or send today's workout when you're ready.[BUTTONS:Log food|My progress|Today's workout]`;
  }

  // ---- WORKOUT DONE — log completion ----
  const isDone = (
    /^(done|finished|complete|completed|trained)[.!?]?$/i.test(m)
    || /^done\s*[💪✅🔥][.!?]?$/.test(m)
    || /^(?:workout|session|training|gym)\s+(?:done|complete|finished)[.!?]?$/i.test(m)
    || /^(?:just\s+)?(?:done|finished)\s+(?:my\s+)?(?:workout|session|training|gym)[.!?]?$/i.test(m)
    || m === "done today" || m === "finished today"
  ) && !looksLikeQuestion(m)  // "done?" / "workout done?" is asking, not reporting — the [.!?]? anchors otherwise allow a trailing ?
    && !/\b(?:steps?|km|walked|walk)\b/i.test(m)
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
    invalidatePatternCache(user.id); // GPT's cached pattern summary must see this session immediately

    const newTotal = (user.totalWorkoutsCompleted || 0) + 1;
    const trainingDays = user.trainingDaysPerWeek || 3;
    // Use today's actual calendar slot — not a blind sequential counter
    const todaySlot = getTodaySlot(user);
    const nextDay = (todaySlot % trainingDays) + 1;
    const weekAdvance = todaySlot === trainingDays; // last slot of the week
    const newWeek = weekAdvance ? (user.programmeWeek || 1) + 1 : (user.programmeWeek || 1);

    // Workout streak calculation — SAST-aware (UTC+2)
    const lastWorkout = user.lastWorkoutDate ? new Date(user.lastWorkoutDate) : null;
    const dayStartSAST = (d: Date) => {
      const sast = new Date(d.getTime() + 2 * 3_600_000);
      return new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate())).getTime();
    };
    const yesterdayStart = dayStartSAST(new Date(Date.now() - 86_400_000));
    const wasYesterday = lastWorkout && dayStartSAST(lastWorkout) === yesterdayStart;
    const newStreak = wasYesterday ? (user.workoutStreak || 0) + 1 : 1;

    await db.update(users).set({
      totalWorkoutsCompleted: newTotal,
      programmeDayInWeek: nextDay,
      programmeWeek: newWeek,
      lastWorkoutDate: new Date(),
      lastActiveAt: new Date(),
      workoutStreak: newStreak,
    }).where(eq(users.phoneNumber, phone));

    const doneResponse = WORKOUT_DONE_RESPONSES[newTotal % WORKOUT_DONE_RESPONSES.length](newTotal, todaySlot);

    let milestoneMsg = "";
    const MILESTONE_TEXTS: Record<number, string> = {
      1:   `\n\n🔥 *First workout done.* That's the hardest one — starting. Your body is already adapting. See you tomorrow.`,
      3:   `\n\n🔥 *3 sessions in.* The habit is forming. Most people who hit 3 make it to 10.`,
      5:   `\n\n🔥 *5 sessions.* You've officially started. Some people signed up the same day and already quit — you haven't.`,
      10:  `\n\n🏆 *10 sessions done.* Most people never get here. Don't stop now.`,
      25:  `\n\n🏆 *25 workouts.* You are not talking about fitness anymore — you are doing it.`,
      50:  `\n\n🏆 *50 sessions.* Fifty times you showed up when you could have stayed home. That is discipline.`,
      100: `\n\n🏆 *100 workouts.* One hundred sessions. Whatever happens next — you earned this.`,
    };

    if (MILESTONE_TEXTS[newTotal]) {
      milestoneMsg = MILESTONE_TEXTS[newTotal];

      if ([25, 50, 100].includes(newTotal)) {
        const updatedUser = { ...user, totalWorkoutsCompleted: newTotal };
        generateMilestoneVoiceScript(updatedUser, "workout_sessions", { sessions: newTotal })
          .then(({ script, emotion }) => generateVoiceNote(script, emotion))
          .then(url => { if (url) return sendWhatsApp(phone, "", url); })
          .catch(err => console.warn("[TTS] Workout milestone voice failed:", err));
      }

      try {
        saveState(`workout_milestone_${newTotal}_${user.id}`, "sent");
      } catch { /* non-fatal */ }
    }

    const [perfectDay, poCtxDone] = await Promise.all([
      checkPerfectDay(user.id, user.proteinTarget || 120),
      getProgressiveOverloadContext(user.id),
    ]);

    // Week 1 Complete badge — fires once when programme week advances from 1 to 2
    let week1Badge = "";
    if (weekAdvance && newWeek === 2) {
      week1Badge = `\n\n---\n\n🏆 *WEEK 1 COMPLETE*\n\nYou finished your first full training week. Most people quit before this.\n\nWorkout ${newTotal} is done. Week 2 starts next session — same time, same commitment.\n\nThe gap between who you were and who you're becoming is exactly this: showing up when nobody's watching.`;
    }

    // Detect rest-day bonus session (trained on a scheduled rest day)
    const wState = await getTodayWorkoutState(user);
    const bonusNote = wState.type === "REST"
      ? `\n\n_${wState.todayName} is your rest day — but you trained anyway. Extra credit._`
      : "";

    // Proactive form check — once, early (2nd session, when they're settled but form
    // habits are still forming). One clip is the closest thing to hands-on coaching we
    // have. Kept to the 2nd session so it doesn't clash with the 1st-session referral nudge.
    const formVideoPrompt = newTotal === 2
      ? `\n\n📹 _Next session, film ONE set from the side and send it — I'll check your form and give you the one or two things to fix. Better form = faster results and no niggles._`
      : "";

    // Show last session's targets so user knows what to log (only if they have exercise history)
    const liftPrompt = poCtxDone
      ? `${poCtxDone.trim()}\n\nLog today's actual weights: "bench 80kg 3x10" (or skip if cardio/bodyweight)`
      : `Log your lifts: "bench 80kg 3x10" (or skip if cardio/bodyweight)`;

    await logChat(user.id, message, doneResponse, "WORKOUT_DONE");

    // Fire referral nudge 60 seconds later on the very first workout
    if (newTotal === 1) {
      const userId = user.id;
      setTimeout(async () => {
        try {
          // Fetch current referral code (may have been set by now, or generate one)
          const [freshUser] = await db.select({ referralCode: users.referralCode }).from(users)
            .where(eq(users.phoneNumber, phone)).limit(1);
          let referralCode = freshUser?.referralCode;
          if (!referralCode) {
            const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            const rand = Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
            referralCode = `KAM${rand}`;
            await db.update(users).set({ referralCode }).where(eq(users.phoneNumber, phone));
          }
          const referralMsg = `One more thing — you just completed your first session. That already puts you ahead of most people who sign up and never start.\n\nIf you know someone who needs this, share your code: *${referralCode}*\n\nThey get their first month for R50. You get R20 off yours. One message to one person is all it takes.`;
          await sendWhatsApp(phone, referralMsg);
          await logChat(userId, "", referralMsg, "REFERRAL_NUDGE_POST_WORKOUT");
        } catch (err) {
          console.warn("[REFERRAL_NUDGE] Failed to send first-workout referral nudge:", err);
        }
      }, 60_000);
    }

    // ONE add-on per reply (2026-07-10 friction audit): done-confirmation used to stack
    // milestone + week-1 badge + perfect day + rest-day bonus + form-video prompt. ONE
    // rides along: week-1 badge (once ever) > milestone > form prompt (once, session 2)
    // > perfect day > bonus. The feel question + lift prompt stay — they're the loop.
    const doneAddOn = [week1Badge, milestoneMsg, formVideoPrompt, perfectDay || "", bonusNote]
      .find(s => s && s.trim()) || "";
    return `${doneResponse}${doneAddOn}\n\n_How did that session feel — too easy, just right, or too hard? Tell me and I'll tune the next one._\n\n${liftPrompt}[BUTTONS:Log my lifts|Tomorrow's session|Log food]`;
  }

  // ---- LIFT LOG — parse and store exercise data ----
  const lifts = parseLiftLog(m);
  // "should I bench 80kg?" / "can I squat 100kg" parse as lifts but are questions —
  // don't store a phantom "should i bench" exercise row.
  if (lifts.length > 0 && !looksLikeQuestion(m)) {
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
  // "should I change my goal to muscle gain?" is asking; "I don't want to change my
  // goal to fat loss" is refusing. Neither may overwrite the goal + recalc targets.
  // The negation is scoped to appear BEFORE the change verb, so "change my goal to
  // muscle gain, not fat loss" (a clarification, not a refusal) still applies.
  const goalChangeNegated = /\b(don.?t|do\s+not|dont|never|no\s+longer|won.?t|would\s+not|wouldn.?t|not)\b[^.?!]*\b(change|switch|update|move)\b/i.test(m);
  if (goalChangeMatch && !looksLikeQuestion(m) && !goalChangeNegated) {
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
    const newTargets = calculateTargets(currentWt, goalType, user.lifeSituation || "office", user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, user.heightCm || 170, user.trainingExperience || "beginner");
    await db.update(users).set({ goalType, calorieTarget: newTargets.calorieTarget, proteinTarget: newTargets.proteinTarget }).where(eq(users.phoneNumber, phone));
    const label = goalLabels[goalType] || goalType;
    const capFirst = (user.name || "").split(" ")[0];
    const nameStr = capFirst ? `Sharp ${capFirst}` : "Sharp";
    const mode = user.trainingMode || "home";
    const sessionWord = mode === "gym" ? "gym session" : "home session";
    const goalDetail = goalType === "muscle_gain"
      ? `Eat above ${newTargets.calorieTarget} kcal on training days. Hit ${newTargets.proteinTarget}g protein every day — that is what builds muscle. Add reps or weight every session.\n\nReply *workout* for your first ${sessionWord}.`
      : goalType === "fat_loss"
      ? `Stay within ${newTargets.calorieTarget} kcal. Hit ${newTargets.proteinTarget}g protein first at every meal — that preserves muscle while you cut.\n\nReply *workout* for today's session.`
      : `Hold calories at ${newTargets.calorieTarget} kcal. Hit ${newTargets.proteinTarget}g protein. Consistency over the next 8 weeks is what locks the results in.\n\nReply *workout* for today's session.`;
    return `${nameStr}. Goal updated to *${label}*.\n\nNew targets: *${newTargets.calorieTarget} kcal/day | ${newTargets.proteinTarget}g protein.*\n\n${goalDetail}`;
  }

  return null;
}
