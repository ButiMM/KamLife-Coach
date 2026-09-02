/**
 * Workout-related commands: gym log, done, my lifts, exercise weight log,
 * goal change, weight update/mention, programme setup, photo correction,
 * elderly/injury programme, programme delivery.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { users, workoutLogs, chatHistory } from "../../shared/schema";
import { eq, and, gte, lt, desc } from "drizzle-orm";
import {
  classifyWorkoutFeedbackAnswer,
  createWorkoutFeedbackExpectation,
  isWorkoutFeedbackExpectation,
  readWorkoutFeedbackExpectation,
  workoutFeedbackReply,
} from "../workout-feedback";
import { parseSessionReport, sessionReportReply, sessionMemoryLine, type SessionReport } from "../session-report";
import {
  buildDayWorkout,
  buildFullProgramme, getKamlifeProgramme, WORKOUT_DONE_RESPONSES,
} from "../programme";
import { checkPerfectDay } from "./checks";
import { storeMemory } from "../memory";
import { generateVoiceNote } from "../tts";
import { generateMilestoneVoiceScript } from "../gpt";
import { logChat, turnMutation, turnAlreadyWrote } from "./chat-log";
import { sastDayKey } from "../sast";
import { journeyMustKeepFacts } from "../understanding/messy-intake";
import { sastDayStart, parseMealDate, mealDateLabel, isFutureIntent, reportedInSomeClause, looksLikeQuestion, mentionsNotDone, sessionCountsIn, statedWhen, getDisplayName } from "../utils";
import { applyRetroSessionState } from "../day-ledger";
import { readTrainingDay } from "../one-action";
import { invalidatePatternCache } from "../cache";
import { getTodayWorkoutState, getTodaySlot, weekStartForTrainingClaim, attributableWeekSessionDates } from "../workout-state";
import { handleWeightLog } from "./weight";
import { logStepsForUser } from "./steps";
import { calculateTargets } from "../targets";
import { getPrimaryWorkoutGifUrl } from "../exercise-media";
import { sendWhatsApp, saveState } from "../scheduler/shared";
import { PRICING, GUARANTEE_PHRASE } from "../../shared/pricing";

// Exercise-name vocabulary. parseLiftLog was deleted with lift logging on 2026-08-06, but
// this pattern is NOT a parser input — it is a GUARD used twice below, and both uses are the
// reason it survives: "bench 80kg 3x10" must not be logged as a body weight, and a weight
// training message must not be logged as cardio. Without it, "bench 80kg" sets the client's
// weight to 80kg and silently recalculates every target.
const EXERCISE_PATTERN = /\b(?:bench\s*press?|squat|deadlift|leg\s*press?|leg\s*curl|leg\s*extension|hip\s*thrust|rdl|romanian|lunge|lateral\s*raise|shoulder\s*press?|overhead\s*press?|ohp|lat\s*pull[- ]?down|seated\s*row|cable\s*row|face\s*pull|bicep\s*curl|tricep|pushdown|push[- ]?ups?|pull[- ]?ups?|chin[- ]?ups?|dip|plank|fly|chest\s*press?|incline|decline|cable|barbell|bb|dumbbell|db|calf\s*raise|glute|hip|press|rows?|rdls?|step\s*up|abduction|adduction|pull\s*through|hip\s*hinge)\b/i;

/**
 * Resume the one post-session question before ordinary handlers can reinterpret its answer as a
 * new workout report. This is the workout-feedback owner's landing pad, analogous to the existing
 * engine-confirm resume path; it is not a second routing system.
 *
 * A non-feedback message spends the expectation and returns null, so changing subject never
 * leaves a client hostage to a question Coach K asked earlier. Consumption is conditional on the
 * exact durable marker: only one concurrent turn can clear it and own the feedback response.
 */
