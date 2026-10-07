import {
  db, users, escalations, eq,
  claimDailySlot, claimProactive, pauseReason,
  getActiveClients, TRAINING_SCHEDULES, programmeDaysSince, loadProactiveState,
  todaySAST, recordWeighAsk,
} from "../shared";
import { auditStoredTargets, auditStepsTarget } from "../../targets";
import { getNumbersMode } from "../../numbers-mode";
import { readHealthState } from "../../health-state";
// The `re_engagement` A/B went out with the button menu (2026-08-19, Cut 6). Worth recording why
// nothing is lost: it called selectVariantMessage and then DISCARDED the text it chose
// (`const { text: _variantMsg }`) before sending the buttons unchanged. Every arm sent the same
// message, so the experiment measured nothing. Deleting the send deletes an empty measurement.
import { scheduledWords } from "../../core/coach";
import { adaptTargets, adaptiveInputFrom } from "../../adaptive-targets";
import { chooseAction, decideProactive, formatOneAction, underPolicy } from "../../one-action";
import { ensureOpenTrainingLoop, loadOpenTrainingLoop } from "../../memory";
import { readHeldConstraints } from "../../held-constraints";
import { foodConstraints } from "../../food-swaps";
import { deliveryAccepted } from "../../outbound-delivery";
import { sendProactive, proactiveHold } from "../proactive-decision";
import { getBehaviourPatternContext } from "../../core/client-record";

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
async function silenceAsk(client: any, daysSilent: number, named = true): Promise<{ text: string; weigh: boolean }> {
  const firstName = client.name?.split(" ")[0] || undefined;
  const behaviourPatterns = await getBehaviourPatternContext(client.id);
  const profile = {
    dreamGoal: client.dreamGoal,
    biggestStruggle: client.biggestStruggle,
    lifeContext: client.lifeContext,
    doNotMention: client.doNotMention,
    behaviourPatterns,
    constraints: foodConstraints(client || {}),
    weeksOnProgramme: Math.max(0, (client.programmeWeek || 1) - 1),
    sessionsTarget: Number(client.trainingDaysPerWeek) || 3,
    calorieTarget: Number(client.calorieTarget) || 0,
    proteinTarget: Number(client.proteinTarget) || 0,
    stepsTarget: Number(client.stepsTarget) || 0,
  };
  try {
    const state = await loadProactiveState(client);
    // NO MEAL ROW IS NOT A GAP (#275) — but this client's silence IS measured, from their last
    // message, and that is the absence this job exists to answer.
    if (state.food.daysSinceAnyLog === null) state.food.daysSinceAnyLog = daysSilent;
    const decision = decideProactive(state, profile, { hour: 7 });
    console.log(`[MORNING] ${client.id.slice(-6)} silent=${daysSilent}d decision=${decision.state} action=${decision.action.kind}`);
    return { text: formatOneAction(decision.action, named ? firstName : undefined), weigh: decision.action.kind === "weigh" };
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
    return { weigh: false, text: formatOneAction(underPolicy(chooseAction({
      firstName, goal: (client.goalType as any) || "general",
      dreamGoal: client.dreamGoal, biggestStruggle: client.biggestStruggle,
      lifeContext: client.lifeContext, doNotMention: client.doNotMention,
      weeksOnProgramme: profile.weeksOnProgramme,
      daysSinceAnyLog: daysSilent, daysSinceWeighIn: 0, loggedToday: false,
      proteinPct: 1, caloriePct: 1, sessionsThisWeek: 0, sessionsTarget: 0,
      stepsToday: 0, stepsTarget: 0, hour: 7,
      // NO INVESTIGATION CONTEXT ON PURPOSE (#203). `loggedToday` and `daysSinceWeighIn` above are
      // placeholders for a ledger read that just FAILED, not facts. Handing them to the downgrade
      // would ask a client to log off a value we invented, so this keeps the gate's default: hold.
    }), { foodSufficient: false, weightSufficient: false, dreamGoal: client.dreamGoal }), named ? firstName : undefined) };
  }
}

