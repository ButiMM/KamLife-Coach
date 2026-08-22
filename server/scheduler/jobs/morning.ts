import {
  db, users, chatHistory, stepLogs, workoutLogs, mealLogs, escalations,
  eq, gte, and, lt, desc, sql, asc,
  sendWhatsApp, canSendProactive, recordProactiveSend, claimDailySlot, claimProactive, pauseReason,
  getActiveClients, isPaused, dayStart, getYesterdayLogs,
  TRAINING_SCHEDULES, programmeDaysSince, loadProactiveState,
  todaySAST,
} from "../shared";
import { auditStoredTargets, auditStepsTarget } from "../../targets";
import { getNumbersMode } from "../../numbers-mode";
import { readHealthState } from "../../health-state";
// The `re_engagement` A/B went out with the button menu (2026-08-19, Cut 6). Worth recording why
// nothing is lost: it called selectVariantMessage and then DISCARDED the text it chose
// (`const { text: _variantMsg }`) before sending the buttons unchanged. Every arm sent the same
// message, so the experiment measured nothing. Deleting the send deletes an empty measurement.
import { morningClosingLine, composeMorning, yesterdayObservation } from "../../morning-message";
import { adaptTargets, adaptiveInputFrom } from "../../adaptive-targets";
import { chooseAction, decideProactive, formatOneAction, underPolicy } from "../../one-action";

/**
 * WHAT WE SAY TO SOMEONE WHO HAS GONE — decided by the ladder, not written here.
 *
 * (2026-08-19, Cut 6.) There were five wordings for this in the codebase and the one that
 * actually ran was chosen by which cron minute reached the client first, under a daily cap of
 * one. That is a raffle, not a coach. `chooseAction` already holds the real ladder — days, then
 * weeks, then a month, with the ask getting SMALLER and the absolution more explicit the longer
 * they have been gone — and it was unreachable from this job. This is the call it never had.
 *
 * Fails soft, and the fallback is still the ladder: if the ledger cannot be read we ask the same
 * function from the one fact we already hold. A client who is drifting must not get silence
 * because a query timed out, and they must not get a sixth hand-written string either.
 */
async function silenceAsk(client: any, daysSilent: number): Promise<string> {
  const firstName = client.name?.split(" ")[0] || undefined;
  const profile = {
    dreamGoal: client.dreamGoal,
    biggestStruggle: client.biggestStruggle,
    lifeContext: client.lifeContext,
    doNotMention: client.doNotMention,
    weeksOnProgramme: Math.max(0, (client.programmeWeek || 1) - 1),
    sessionsTarget: Number(client.trainingDaysPerWeek) || 3,
    calorieTarget: Number(client.calorieTarget) || 0,
    proteinTarget: Number(client.proteinTarget) || 0,
    stepsTarget: Number(client.stepsTarget) || 0,
  };
  try {
    const state = await loadProactiveState(client);
    const decision = decideProactive(state, profile, { hour: 7 });
    console.log(`[MORNING] ${client.id.slice(-6)} silent=${daysSilent}d decision=${decision.state} action=${decision.action.kind}`);
    return formatOneAction(decision.action, firstName);
  } catch (e) {
    console.warn(`[MORNING] silence decision unavailable for ${client.id?.slice(-6)}:`, (e as Error)?.message);
    // Only the silence rung is reachable from here — `daysSinceAnyLog >= 3` is the first branch
    // chooseAction tests, and a client silent three days cannot have logged inside them. The
    // remaining fields are neutral inputs it will never read, not a second opinion about the day.
    // SAME POLICY BOUNDARY AS THE GATE (2026-08-21). This called chooseAction raw, so on a ledger
    // read failure the morning could send a PRESCRIPTION that decideProactive would have refused
    // for lack of evidence — one decision function, two policies, chosen by which branch ran.
    // We cannot build a ProactiveState here (that is what just failed), so we apply the contract
    // directly: no evidence, no prescription.
    return formatOneAction(underPolicy(chooseAction({
      firstName, goal: (client.goalType as any) || "general",
      dreamGoal: client.dreamGoal, biggestStruggle: client.biggestStruggle,
      lifeContext: client.lifeContext, doNotMention: client.doNotMention,
      weeksOnProgramme: profile.weeksOnProgramme,
      daysSinceAnyLog: daysSilent, daysSinceWeighIn: 0, loggedToday: false,
      proteinPct: 1, caloriePct: 1, sessionsThisWeek: 0, sessionsTarget: 0,
      stepsToday: 0, stepsTarget: 0, hour: 7,
    }), { evidenced: false, dreamGoal: client.dreamGoal }), firstName);
  }
}