export async function resumeWorkoutFeedbackExpectation(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
}): Promise<string | null> {
  const { phone, message, m, user } = ctx;
  const marker = String(user?.awaitingInputType || "");
  if (!isWorkoutFeedbackExpectation(marker)) return null;

  const expectation = readWorkoutFeedbackExpectation(marker);
  const feedbackKind = expectation ? classifyWorkoutFeedbackAnswer(message) : null;

  // Expiry and a clear subject change both release the one-slot expectation. Do not make a later
  // "too hard" answer a session question the client has already moved on from.
  if (!expectation || !feedbackKind) {
    await db.update(users).set({ awaitingInputType: null })
      .where(and(eq(users.id, user.id), eq(users.awaitingInputType, marker)))
      .catch((e) => console.error("[WORKOUT_FEEDBACK] expectation clear failed:", e));
    user.awaitingInputType = null;
    return null;
  }

  // Clear first and condition on the exact marker. If the durable transition cannot be confirmed,
  // do not manufacture a second feedback answer from a state another turn may already have spent.
  let consumed: { id: string }[] = [];
  try {
    consumed = await db.update(users).set({ awaitingInputType: null })
      .where(and(eq(users.id, user.id), eq(users.awaitingInputType, marker)))
      .returning({ id: users.id });
  } catch (e) {
    console.error("[WORKOUT_FEEDBACK] expectation consume failed:", e);
    return null;
  }
  if (!consumed.length) return null;
  user.awaitingInputType = null;

  const firstName = getDisplayName(user);
  const reply = workoutFeedbackReply(feedbackKind, firstName);
  storeMemory(phone, `Workout difficulty: last session felt "${feedbackKind.replace("_", " ")}"`, "workout").catch(() => {});
  await logChat(user.id, message, reply, "WORKOUT_FEEDBACK");
  return reply;
}