export async function runMorningCheckin(): Promise<void> {
  console.log("[SCHEDULER] JOB: Morning check-in");
  const todayDOW = new Date(Date.now() + 2 * 3_600_000).getDay(); // SAST = UTC+2
  void todayDOW; // Sunday check removed — clients need morning coaching 7 days a week

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
          await sendProactive(client, { claimed: "morning" }, `${name}, your coaching pause ends tomorrow. Morning check-ins and workout reminders resume from tomorrow. Your programme is exactly where you left it — nothing resets.`, { duringPause: true });
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
      const hold = proactiveHold(client);
      if (!hold && await claimProactive(client.id, `silence_w${rung}`, absence)) {
        const hello = await scheduledWords(client.phoneNumber, "silence"); // B6 (#319): the ladder's ask stays the one move
        const ask = await silenceAsk(client, daysSilent, !hello);
        const sent = await sendProactive(client, { claimed: `silence_w${rung}` }, hello ? `${hello}\n\n${ask.text}` : ask.text);
        if (sent && ask.weigh && deliveryAccepted(sent)) await recordWeighAsk(client.id);
      }
      continue;
    }

    if (client.workSchedule === "night_shift") continue;

    try {
      // THE SAME SNAPSHOT THE ADAPTIVE JOB READ FIFTEEN MINUTES AGO (Issue #49): one picture of the client.
      const state = await loadProactiveState(client);

      // THE ADAPTIVE JOB'S VOICE, SPOKEN HERE (Issue #49 step 3): adaptive moves the numbers silently and
      // leaves an adapt_note:<date> marker; its line rides in this message, the one that claims the slot.
      let adaptLine = "";
      try {
        const marked = String(client.profileNotes || "").match(/adapt_note:(\d{4}-\d{2}-\d{2})/)?.[1];
        if (marked === todaySAST()) adaptLine = adaptTargets(adaptiveInputFrom(state, client)).note || "";
      } catch (e) { console.warn("[MORNING] adapt line unavailable:", (e as Error)?.message); }

      const name = client.name?.split(" ")[0] || "there";
      const phone = client.phoneNumber;
      const schedule = TRAINING_SCHEDULES[client.trainingDaysPerWeek || 4] || TRAINING_SCHEDULES[4];
      const isTodayTrainingDay = schedule.includes(todayDOW);
      const progDays = programmeDaysSince(client.programmeStartDate);

      if (await claimDailySlot(client.id, "morning")) {
        // ONE DECISION OWNER, ONE STATE (Issue #49 step 4): decideProactive picks the one action from the
        // snapshot above. "hold" means the breakfast question is the right ask (least intervention).
        let decisionLine = "";
        let selectedTrainingMove = false;
        let selectedWeigh = false;
        let selectedTrainingIntervention: "standard" | "minimum" = "standard";
        try {
          // ONE READER FOR BOTH CONSTRAINTS (P0-4b): "I'm not training today" holds here as it does outbound.
          const held = await readHeldConstraints(phone, client);
          const openTraining = await loadOpenTrainingLoop(client);
          const behaviourPatterns = await getBehaviourPatternContext(client.id);
          const decision = decideProactive(state, {
            dreamGoal: client.dreamGoal,
            biggestStruggle: client.biggestStruggle,
            lifeContext: client.lifeContext,
            doNotMention: client.doNotMention,
            behaviourPatterns,
            constraints: foodConstraints(client || {}),
            weeksOnProgramme: Math.floor(progDays / 7),
            sessionsTarget: isTodayTrainingDay ? (Number(client.trainingDaysPerWeek) || 3) : 0,
            calorieTarget: Number(client.calorieTarget) || 0,
            proteinTarget: Number(client.proteinTarget) || 0,
            stepsTarget: Number(client.stepsTarget) || 0,
          }, {
            hour: 7,
            foodDayClosed: held.foodDayClosed,
            trainingDeclined: held.trainingDeclined,
            trainingAwaitingOutcome: !!openTraining,
          });
          decisionLine = decision.line;
          selectedTrainingMove = decision.action.kind === "train";
          selectedWeigh = decision.action.kind === "weigh";
          selectedTrainingIntervention = decision.action.intervention === "minimum_training" ? "minimum" : "standard";
          console.log(`[MORNING] ${client.id.slice(-6)} decision=${decision.state} evidence=${decision.evidence} action=${decision.action.kind}`);
        } catch (e) {
          console.warn("[MORNING] one-action skipped:", (e as any)?.message || e);
        }
        // B1 (#319): the new coach's recognition, then the decision's one line. The morning after an
        // illness carries no instruction at all (#546 attack): a recovery check-in only. CORE_WAVE4=off
        // (or no words) leaves the plain greeting in front of the same decision.
        const sick = state.health.sickYesterday;
        const words = await scheduledWords(phone, "morning", sick ? "They were unwell yesterday. Ask how they feel today; nothing else." : "");
        const greeting = words || (sick ? `Morning ${name}. Hope you're feeling better. When you're ready, just say Hi and we pick up from where you left off.` : `Morning ${name}.`);
        const move = sick ? "" : decisionLine || "🍳 What's for breakfast?";
        // OUTSIDE THE WINDOW, THE CLIENT STILL GETS THEIR ACTION (Cut 6): kamlife_daily_plan carries their
        // name and today's one action; with none to carry, the generic check-in runs as `substituted`.
        const oneAction = ((sick ? "" : decisionLine) || targetFixLine || "").trim();
        const dailyTemplate = oneAction ? { name: "kamlife_daily_plan", variables: { "1": name, "2": oneAction } } : undefined;
        const delivery = await sendProactive(client, { claimed: "morning" },
          [targetFixLine.trim(), greeting, adaptLine, move].filter(Boolean).join("\n\n"), { template: dailyTemplate });
        if (!delivery || sick) continue;
        if (selectedWeigh && deliveryAccepted(delivery)) await recordWeighAsk(client.id);
        if (selectedTrainingMove && deliveryAccepted(delivery)) {
          await ensureOpenTrainingLoop(client, todaySAST(), "proactive", Date.now(), selectedTrainingIntervention);
        }
      }
    } catch (err) {
      console.error(`[SCHEDULER] Morning check-in error — ${client.phoneNumber}:`, err);
    }
  }
}