export async function runMorningCheckin(): Promise<void> {
  console.log("[SCHEDULER] JOB: Morning check-in");
  const todayDOW = new Date(Date.now() + 2 * 3_600_000).getDay(); // SAST = UTC+2
  void todayDOW; // Sunday check removed — clients need morning coaching 7 days a week
  const yesterdayDOW = (todayDOW - 1 + 7) % 7;

  const clients = await getActiveClients();

  for (const client of clients) {
    // A HEALTH PAUSE NO LONGER SILENCES THE COACH (2026-08-20, phone P0). isPaused() was true for
    // anyone carrying a `sick_until`, because recordSickState writes `paused_until` beside it — so
    // a stale illness flag suppressed the morning entirely, and the client had no way to tell the
    // difference between "the coach thinks I'm resting" and "the coach is broken". The founder
    // spent an evening logging steps and correcting us and got nothing at 06:00.
    //
    // Sickness is an INPUT to the decision below, which ranks `rest` second on purpose. An
    // explicit pause — they asked us to stop — still suppresses, because that one is a request.
    if (pauseReason(client) === "explicit") {
      const pausedUntil = readHealthState(client).pausedUntil;
      if (pausedUntil) {
        const pauseEnd = new Date(pausedUntil);
        const tomorrow = new Date(Date.now() + 86_400_000);
        const isTomorrowEnd = pauseEnd.toISOString().slice(0, 10) === tomorrow.toISOString().slice(0, 10);
        if (isTomorrowEnd && await claimDailySlot(client.id, "morning")) {
          const name = client.name?.split(" ")[0] || "there";
          await sendWhatsApp(client.phoneNumber, `${name}, your coaching pause ends tomorrow. Morning check-ins and workout reminders resume from tomorrow. Your programme is exactly where you left it — nothing resets.`);
        }
      }
      continue;
    }

    const daysSilent = client.lastActiveAt
      ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
      : 0;
    // NO `daysSilent > 7` SKIP (2026-08-19, Cut 6). It used to `continue` here, which is why the
    // ladder's own month-plus rung — "Just say hi. That's the whole ask today." — could never run
    // from this job: the client it was written for was dropped four hundred lines above the call.
    // The silence branch below now owns every absence, so nothing falls through to the brief.

    // ---- TARGET SANITY AUDIT (2026-07-13) — a wrong calorie/protein target must not
    // survive 24h. A tester carried 2,346 kcal that matched NO input combination of our
    // own formula (correct for her profile: ~1,950); six code paths write targets and
    // nothing validated them after the fact. Correct it, tell the client plainly in
    // this morning's brief, and escalate so the founder SEES every correction.
    // Adaptive delivery: a numbers:low client's brief speaks plainly — no kcal or
    // protein-gram figures (step counts stay: they're tangible, their phone shows them).
    const numbersLow = getNumbersMode(client) === "low";
    let targetFixLine = "";
    try {
      const audit = auditStoredTargets(client);
      if (!audit.ok) {
        await db.update(users).set({
          calorieTarget: audit.expectedCal,
          proteinTarget: audit.expectedProt,
        }).where(eq(users.id, client.id));
        client.calorieTarget = audit.expectedCal;
        client.proteinTarget = audit.expectedProt;
        targetFixLine = numbersLow
          ? `🔧 I've fine-tuned your daily targets to the right levels for you — nothing you need to do. `
          : `🔧 I've fine-tuned your daily targets to *${audit.expectedCal} kcal · ${audit.expectedProt}g protein* — the right numbers for your profile. `;
        console.error(`[TARGET_SANITY] corrected ${client.phoneNumber.slice(-4)}: ${audit.reason}`);
        await db.insert(escalations).values({
          userId: client.id, reason: "target_sanity_correction", status: "open",
          triggerMessage: audit.reason || "stored targets out of bounds",
          priority: "high", slaDeadline: new Date(Date.now() + 48 * 3_600_000),
        }).catch(() => {});
      }
    } catch (auditErr) { console.error("[TARGET_SANITY] audit failed:", auditErr); }

    // Steps + programme-pointer sanity (2026-07-13, "across the board"): steps target
    // outside the human range (corruption, not preference) resets to the formula value;
    // programme pointers out of range clamp so workout serving can never index nonsense.
    try {
      const stepAudit = auditStepsTarget(client);
      const daysInCycle = client.trainingDaysPerWeek || 3;
      const dayPtr = client.programmeDayInWeek || 1;
      const weekPtr = client.programmeWeek || 1;
      const fixes: Record<string, number> = {};
      if (!stepAudit.ok) fixes.stepsTarget = stepAudit.expected;
      if (dayPtr < 1 || dayPtr > daysInCycle) fixes.programmeDayInWeek = 1;
      if (weekPtr < 1 || weekPtr > 52) fixes.programmeWeek = 1;
      if (Object.keys(fixes).length > 0) {
        await db.update(users).set(fixes).where(eq(users.id, client.id));
        Object.assign(client, fixes);
        console.error(`[TARGET_SANITY] bounds fix ${client.phoneNumber.slice(-4)}:`, JSON.stringify(fixes));
      }
    } catch (boundsErr) { console.error("[TARGET_SANITY] bounds check failed:", boundsErr); }
    // ── SILENCE HAS ONE OWNER ────────────────────────────────────────────────────────────────
    //
    // (2026-08-19, Cut 6.) Deliberately ABOVE the night-shift skip below. That skip exists
    // because a 6am brief is the wrong message for someone who got home at 5am — it is a
    // statement about the BRIEF, not about whether a client who has vanished ever hears from us.
    // Under the old order a night-shift client could go quiet forever in total silence.
    if (daysSilent >= 3) {
      // ONE ASK PER RUNG PER ABSENCE. The old branch sent a three-button menu — three decisions
      // for someone whose problem is that deciding got too expensive — and it was capped at one
      // send ever, by `awaitingInputType`. Sending the ladder daily instead would be worse: a
      // client gone a month would get twenty-eight messages into an empty room.
      //
      // So the rung is the dedupe key and the absence is the window: the date they last spoke.
      // That yields at most five sends across a month — 3–6 days, week 1, week 2, week 3,
      // month-plus — each one smaller than the last, and then quiet. It resets by construction
      // when they come back and lapse again, because the window is a new date.
      const rung = Math.min(4, Math.floor(daysSilent / 7));
      const absence = new Date(client.lastActiveAt as any).toISOString().slice(0, 10);
      if (await claimProactive(client.id, `silence_w${rung}`, absence)) {
        await sendWhatsApp(client.phoneNumber, await silenceAsk(client, daysSilent));
      }
      continue;
    }

    if (client.workSchedule === "night_shift") continue;

    try {
      // THE SAME SNAPSHOT THE ADAPTIVE JOB READ FIFTEEN MINUTES AGO (2026-08-18, Issue #49
      // step 2). Two jobs speak to one client each morning and until now they assembled two
      // different pictures of them. This is the shared one, and as of step 5 it is the only one:
      // everything below reads from it or from the three recognition queries that remain.
      const state = await loadProactiveState(client);

      // THE ADAPTIVE JOB'S VOICE, SPOKEN HERE (2026-08-18, Issue #49 step 3). runAdaptiveTargets
      // ran at 05:45 and sent its own WhatsApp message outside the daily budget; this job sent
      // another at 06:00 inside it. Two messages, one coach, one of them uncounted. Adaptive now
      // moves the numbers silently and leaves an adapt_note:<date> marker, and its line is folded
      // into the message below — the one that claims the slot.
      //
      // The WORDS come from the same pure engine adaptive asked, against the same snapshot, so
      // there is no second copy of them to drift. Baseline is what the engine reasons from and
      // adaptive never writes it, so this re-derivation is deterministic: identical input,
      // identical line. A marker dated anything but today is stale and ignored.
      let adaptLine = "";
      try {
        const marked = String(client.profileNotes || "").match(/adapt_note:(\d{4}-\d{2}-\d{2})/)?.[1];
        if (marked === todaySAST()) adaptLine = adaptTargets(adaptiveInputFrom(state)).note || "";
      } catch (e) { console.warn("[MORNING] adapt line unavailable:", (e as Error)?.message); }

      const name = client.name || "there";
      const phone = client.phoneNumber;
      const proteinTarget = client.proteinTarget || 120;
      const yesterdayLogs = await getYesterdayLogs(client.id);

      // THE EMPTY-YESTERDAY BRANCH IS GONE (2026-08-18, Issue #49 step 5). A client who logged
      // nothing yesterday used to leave here down a parallel path with its own three sends, its
      // own sick check and its own greeting — a whole second morning message for the clients who
      // need the most coaching. It produced "Send me your breakfast right now" and stopped: no
      // streak, no milestone, no step target, no training day, and no decision, because the
      // decision was computed two hundred lines further down a road they never travelled.
      //
      // They now go through the SAME path as everyone else. yesterdayObservation says "No food
      // logged yesterday — today starts now", decideProactive gets its say, and the client who was
      // hardest to help stops being the one who gets the least. The one thing that branch really
      // owned — the streak shield, which WRITES — survives as an input below.
      let shieldLine = "";
      if (yesterdayLogs.length === 0 && !state.health.sickYesterday) {
        const wStreak0 = client.workoutStreak || 0;
        const currentMonth = todaySAST().slice(0, 7);
        const shieldUsedMonth = (client.profileNotes || "").match(/streak_shield:(\d{4}-\d{2})/)?.[1];
        const clientSchedule = TRAINING_SCHEDULES[client.trainingDaysPerWeek || 4] || TRAINING_SCHEDULES[4];
        const shieldAvailable = clientSchedule.includes(yesterdayDOW) && wStreak0 >= 3 && shieldUsedMonth !== currentMonth;
        if (shieldAvailable) {
          const updatedNotes = (client.profileNotes || "").replace(/streak_shield:\d{4}-\d{2}/, "").trim() + ` streak_shield:${currentMonth}`;
          await db.update(users).set({ profileNotes: updatedNotes }).where(eq(users.id, client.id));
          client.profileNotes = updatedNotes;
          shieldLine = `Good news — your *${wStreak0}-session streak is safe*, your monthly shield's got yesterday covered.`;
        }
      }

      const foodLogs = yesterdayLogs.filter(l => l.intent === "FOOD_LOG");
      const workoutLogged = yesterdayLogs.some(l => l.intent === "WORKOUT_LOG" || (l.messageIn || "").toLowerCase().trim() === "done");

      const yStart = dayStart(-1);
      const yEnd = dayStart(0);
      const ninetyDaysAgoSteps = new Date(Date.now() - 90 * 86_400_000);

      const twentyEightDaysAgo = new Date(Date.now() - 28 * 86_400_000);
      // TWO READS RETIRED WITH THEIR BRANCHES (2026-08-18): the yesterday step total, which only
      // fed the steps receipt, and the fourteen-day meal-slot aggregate, which only fed the
      // worst-slot protein prescription. A query whose sole consumer is gone is not harmless — it
      // is a cost paid every morning for every client, for nothing.
      const [proteinRows, recentStepLogs, monthWorkoutRows] = await Promise.all([
        db.select({ totalProt: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int` })
          .from(mealLogs).where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, yStart), lt(mealLogs.loggedAt, yEnd)))
          .catch((_e: Error) => [{ totalProt: 0 }]),
        db.select({ loggedAt: stepLogs.loggedAt })
          .from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, ninetyDaysAgoSteps)))
          .orderBy(desc(stepLogs.loggedAt))
          .catch((_e: Error) => [] as { loggedAt: Date | null }[]),
        db.select({ count: sql<number>`COUNT(*)::int` })
          .from(workoutLogs)
          .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, twentyEightDaysAgo)))
          .catch(() => [{ count: 0 }]),
      ]);

      const totalProtLogged = (proteinRows as { totalProt: number }[])[0]?.totalProt || 0;

      const schedule = TRAINING_SCHEDULES[client.trainingDaysPerWeek || 4] || TRAINING_SCHEDULES[4];
      const isTodayTrainingDay = schedule.includes(todayDOW);

      // RETIRED: seven day-of-week openers ("Day 2. Consistency beats intensity.", "Body is
      // adapting. Do not stop."). Generic filler that read the calendar and nothing about the
      // client — the same sentence to a woman on a nine-week streak and a man who has not logged
      // in a fortnight. It changed no decision and said nothing true of anyone in particular.
      const progDays = programmeDaysSince(client.programmeStartDate);
      let identityLine = "";
      // DOMS coaching for new clients — soreness on day 2-3 is the #1 early dropout trigger
      if (progDays === 2 && (client.workoutStreak || 0) >= 1) identityLine = " Day 2. Muscles sore? That is the repair happening — it means the session worked. Keep going.";
      else if (progDays === 3 && (client.workoutStreak || 0) >= 1) identityLine = " Day 3. Soreness passing? That is your body adapting. That feeling goes away — the strength stays.";
      else if (progDays === 7)  identityLine = " One week. You showed up every day this week.";
      else if (progDays === 14) identityLine = " Two weeks consistent. You're building something real.";
      else if (progDays === 21) identityLine = ` Week 3. This is where most people quit — not because it got too hard, but because the mirror hasn't changed yet. The change is happening in your muscle tissue and metabolism. It is not visible yet but it is real. Do not stop now.`;
      else if (progDays === 30) identityLine = " A month. You are now the kind of person who trains for a month straight.";
      else if (progDays === 42) identityLine = ` Week 6. This is when visible results start showing. Look closer — your clothes, your posture, your strength. The scale is the last thing to reflect it. The change is already there.`;
      else if (progDays === 60) identityLine = " 60 days. Two months of showing up. That's rare.";
      else if (progDays === 63) identityLine = ` Week 9. The plateau phase. Most people misread this as failure — it is not. Your body is consolidating the changes from the first 8 weeks before the next wave of results. Hold the habits. The breakthrough comes at week 10-12 for those who do not stop here.`;
      else if (progDays === 84) identityLine = ` Week 12. Three months in. Your body has rewritten its baseline — every habit that feels automatic now used to be a deliberate choice. You are in the top 10% of people who start a programme. This is who you are now.`;
      else if (progDays === 90) identityLine = " 90 days. You are not the same person who started this.";

      const wStreak = client.workoutStreak || 0;
      let foodLogStreakCount = 0;
      {
        const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
        const recentFoodLogDays = await db.select({ createdAt: chatHistory.createdAt })
          .from(chatHistory)
          .where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, sixtyDaysAgo)))
          .orderBy(desc(chatHistory.createdAt))
          .catch(() => [] as { createdAt: Date | null }[]);
        const foodDays = new Set<string>();
        for (const l of recentFoodLogDays) {
          if (!l.createdAt) continue;
          const d = new Date(new Date(l.createdAt).getTime() + 2 * 3_600_000);
          foodDays.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
        }
        const foodCheck = new Date(Date.now() + 2 * 3_600_000);
        foodCheck.setUTCDate(foodCheck.getUTCDate() - 1);
        while (true) {
          const key = `${foodCheck.getUTCFullYear()}-${String(foodCheck.getUTCMonth() + 1).padStart(2, "0")}-${String(foodCheck.getUTCDate()).padStart(2, "0")}`;
          if (!foodDays.has(key)) break;
          foodLogStreakCount++;
          foodCheck.setUTCDate(foodCheck.getUTCDate() - 1);
        }
      }
      let stepStreakCount = 0;
      {
        const stepDays = new Set<string>();
        for (const l of recentStepLogs as { loggedAt: Date | null }[]) {
          if (!l.loggedAt) continue;
          const d = new Date(new Date(l.loggedAt).getTime() + 2 * 3_600_000);
          stepDays.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
        }
        const stepCheck = new Date(Date.now() + 2 * 3_600_000);
        stepCheck.setUTCDate(stepCheck.getUTCDate() - 1);
        while (true) {
          const key = `${stepCheck.getUTCFullYear()}-${String(stepCheck.getUTCMonth() + 1).padStart(2, "0")}-${String(stepCheck.getUTCDate()).padStart(2, "0")}`;
          if (!stepDays.has(key)) break;
          stepStreakCount++;
          stepCheck.setUTCDate(stepCheck.getUTCDate() - 1);
        }
      }

      // ── Trajectory classification (28-day compliance) ──────────────────────
      const completedSessions28 = (monthWorkoutRows as { count: number }[])[0]?.count || 0;
      const plannedSessions28 = (client.trainingDaysPerWeek || 3) * 4;
      const sessionCompliance28 = plannedSessions28 > 0 ? completedSessions28 / plannedSessions28 : 0;
      type Trajectory = "ON_A_RUN" | "ON_TRACK" | "RECOVERING" | "STRUGGLING" | "DISENGAGED";
      const trajectory: Trajectory =
        sessionCompliance28 >= 0.8 && wStreak >= 4 ? "ON_A_RUN" :
        sessionCompliance28 >= 0.65              ? "ON_TRACK" :
        sessionCompliance28 >= 0.4 && wStreak >= 1 ? "RECOVERING" :
        completedSessions28 === 0                ? "DISENGAGED" :
                                                   "STRUGGLING";

      // ── Loss-framed streak line ─────────────────────────────────────────────
      // Positive framing for short streaks, loss framing for meaningful ones
      const streakParts: string[] = [];
      if (wStreak >= 10) {
        streakParts.push(
          trajectory === "ON_A_RUN" || trajectory === "ON_TRACK"
            ? `🔥 *${wStreak}-session streak* — keep it going`
            : `🔥 *${wStreak}-session streak* — you have built real momentum here`
        );
      } else if (wStreak >= 5) {
        streakParts.push(`🔥 *${wStreak}-session streak* — protect it`);
      } else if (wStreak >= 2) {
        streakParts.push(`🔥 *${wStreak}-session streak*`);
      }
      if (stepStreakCount >= 5) {
        streakParts.push(`🚶 *${stepStreakCount}-day step streak* — keep it alive`);
      } else if (stepStreakCount >= 2) {
        streakParts.push(`🚶 ${stepStreakCount}-day step streak`);
      }
      // Only claim a food streak when yesterday actually had food — otherwise the
      // "No food logged yesterday" line below contradicts it ("5-day food streak" +
      // "No food logged yesterday" was a real screenshot).
      if (foodLogStreakCount >= 3 && foodLogs.length > 0) streakParts.push(`🍽️ ${foodLogStreakCount}-day food streak`);
      const streakLine = streakParts.length ? ` ${streakParts.join(" · ")}.` : "";

      // RETIRED: the trajectory prefix ("Today is the reset.", "Today is the day we change
      // this."). The closing line below is already trajectory-driven, so this said the same thing
      // about the same client twice in one message, once at each end.

      // ONE OBSERVATION, NOT A SECOND PROTEIN POLICY. This was five branches ending in a
      // fourteen-day worst-meal-slot analysis that prescribed a fix ("Your dinners average only
      // 22g protein — tonight: lead dinner with 200g chicken…"). That is a coaching instruction,
      // reached by completely different reasoning from decideProactive's, in the same message as
      // decideProactive's instruction: fix dinner AND get a walk in AND log breakfast, from three
      // parts of one message that had never met each other. Protein is the decision owner's — it
      // already ranks protein above steps and training for exactly this reason.
      const yesterdayLine = yesterdayObservation({
        foodLogged: foodLogs.length > 0,
        proteinLogged: totalProtLogged,
        proteinTarget,
        numbersLow,
      });

      let workoutLine = "";
      if (workoutLogged) {
        const totalW = client.totalWorkoutsCompleted || 0;
        const workoutMsg =
          totalW === 1  ? `First session in the books. That's the hardest one.` :
          totalW === 3  ? `Three sessions done. The habit is starting.` :
          totalW === 5  ? `Five sessions. You're past the point where most people quit.` :
          totalW === 10 ? `Ten sessions. You've made this a real part of your life.` :
          totalW === 25 ? `25 sessions. A quarter of a hundred. This is real now.` :
          totalW === 50 ? `50 sessions. Halfway to a hundred. You've earned every one.` :
          totalW === 100 ? `100 sessions. 💯 That's elite consistency.` :
          (totalW % 10 === 0 && totalW > 0) ? `${totalW} sessions. Keep that momentum.` :
          `Session done yesterday. Sharp.`;
        workoutLine = workoutMsg;
      }


      // One-tap repeat breakfast suggestion
      let repeatSuggestion = "";
      try {
        const weekAgo = new Date(Date.now() - 7 * 86_400_000);
        const recentFoods = await db.select({ messageIn: chatHistory.messageIn })
          .from(chatHistory)
          .where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, weekAgo)))
          .orderBy(desc(chatHistory.createdAt)).limit(14);
        const MEAL_CORRECTION_RE = /\b(has?\s+no\b|have\s+no\b|there.?s\s+no\b|without\b|didn.?t\s+(?:add|put|use|have|spread)\b|no\s+\w+\s+(?:on|in)\b|not\s+have\b)\b/i;
        const breakfastLog = recentFoods.find(l =>
          !!l.messageIn &&
          /\b(breakfast|morning|oats|eggs?|cereal|toast|bread)\b/i.test(l.messageIn) &&
          !MEAL_CORRECTION_RE.test(l.messageIn)
        );
        if (breakfastLog?.messageIn) {
          const meal = breakfastLog.messageIn.replace(/\b(for breakfast|breakfast was|this morning|had|ate|eating|having|i |my )\b/gi, "").trim();
          // The client is told to send this string BACK to log it — it must never be cut
          // mid-word (2026-07-11 live: '…3 slices of bread and coff' — a broken food list
          // the client was asked to type verbatim). Fit whole items or trim at the last
          // comma so items survive; skip the suggestion entirely if it can't fit cleanly.
          let mealShort = meal.length <= 90 ? meal : "";
          if (!mealShort && meal.length > 90) {
            const cut = meal.slice(0, 90);
            const lastComma = cut.lastIndexOf(",");
            if (lastComma > 20) mealShort = cut.slice(0, lastComma).trim();
          }
          if (mealShort.length > 3) {
            repeatSuggestion = `\n\n💡 Same breakfast as last time? Reply *"${mealShort}"* to log it instantly.`;
          }
        }
      } catch { /* non-critical */ }

      const stepsTarget = client.stepsTarget || 8500;

      // TODAY'S PLAN — what they are being asked to do, which is not a receipt of what they did.
      const todaySection: string[] = [];
      todaySection.push(`*Today:*`);
      // Voice pass (2026-07-13): the how-to-log instruction repeated EVERY morning
      // forever — three ideas of clutter a day-60 client has read sixty times. New
      // clients (first week) get the how-to once a day while the habit forms; after
      // that the line is just the target. Plain, one idea.
      const daysOnProg = client.programmeStartDate
        ? Math.floor((Date.now() - new Date(client.programmeStartDate).getTime()) / 86_400_000)
        : 999;
      todaySection.push(daysOnProg <= 7
        ? `👟 ${stepsTarget.toLocaleString()} steps — your phone counts them. Send me tonight's number or a screenshot.`
        : `👟 ${stepsTarget.toLocaleString()} steps`);

      if (isTodayTrainingDay) {
        // No inline "preview" — slicing the first 4 lines of the workout only ever
        // showed the header + warm-up cut off mid-sentence with "...". The full
        // workout is one reply away and renders properly there.
        todaySection.push(`💪 Training day. Reply *1* for your workout.`);
      } else {
        todaySection.push(`🛌 Rest day. No training — stay on food and steps.`);
      }

      // Trajectory-aware closing line. ENGAGEMENT-AWARE (2026-07-19 live: a client with a
      // 19-day food streak + 2-session streak got "Good to have you back" — trajectory is
      // workout-only, so a daily logger who trains moderately read as lapsed-and-returned).
      // Someone logging every day never left: the absence-framed lines are gated out.
      const activelyEngaged = foodLogStreakCount >= 3;
      const closingLine = morningClosingLine(trajectory, { activelyEngaged, completedSessions28 });

      if (await claimDailySlot(client.id, "morning")) {
        // THE ONE ACTION, NOT A GENERIC ASK (2026-07-29). This slot used to be
        // "🍳 What's for breakfast?" — the same sentence to every client every morning,
        // whether they were on a 6-day streak, three weeks silent, sick, or had never once
        // stood on a scale. The decision that reads all of that already existed and was wired
        // to a command nobody knows to type; this is where it reaches people.
        //
        // It REPLACES the breakfast question rather than joining it. Two asks in one message is
        // two decisions for someone who hasn't had coffee, and the whole point is one.
        // Fail-open: any error and the old ask goes out unchanged.
        // ONE DECISION OWNER, ONE STATE (2026-08-18, Issue #49 step 4). This called
        // buildDayState(client) — a SECOND state assembly, five more queries, run moments after
        // loadProactiveState had already read the same ledgers. Two assemblies inside the one job
        // that was itself the second coach. It now decides from the snapshot above, through
        // decideProactive, which pairs the action with the SAME verdict vocabulary the reactive
        // path uses (CONTINUE / CHANGE / INVESTIGATE / REFER).
        //
        // "hold" still means the breakfast question is the right ask — least intervention. The
        // decision says so explicitly now (empty line, verdict CONTINUE) instead of the caller
        // inferring it from a kind string.
        const breakfastAsk = `🍳 What's for breakfast?${repeatSuggestion || ""}`;
        let decisionLine = "";
        try {
          const decision = decideProactive(state, {
            dreamGoal: client.dreamGoal,
            biggestStruggle: client.biggestStruggle,
            lifeContext: client.lifeContext,
            doNotMention: client.doNotMention,
            weeksOnProgramme: Math.floor(progDays / 7),
            // THE SCHEDULE IS PART OF THE STATE THE DECISION READS (2026-08-21, handset).
            //
            // The 06:00 brief sent this, in one message:
            //
            //     🛌 Rest day. No training — stay on food and steps.
            //     …
            //     Get today's session done.
            //
            // Because the rest-day headline was computed HERE from isTodayTrainingDay, and the
            // action line came from decideProactive — which was handed
            // `sessionsTarget: trainingDaysPerWeek` regardless of what day it was. The decision
            // owner literally could not know today was a rest day, so it did its job correctly on
            // false input and told a resting client to train.
            //
            // This is the same dual-authority disease the whole cut removed from the reactive
            // path, sitting in the proactive brief. The fix is not a new policy: it is telling
            // the one decision owner the truth. On a rest day no session is expected today, and
            // sessionsTarget: 0 says exactly that in the vocabulary chooseAction already has.
            sessionsTarget: isTodayTrainingDay ? (Number(client.trainingDaysPerWeek) || 3) : 0,
            calorieTarget: Number(client.calorieTarget) || 0,
            proteinTarget: Number(client.proteinTarget) || 0,
            stepsTarget: Number(client.stepsTarget) || 0,
          }, { hour: 7 });
          decisionLine = decision.line;
          console.log(`[MORNING] ${client.id.slice(-6)} decision=${decision.state} evidence=${decision.evidence} action=${decision.action.kind}`);
        } catch (e) {
          console.warn("[MORNING] one-action skipped:", (e as any)?.message || e);
        }
        // ONE COMPOSER. Every part above is now an INPUT, not a branch that assembles its own
        // slice of the message. The order of the message is decided in one place.
        await sendWhatsApp(phone, composeMorning({
          firstName: name,
          targetFixLine,
          identityLine,
          streakLine,
          workoutLine: shieldLine || workoutLine,
          yesterdayLine,
          todayLines: todaySection,
          closingLine,
          decisionLine,
          breakfastAsk,
          adaptLine,
          sickYesterday: state.health.sickYesterday,
        }));
      }
    } catch (err) {
      console.error(`[SCHEDULER] Morning check-in error — ${client.phoneNumber}:`, err);
    }
  }
}