export async function handleWorkoutCommands(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
}): Promise<string | null> {
  const { phone, message, m, user } = ctx;
  const firstName = user.name?.split(" ")[0] || "";

  // ---- SESSION REPORTED IN PROSE — "today was my first day back, felt very bad" ----
  // Runs BEFORE the difficulty-feedback gate and the terse `isDone` match, because a
  // sentence reaches neither: the gate needs a WORKOUT_* intent in the last 6h (absent
  // when someone just trains and then tells you) and `isDone` is anchored ^…$. The
  // session was being dropped AND the feeling ignored — see server/session-report.ts.
  const sessionReport = parseSessionReport(message);
  if (sessionReport && !looksLikeQuestion(m) && !isFutureIntent(m) && !mentionsNotDone(m)) {
    const handled = await logProseSession(user, phone, message, sessionReport, firstName);
    if (handled) return handled;
  }

  // ---- WORKOUT DIFFICULTY FEEDBACK — the post-session "how was it?" loop ----
  // Only interpret "too easy / just right / too hard" as session feedback when a
  // workout was actually delivered or logged in the last 6 hours, and the message
  // isn't about food/money/the app. This recency gate is what keeps "this diet is
  // too hard" from being misread as workout feedback — no state machine needed.
  const feedbackKind = classifyWorkoutFeedbackAnswer(message);
  if (feedbackKind) {
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


  // ---- WEIGHT LOG — standalone "84kg" or brief weight check-in ----
  // Only fires if message is clearly about body weight, not exercise weight
  // ONE WEIGH-IN SHAPE, APPLIED TO WHATEVER TEXT IT IS GIVEN. Factored out of the two inline
  // tests below so the same recogniser can read a single clause — no second weight recogniser.
  const weighInShape = (t: string) => /^(\d{2,3}(?:\.\d+)?)\s*kg[.!]?$/i.test(t)
    || /\b(?:weigh(?:ed|s|ing)?|morning weight|body weight|on the scale|scale said|scale reads|weighed in|my weight)\b.*\b(\d{2,3}(?:\.\d+)?)\s*kg\b/i.test(t)
    || /\b(\d{2,3}(?:\.\d+)?)\s*kg\b.*\b(?:today|this morning|just weighed)\b/i.test(t);
  const isStandaloneWeight = /^(\d{2,3}(?:\.\d+)?)\s*kg[.!]?$/i.test(m);
  const isWeightCheckIn = (
    /\b(?:weigh(?:ed|s|ing)?|morning weight|body weight|on the scale|scale said|scale reads|weighed in|my weight)\b.*\b(\d{2,3}(?:\.\d+)?)\s*kg\b/i.test(m)
    || /\b(\d{2,3}(?:\.\d+)?)\s*kg\b.*\b(?:today|this morning|just weighed)\b/i.test(m)
  );
  // A QUESTION IN ONE CLAUSE DOES NOT ERASE A REPORT IN ANOTHER (2026-08-26, issue #63). The two
  // tests above are anchored to the WHOLE bubble, so "84kg. how am I doing?" was not a weigh-in at
  // all — the scale reading was simply not seen. Re-read per clause, only when the whole-message
  // read already said no, and only for a clause that is neither a question nor an intention.
  const weightClause = (isStandaloneWeight || isWeightCheckIn) ? null
    : reportedInSomeClause(message, c => weighInShape(c.toLowerCase()));
  // Retrospective brake: "I weighed 83kg last week", "I started at 95kg", "used to be 90kg"
  // are HISTORICAL — they must not overwrite today's weight or recalc targets off a past number.
  const isRetrospectiveWeight = /\b(last\s+(?:week|month|year|time)|used\s+to|back\s+(?:then|in|when)|previously|a\s+(?:week|month|year)\s+ago|(?:weeks?|months?|years?)\s+ago|started\s+(?:at|on|out|off)|when\s+i\s+(?:started|began))\b/i.test(m);

  // Question brake: "I weighed 84kg, is that too much?" / "84kg today?" is asking —
  // logging it silently recalculates calorie & protein targets and can flip the goal,
  // all off a message the user framed as a question. Let it reach GPT; a clean "84kg"
  // still logs.
  // Intent brake: "I want to weigh 85kg" / "I need to be 85kg" is a GOAL. Without this it wrote
  // 85kg as today's measurement for a client on the scale at 95kg, recalculated their calorie and
  // protein targets off it, and replied "🏆 you hit 85kg — that's the goal, done." The two
  // branches either side of this one — the session report above and the cardio log below — have
  // always asked isFutureIntent. This one never did; that asymmetry was the whole defect.
  // When the weigh-in came from a clause, the clause is the text every guard below reads: the
  // whole-bubble question test is precisely what was wrong, and the number must come from the
  // sentence that reported it.
  const weightText = weightClause ? weightClause.toLowerCase() : m;
  if ((isStandaloneWeight || isWeightCheckIn || !!weightClause)
      && !isRetrospectiveWeight && !isFutureIntent(weightText)
      && !looksLikeQuestion(weightText) && !EXERCISE_PATTERN.test(weightText)) {
    const kgMatch = weightText.match(/(\d{2,3}(?:\.\d+)?)\s*kg/i);
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

    // km → steps: log to stepLogs so step streak / target tracking reflects the activity.
    //
    // THROUGH THE OWNER, NOT AROUND IT (2026-08-26, issue #63). This was a bare INSERT with no
    // day-window read, so it broke the one rule logStepsForUser exists to hold — one row per SAST
    // day. Measured: a client whose day already held 8 000 steps sent "ran 5km" and ended the turn
    // with TWO rows, 8 000 and 5 500, where the owner would have kept 8 000 and written nothing.
    //
    // Two rows also make the day's own read non-deterministic: both day-row reads are `.limit(1)`
    // with no ORDER BY, so which count the client is told becomes a matter of which row Postgres
    // hands back. No customer-visible divergence was demonstrated for that — stated plainly, it
    // was not — but the precondition is created here and the unordered read is real.
    //
    // The conversion stays exactly as it was; only the write door changes.
    if (distanceKm && distanceKm > 0 && distanceKm < 120) {
      const stepsPerKm = /run|ran|jog|parkrun/i.test(m) ? 1100 : 1300;
      const derivedSteps = Math.round(distanceKm * stepsPerKm);
      try {
        await logStepsForUser(user.id, derivedSteps);
      } catch (e) { console.warn("[CARDIO] step write failed:", e); }
    }

    // Log workout session
    await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true });
    turnMutation("INSERT workout completed=true", "[WORKOUT_LOG]");
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
          const referralMsg = `One more thing — you just completed your first session. That already puts you ahead of most people who sign up and never start.\n\nIf you know someone who needs this, share your code: *${referralCode}*\n\nWhen they join, *you get a free month* — they come in at R${PRICING.monthlyPriceZAR} with a ${GUARANTEE_PHRASE}, no risk.`;
          await sendWhatsApp(phone, referralMsg);
          await logChat(userId, "", referralMsg, "REFERRAL_NUDGE_POST_WORKOUT");
        } catch (err) { console.warn("[REFERRAL_NUDGE] Cardio first-workout:", err); }
      }, 60_000);
    }

    return `${cardioReply}${stepsNote}${streakNote}\n\nLog your food: tell me what you ate today.[BUTTONS:Log food|My progress|Tomorrow's session]`;
  }

  // ---- RETROACTIVE WORKOUT — "trained yesterday", "did legs yesterday", "done on Sunday" ----
  // ONE TEMPORAL OWNER (2026-08-22, P0-B). This was a private day-word list that parseMealDate
  // already out-resolved, so "I trained Monday" and "I trained last week" both wrote TODAY.
  // utils.statedWhen answers today / historical / ambiguous for both branches below, from the
  // parser that owns dates — and hands back the date it resolved, so nothing parses twice.
  const when = statedWhen(m);
  // "done/finished/completed" alone is too generic — must appear beside a workout word.
  // "trained", "did my workout/session/legs/etc." are workout-specific by themselves.
  const hasCompletionWord =
    /\b(trained|did\s+(?:my\s+)?(?:workout|session|training|gym|legs?|upper(?:\s+body)?|lower(?:\s+body)?|chest|back|push|pull|cardio|arms?|shoulders?|squats?)|workout\s+(?:done|complete[d]?|finished)|session\s+(?:done|complete[d]?|finished)|training\s+(?:done|complete[d]?|finished)|gym\s+(?:done|complete[d]?|finished))\b/i.test(m)
    || /\b(?:done|finished|complete[d]?)\b.{0,40}\b(?:workout|session|training|gym|legs?|upper|lower|chest|back|push|pull|cardio)\b/i.test(m)
    || /\b(?:workout|session|training|gym|legs?|upper|lower|chest|back|push|pull|cardio)\b.{0,40}\b(?:done|finished|complete[d]?)\b/i.test(m);
  // TWO QUESTIONS, NOT ONE (2026-08-25). This regex conflated "did they report a training miss"
  // — which readTrainingDay owns — with "are they sick or injured", which is a health question and
  // is not this owner's to answer. The training half now comes from the owner; the health half
  // stays local and is named for what it is. Proven equivalent on a 17-string battery before the
  // swap: the retro-logging guard behaves identically.
  const _trainingRead = readTrainingDay(m);
  const reportsMiss = _trainingRead === "missed" || _trainingRead === "declined";
  const hasHealthBlock = /\b(sick|injur|cancel)\b/i.test(m);
  const hasMissWord = reportsMiss || hasHealthBlock;

  // Question guard uses the shared looksLikeQuestion (not a bare "?" check): a voice
  // transcript that drops the mark — "is yesterday's session logged", "should that
  // have counted" — must not retro-log a session it's only asking about.
  // A multi-day report is dated by the owner that can date it; this door must not write the same
  // session again on the first day the bubble happens to mention (2026-08-25).
  const alreadyLoggedThisTurn = turnAlreadyWrote("workout");
  const isRetroDone = !alreadyLoggedThisTurn && !looksLikeQuestion(m) && when.when === "historical" && hasCompletionWord && !hasMissWord;

  if (isRetroDone) {
    const retroDate = when.date;
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
    // The SAST day, not String(Date).slice(0,10) — which produced "Fri Aug 2" and made the write
    // record unreadable by anything that needed to know WHICH day was written (2026-08-22).
    turnMutation(`INSERT workout completed=true at=${sastDayKey(retroDate)}`, "[WORKOUT_LOG]");
    invalidatePatternCache(user.id);

    const newTotal = (user.totalWorkoutsCompleted || 0) + 1;

    // ── A HISTORICAL WRITE MAY NOT MOVE TODAY (2026-08-25, P0-3) ──────────────────────────────
    //
    // This block used to advance programmeDayInWeek and programmeWeek. So "I trained on Monday"
    // moved TODAY's programme cursor forward — the client was told, correctly, that Monday was
    // logged, and silently lost today's session slot with it. Backfilling a past day is a
    // statement about that day and about nothing else.
    //
    // WHAT A PAST DAY MAY STILL CHANGE, and why:
    //   totalWorkoutsCompleted  a session really happened; the lifetime count is a fact about the
    //                           past, not a claim about today.
    //   lastWorkoutDate         only when the backfilled day is genuinely MORE RECENT than what
    //                           we hold — it is a max over real events, so a Monday log cannot
    //                           overwrite a Wednesday one.
    //
    // WHAT IT MAY NOT CHANGE: the programme cursor. Which session is due TODAY is decided by the
    // schedule and by what was done today, and a backfill answers neither question.
    // The rule this path already applied, now applied from one place. See applyRetroSessionState.
    await applyRetroSessionState(user, [retroDate]);

    await logChat(user.id, message, `[RETRO WORKOUT: ${dateLabel}]`, "WORKOUT_LOG");
    const n = firstName || "";
    return `${n ? n + " — " : ""}got it, logged to ${dateLabel}. ${newTotal} session${newTotal !== 1 ? "s" : ""} in total.\n\nNow log your food or send today's workout when you're ready.[BUTTONS:Log food|My progress|Today's workout]`;
  }

  /*
   * TALKING IS THE LOG, FOR TRAINING TOO (2026-08-21, handset).
   *
   * `isDone` below is anchored ^…$ — it matches a bare "done", "workout done", "just finished my
   * session", and nothing else. So neither of these reached a writer:
   *
   *     "I went to the gym in the morning"   → fell through → "Nice work getting to the gym!"
   *     "I did all four workouts this week"  → fell through → "…all four done! Noted 👌"
   *
   * and two minutes later the week card said WORKOUTS 1. The client told us, we agreed, we wrote
   * nothing. That is the continuity promise being false.
   *
   * A SHAPE, not a phrase list: a first-person past-tense verb plus a training noun, with the
   * guards that actually matter — future/intent, negation, third party, question, and other
   * domains. Tested against each of those before it was wired.
   *
   * A COUNT CLAIM IS NOT A SESSION. "I did all four workouts this week" tells us how many but not
   * WHICH DAYS, and writing four undated rows is inventing data. Continuity slice: if every
   * scheduled day of that week is already past and none already have a row, the dates are
   * attributable and we write them. Otherwise we refuse — never "Noted" over an empty ledger.
   */
  const weekClaimed = sessionCountsIn(m);
  if (!looksLikeQuestion(m) && !mentionsNotDone(m) && weekClaimed.length === 1 && weekClaimed[0] >= 2
      && /\b(?:this|last)\s+week\b/i.test(m)) {
    const weekStart = weekStartForTrainingClaim(m);
    const n = weekClaimed[0];
    const refuse = `${firstName ? firstName + ", I" : "I"} heard ${n} session${n === 1 ? "" : "s"} — tell me the days and I'll log them. I won't guess.`;
    if (!weekStart) {
      await logChat(user.id, message, refuse, "WORKOUT_WEEK_REFUSE");
      return refuse;
    }
    const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
    const existing = await db.select({ loggedAt: workoutLogs.loggedAt }).from(workoutLogs)
      .where(and(
        eq(workoutLogs.userId, user.id),
        gte(workoutLogs.loggedAt, weekStart),
        lt(workoutLogs.loggedAt, weekEnd),
      ));
    const existingKeys = existing.map(r => sastDayKey(r.loggedAt as Date));
    const dates = attributableWeekSessionDates({
      claimed: n,
      trainingDaysPerWeek: Number(user.trainingDaysPerWeek) || 3,
      weekStart,
      existingDayKeys: existingKeys,
    });
    if (!dates) {
      await logChat(user.id, message, refuse, "WORKOUT_WEEK_REFUSE");
      return refuse;
    }
    for (const day of dates) {
      await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true, loggedAt: day });
      turnMutation(`INSERT workout completed=true at=${sastDayKey(day)}`, "[WORKOUT_LOG]");
    }
    invalidatePatternCache(user.id);
    // THE SHARED RETRO TRANSITION (2026-08-25). This set `lastWorkoutDate: last` unconditionally,
    // so reporting a batch of older days moved the field BACKWARD past a more recent session —
    // while the sibling single-day path 65 lines above guarded exactly that. One owner now.
    await applyRetroSessionState(user, dates);
    const days = dates.map(d => mealDateLabel(d)).join(", ");
    const ok = `${firstName ? firstName + " — " : ""}logged ${dates.length} sessions (${days}).`;
    await logChat(user.id, message, ok, "WORKOUT_WEEK_LOG");
    return ok;
  }

  const TRAINING_NOUN = /\b(gym|workouts?|sessions?|training|trained|train)\b/i;
  const REPORTED_PAST = /\b(?:i\s+)?(?:went\s+to|hit|did|had|got|finished|completed|smashed|made\s+it\s+to|was\s+at|trained)\b|\b(?:gym|workout|session|training)\s+(?:done|finished)\b/i;
  const FUTURE_OR_INTENT = /\b(?:going\s+to|gonna|will|i'?ll|later|tomorrow|planning|plan\s+to|about\s+to|should\s+i|thinking\s+of|need\s+to|want\s+to)\b/i;
  const NEGATED_SESSION = /\b(?:didn'?t|did\s+not|haven'?t|have\s+not|couldn'?t|could\s+not|missed|skipped|no\s+gym)\b/i;
  const SOMEONE_ELSE = /\b(?:my\s+(?:brother|sister|wife|husband|friend|mate|partner|mom|mum|dad)|he|she|they)\b/i;
  // "how many sessions does this text assert" has ONE owner now — utils.sessionCountsIn — and
  // the reply verifier asks it the same question about the coach's own prose (2026-08-22).
  const OTHER_DOMAIN = /\b(?:steps?|km|walked|ate|had\s+lunch|meal|calories|water)\b/i;

  // NEVER WRITE A REPORTED DAY AS TODAY (2026-08-21). "I trained on Monday" names a day. The
  // retro block above owns those and writes the day the client actually said — but if it declines
  // for any reason (its completion-word test is narrower than this one), a today-write here would
  // silently move the session to the wrong date. A workout on the wrong day is worse than a
  // workout not logged: the client cannot see it to correct it, and every streak and weekly count
  // downstream inherits the error.
  //
  // So a message carrying a day reference is never written as today. It is either handled by the
  // retro path or not written at all — and the write-integrity guard at the boundary means an
  // unwritten session cannot be confirmed as logged.
  // A QUESTION IN ONE CLAUSE DOES NOT DELETE A FACT IN ANOTHER — the food door's rule, applied
  // to the domain next to it (2026-08-22). "I trained chest today. What should I eat now?" lost
  // the session to the whole-message question test, exactly as the breakfast was lost. The
  // override is journeyMustKeepFacts, whose WORKOUT pattern is past-report forms only, and the
  // FUTURE_OR_INTENT guard below still owns "should I hit the gym?" — which is why an override
  // here cannot turn an ask into a log.
  // CLAUSE-LEVEL, NOT BUBBLE-LEVEL. Every guard below asks something about the REPORT — is it an
  // intention, a negation, someone else, a question — and each was reading the whole bubble. So
  // "I trained chest today. What should I eat now?" was refused because FUTURE_OR_INTENT matched
  // "should I" in the sentence about FOOD. The fact and the question are different clauses and
  // must be judged separately; that is the whole lesson of the 11:24 turn.
  const statedWorkout = journeyMustKeepFacts(m).workout;
  const clause = m.split(/(?<=[.!?])\s+|\n+/).map(c => c.trim()).filter(Boolean)
    .find(c => TRAINING_NOUN.test(c) && REPORTED_PAST.test(c)) || m;
  const reportsOneSession = TRAINING_NOUN.test(clause) && REPORTED_PAST.test(clause)
    && !FUTURE_OR_INTENT.test(clause) && !NEGATED_SESSION.test(clause) && !SOMEONE_ELSE.test(clause)
    && (!looksLikeQuestion(clause) || statedWorkout) && sessionCountsIn(m).length === 0 && !OTHER_DOMAIN.test(clause);

  // ---- WORKOUT DONE — log completion ----
  // NO TODAY WRITE UNLESS TODAY IS WHAT THEY SAID. The verdict gates the whole branch, including
  // the anchored short forms — an invariant on the write, not a guard bolted to one matcher.
  const isDone = !alreadyLoggedThisTurn && when.when === "today" && (reportsOneSession || (
    /^(done|finished|complete|completed|trained)[.!?]?$/i.test(m)
    || /^done\s*[💪✅🔥][.!?]?$/.test(m)
    // THE COPULA FORM (2026-08-26, issue #63). This was anchored to the bare "workout done", so
    // "my workout is done" and "my session is done" — ordinary phrasing — matched nothing here and
    // fell all the way to the model, which logged no session. Same construction that broke steps
    // (#71) and water: three of four tracking surfaces missed "my X is/are …".
    // Still fully anchored, so it claims a short completion report and nothing longer.
    || /^(?:my\s+)?(?:workout|session|training|gym)\s+(?:is\s+|was\s+)?(?:done|complete|completed|finished)[.!?]?$/i.test(m)
    || /^(?:just\s+)?(?:done|finished)\s+(?:my\s+)?(?:workout|session|training|gym)[.!?]?$/i.test(m)
    || m === "done today" || m === "finished today"
  ) && !looksLikeQuestion(m)  // "done?" / "workout done?" is asking, not reporting — the [.!?]? anchors otherwise allow a trailing ?
    && !/\b(?:steps?|km|walked|walk)\b/i.test(m)
    && !/\b(?:ate|had|food|meal|eaten|eating|calories)\b/i.test(m))
    // ASKING WHETHER IT IS DONE IS NOT REPORTING THAT IT IS (2026-08-26, issue #63, pre-existing).
    //
    // "Is my workout done?" WROTE A SESSION. reportsOneSession waives the question guard when
    // statedWorkout is true — reasonable for "did my workout", which is a report — but that waiver
    // also covered the interrogative form, so a client checking their own record had one
    // fabricated. A false write is worse than a missed one: it tells the client they trained when
    // they did not, and the session count carries the invention forward.
    //
    // Anchored on BOTH the opening interrogative and a question mark, so "did my workout" (a
    // report, no mark) still logs while "did my workout?" and "is my workout done?" do not.
    && !(m.includes("?") && /^\s*(?:is|are|was|were|am|have|has|did|do|does)\b/i.test(m.trim()));

  if (isDone) {
    const todayStart = sastDayStart();
    const existing = await db.select({ id: workoutLogs.id }).from(workoutLogs)
      .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, todayStart)))
      .limit(1);

    if (existing.length > 0) {
      return `${firstName ? firstName + ", " : ""}today's session is already logged. 👌`;
    }

    await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true });
    turnMutation("INSERT workout", "[WRITE]");
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
    // ONE SENTENCE EACH. A milestone is worth saying and not worth a paragraph — the
    // number is the celebration, the essay dilutes it.
    const MILESTONE_TEXTS: Record<number, string> = {
      1:   ` That's the hardest one done — starting.`,
      3:   ` Three in: the habit is forming.`,
      5:   ` Five sessions — you've properly started.`,
      10:  ` Ten sessions. 🏆 Most people never get here.`,
      25:  ` Twenty-five. 🏆 You're not talking about fitness anymore.`,
      50:  ` Fifty sessions. 🏆 That's discipline.`,
      100: ` One hundred. 🏆 Whatever comes next, you earned this.`,
    };

    if (MILESTONE_TEXTS[newTotal]) {
      milestoneMsg = MILESTONE_TEXTS[newTotal];

      if ([25, 50, 100].includes(newTotal)) {
        const updatedUser = { ...user, totalWorkoutsCompleted: newTotal };
        generateMilestoneVoiceScript(updatedUser, "workout_sessions", { sessions: newTotal })
          .then(({ script, emotion }) => generateVoiceNote(script, emotion, user.id))
          .then(url => { if (url) return sendWhatsApp(phone, "", url); })
          .catch(err => console.warn("[TTS] Workout milestone voice failed:", err));
      }

      try {
        saveState(`workout_milestone_${newTotal}_${user.id}`, "sent");
      } catch { /* non-fatal */ }
    }

    const perfectDay = await checkPerfectDay(user.id, user.proteinTarget || 120);

    // FIRST FULL TRAINING WEEK — only a lifetime beginner may receive this history claim.
    // `programmeWeek` is phase-relative: phase advancement and a goal transition can both put an
    // experienced client back in Week 1. The old condition read only that clock, so the final
    // session of a new phase could say "your first full training week" immediately after the
    // same client had been shown "Session 25 overall". `newTotal` is the lifetime-session owner
    // used by the completion reply and the session header. At the final scheduled slot of a
    // genuine first cycle it equals the number of planned sessions; any larger total is history
    // that makes a first-ever claim false. Keep phase-relative Week 1 itself untouched.
    //
    // The badge remains deliberately small — it is the one completion add-on, not a second
    // programme or re-entry message.
    let week1Badge = "";
    if (weekAdvance && newWeek === 2 && newTotal === trainingDays) {
      week1Badge = ` 🏆 That's your first full training week — most people quit before this.`;
    }

    // COMMITMENT STREAK (2026-07-14, third-party review): a streak that counts comebacks,
    // not perfect days. When someone returns after a real gap, don't imply they "lost"
    // anything — reframe the miss as human and celebrate their CUMULATIVE persistence
    // (total sessions), because the people who get there are the ones who come back.
    const gapDays = (lastWorkout && !wasYesterday)
      ? Math.floor((dayStartSAST(new Date()) - dayStartSAST(lastWorkout)) / 86_400_000)
      : 0;
    const comebackNote = (gapDays >= 2 && newTotal > 1 && !MILESTONE_TEXTS[newTotal])
      ? ` 💛 And you came back — that's what counts.`
      : "";

    // Detect rest-day bonus session (trained on a scheduled rest day)
    const wState = await getTodayWorkoutState(user);
    const bonusNote = wState.type === "REST"
      ? ` ${wState.todayName} is your rest day and you trained anyway — extra credit.`
      : "";

    // Proactive form check — once, early (2nd session, when they're settled but form
    // habits are still forming). One clip is the closest thing to hands-on coaching we
    // have. Kept to the 2nd session so it doesn't clash with the 1st-session referral nudge.
    const formVideoPrompt = newTotal === 2
      ? ` 📹 Next session, film one set from the side and send it — I'll check your form.`
      : "";


    await logChat(user.id, message, doneResponse, "WORKOUT_DONE");

    // Coach K is now asking one structured question. Reuse the durable pending-answer slot so
    // its answer survives a process restart and reaches workout-feedback before a prose/logging
    // handler gets a chance to reinterpret it. A newer question replaces the older single-slot
    // expectation, matching the existing awaitingInputType contract.
    const feedbackExpectation = createWorkoutFeedbackExpectation();
    await db.update(users).set({ awaitingInputType: feedbackExpectation }).where(eq(users.id, user.id));
    user.awaitingInputType = feedbackExpectation;

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
          const referralMsg = `One more thing — you just completed your first session. That already puts you ahead of most people who sign up and never start.\n\nIf you know someone who needs this, share your code: *${referralCode}*\n\nWhen they join, *you get a free month* — they come in at R${PRICING.monthlyPriceZAR} with a ${GUARANTEE_PHRASE}, no risk. One message to one person is all it takes.`;
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
    const doneAddOn = [week1Badge, comebackNote, milestoneMsg, formVideoPrompt, perfectDay || "", bonusNote]
      .find(s => s && s.trim()) || "";
    // THE SHAPE (2026-08-06). Confirmation + the one thing worth celebrating, then the next
    // move, then the question — and the answers to that question are the ONLY buttons. Three
    // buttons offering a menu of other topics is a machine changing the subject; a client who
    // has just trained is being asked one thing, so they get the three ways to answer it.
    return [
      `${doneResponse}${doneAddOn}`.trim(),
      `How did that session feel?[BUTTONS:Too easy|Just right|Too hard]`,
    ].filter(Boolean).join("\n\n");
  }


  // LIFT LOGGING REMOVED (2026-08-06, founder's cut-now list). "bench 80kg 3x10", the stored
  // exercise history and the progressive-overload target table are gone. Training is tracked
  // the way a working-class client actually tracks it: which days, and did you train. The
  // exercise_logs table and its rows stay so old data is still deletable under POPIA.

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
    // The new numbers and ONE instruction (2026-08-06 sweep). This used to be seven
    // sentences: the confirmation, the targets, a paragraph of philosophy per goal, and a
    // command to type. The targets ARE the news; the philosophy can wait for a question.
    const goalDetail = goalType === "muscle_gain"
      ? `Eat above that on training days and hit the protein every day — that's what builds muscle.`
      : goalType === "fat_loss"
      ? `Stay under that and hit the protein first at every meal — it's what keeps the muscle while you cut.`
      : `Hold it there and hit the protein — consistency is what locks this in.`;
    return `${nameStr}. Goal updated to *${label}* — new targets are *${newTargets.calorieTarget} kcal* and *${newTargets.proteinTarget}g protein* a day.\n\n${goalDetail}\n\nWant today's ${sessionWord}?[BUTTONS:Today's workout|Not now]`;
  }

  return null;
}

/**
 * Commit a session the client described in prose, then answer how it FELT.
 *
 * Same door as the terse "done" path — one row per day, counters advanced, pattern cache
 * invalidated — so `getTodayWorkoutState` reads ALREADY_DONE afterwards and nothing tells
 * them to train again today. Returns null only if this module shouldn't own the message.
 */
async function logProseSession(
  user: any, phone: string, message: string, report: SessionReport, firstName: string,
): Promise<string | null> {
  const todayStart = sastDayStart();
  const existing = await db.select({ id: workoutLogs.id }).from(workoutLogs)
    .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, todayStart)))
    .limit(1);

  // Already on the board — don't double-count, but still answer the feeling, because
  // being ignored is what the client actually complained about.
  if (existing.length > 0) {
    const dupe = sessionReportReply(report, firstName, user.totalWorkoutsCompleted || 0)
      .replace(/^✅[^\n]*\n\n/, `✅ ${firstName ? firstName + ", " : ""}today's session is already logged.\n\n`);
    await logChat(user.id, message, dupe, "WORKOUT_FEEDBACK");
    return dupe;
  }

  await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true });
  turnMutation("INSERT workout", "[WRITE]");
  invalidatePatternCache(user.id);

  const newTotal = (user.totalWorkoutsCompleted || 0) + 1;
  const trainingDays = user.trainingDaysPerWeek || 3;
  const todaySlot = getTodaySlot(user);
  const nextDay = (todaySlot % trainingDays) + 1;
  const newWeek = todaySlot === trainingDays ? (user.programmeWeek || 1) + 1 : (user.programmeWeek || 1);

  const dayStartSAST = (d: Date) => {
    const sast = new Date(d.getTime() + 2 * 3_600_000);
    return new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate())).getTime();
  };
  const lastWorkout = user.lastWorkoutDate ? new Date(user.lastWorkoutDate) : null;
  const wasYesterday = lastWorkout && dayStartSAST(lastWorkout) === dayStartSAST(new Date(Date.now() - 86_400_000));

  await db.update(users).set({
    totalWorkoutsCompleted: newTotal,
    programmeDayInWeek: nextDay,
    programmeWeek: newWeek,
    lastWorkoutDate: new Date(),
    lastActiveAt: new Date(),
    workoutStreak: wasYesterday ? (user.workoutStreak || 0) + 1 : 1,
  }).where(eq(users.phoneNumber, phone));

  // How it felt has to outlive this message — next session's coaching depends on it.
  storeMemory(phone, sessionMemoryLine(report), "workout").catch(() => {});

  const reply = sessionReportReply(report, firstName, newTotal);
  await logChat(user.id, message, reply, "WORKOUT_DONE");
  return reply;
}
