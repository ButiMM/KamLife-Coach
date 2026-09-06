/**
 * Miscellaneous command handlers — supplements, motivation, stats, progress, NPS, etc.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { assessWeightRate } from "./weight";
import {
  users, weightLogs, workoutLogs, stepLogs, chatHistory,
  bodyMeasurements, clothingCheckins,
} from "../../shared/schema";
import { eq, desc, asc, and, gte, sql } from "drizzle-orm";
import { SUPPLEMENT_GUIDE } from "../constants";
import { shareAchievement } from "../achievement-card";
import { achievementCardMarker } from "../macro-card-attach";
import { computeFoodLogStreak } from "./food-scanner";
import { getExerciseGifUrl, getPrimaryWorkoutGifUrl, getPortionGuide, getExerciseDemoFormCue } from "../exercise-media";
import { matchVariantGuideRequest, formatVariantGuide } from "../exercise-variants";
import {
  buildDayWorkout, buildFullProgramme,
  getKamlifeProgramme, getDayType, getPhaseNames,
} from "../programme";
import { buildWorkoutViewerUrl } from "../workout-viewer";
import { buildDailyDirection } from "../daily-direction";
import { oneActionCommand } from "./one-action-command";
import { getTodayWorkoutState } from "../workout-state";
import { getOnboardingMealPlan } from "../onboarding";
import { askCoachK } from "../gpt";
import { withTimeout, logChat } from "./chat-log";
import { calculateTargets, waterTargetLitres, bmiOf } from "../targets";
import { JUNK_WORDS } from "./checks";
import { getStepStreak } from "./steps";
import { scanForSAFoods } from "./food-scanner";
import { storeMemory, addFact } from "../memory";
import { sendWhatsApp } from "../scheduler";
import { sastDayStart, classifyPainReport , getDisplayName} from "../utils";
import { looksLikeDirectionRequest } from "../daily-direction";
import { isDespairNotAQuestion } from "../despair";
import { SA_FOODS_SEED } from "../foods";
import { turnEvidence } from "./chat-log";
import { readHeldConstraints, foodDayClosedWith } from "../held-constraints";
import { foodConstraints, allowedAlternatives } from "../food-swaps";
import { getDayLedger, getProgressTruth, sessionsThisCalendarWeek, getWeightTruth } from "../day-ledger";
import { daysOnProgramme } from "../day-ledger-core";
import { currentDateAnswer, isCurrentDateQuestion } from "../understanding/current-date";
import { PRICING, GUARANTEE_PHRASE } from "../../shared/pricing";

// Protein keywords built from SA food database (same logic as routes.ts)
const PROTEIN_WORDS: string[] = Array.from(new Set([
  ...SA_FOODS_SEED
    .filter(f => f.proteinPer100g >= 8 || f.typicalPortionProtein >= 10)
    .flatMap(f => [f.name.toLowerCase(), ...f.aliases.map((a: string) => a.toLowerCase())]),
  "protein", "shake", "whey", "steak", "braai", "wors", "boerewors",
  "smileys", "mogodu", "tripe", "liver", "walkie talkies", "chicken feet",
  "oxtail", "ox tail", "sosaties", "chesa nyama", "bobotie",
  "chicken", "beef", "fish", "tuna", "mince", "pork", "lamb", "turkey",
  "salmon", "hake", "sardine", "sardines", "prawn", "prawns", "biltong",
  "droëwors", "droewors", "cottage cheese", "greek yoghurt", "greek yogurt",
]));

export async function handleMiscCommands(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
  isQuestion?: boolean; // systemic QUESTION gate — see early-commands.ts
  /** This turn already INSERT-ed a durable fact. Educational mouths must not consume a remaining ask. */
  wroteThisTurn?: boolean;
}): Promise<string | null> {
  const { phone, message, m, user, wroteThisTurn } = ctx;

  // Calendar facts are deterministic SAST state, not coaching.
  if (isCurrentDateQuestion(message)) {
    const reply = currentDateAnswer();
    await logChat(user.id, message, reply, "CURRENT_DATE");
    return reply;
  }

  // ---- DIRECTION / OVERALL PLAN ---- The client wants the WHOLE plan across every pillar (train/rest, food, steps, water), not a bare workout dump (2026-07-09: a client asked and got an exercise list). Deterministic, from their real targets and today's training state. The shared detector (utils.looksLikeDirectionRequest) ALSO gates the brain in routes.ts, so a direction ask can never be swallowed by the model (2026-07-11: the brain answered it with a workout dump on a rest day).
  // THE ONE ACTION FIRST (2026-07-28): "just tell me what to do" is a different question from "give me my whole plan", and the answer to the first must never be the second. See server/one-action.ts.
  if (/^(?:one thing|what now|what should i do(?: today)?|whats? my one thing|today.?s one thing)\??$/i.test(m.trim())) return await oneActionCommand(user);

  // Distance to goal is a progress-truth question, not the daily-direction card.
  // "How far am I from my goal???" must not fall through to GPT or to the plan menu.
  if (/\bhow far (?:am i|are we) (?:from|to) (?:my |the |our )?(?:goal|target|dream)\b/i.test(m)
      || /\bhow far from (?:my |the )?(?:goal|target)\b/i.test(m)) {
    try {
      const seed = user.programmeStartDate || user.createdAt;
      const daysOn = seed
        ? Math.max(1, Math.floor((Date.now() - new Date(seed).getTime()) / 86_400_000))
        : 1;
      const truth = await getProgressTruth(user, { days: daysOn + 1, clientMessage: message });
      const weekN = await sessionsThisCalendarWeek(user.id).catch(() => 0);
      const want = Number(user.trainingDaysPerWeek) || 0;
      const name = getDisplayName(user) || "there";
      const bits: string[] = [];
      const change = truth.weight.changeKg;
      const scaleOff = /\b(weight|scale|weigh)\b/i.test(String(user.doNotMention || ""));
      // THE DISTANCE FIRST — it is the question (2026-08-27, live phone trace).
      //
      // This block already ended on "That's the distance" and never contained one: it recited the
      // change since start, the week's sessions and today's protein, and left a client holding
      // 92kg with an 85kg target no closer to knowing they had 7kg to go. The gap now comes from
      // getWeightTruth, the one reader that owns what the scale says, so this mouth and every
      // other surface cannot disagree about it.
      //
      // It leads, and the recital still follows: they asked how far, and the rest is the context
      // that makes the number mean something. When there is no target or no weigh-in there is no
      // distance to state, and the answer is exactly what it was before.
      const toGoal = truth.weight.toGoalKg;
      if (!scaleOff && toGoal !== null && truth.weight.currentKg !== null) {
        const kg = Math.abs(toGoal);
        bits.push(kg < 0.1
          ? `You're at your goal weight — ${truth.weight.currentKg}kg.`
          : `${kg.toFixed(1)}kg to ${toGoal < 0 ? "go" : "gain"}: ${truth.weight.currentKg}kg now, ${Number(user.targetWeightKg)}kg the goal.`);
      }
      if (!scaleOff && truth.weight.known && change !== null) {
        bits.push(change < 0
          ? `Scale: down ${Math.abs(change).toFixed(1)}kg since you started.`
          : change > 0
            ? `Scale: up ${change.toFixed(1)}kg since you started.`
            : `Scale: unchanged since you started.`);
      } else if (!scaleOff && truth.weight.currentKg) {
        bits.push(`Scale: ${truth.weight.currentKg}kg — not enough weigh-ins for a trend.`);
      } else if (!scaleOff) {
        bits.push("I don't have a trend I can stand behind. Hop on the scale and I'll give you a straight read.");
      }
      if (want) bits.push(`This week: ${weekN}/${want} sessions.`);
      if (truth.today.protein || user.proteinTarget) {
        bits.push(`Today's protein: ${truth.today.protein}g / ${user.proteinTarget || "—"}g.`);
      }
      const reply = `${name} — ${bits.join(" ")}\n\nThat's the distance. The next move is still one thing.`;
      await logChat(user.id, message, reply, "GOAL_DISTANCE");
      return reply;
    } catch (e) { console.error("[GOAL_DISTANCE]", e); }
  }

  if (looksLikeDirectionRequest(m)) {
    const ws = await getTodayWorkoutState(user).catch(() => ({ type: "NORMAL" as const }));
    return buildDailyDirection(user, ws as any);
  }

  // "What have you learned about me?" — surface the un-copyable personal intelligence so the
  // client feels what a saved/stolen plan can never know about them (#3 retention).
  if (/\bwhat (?:have you|did you|do you|d.?you) (?:learn(?:ed|t)?|notic\w*|figured?\s*out)(?:\s+about\s+me)?\b|\bwhat do you know about me\b|\b(?:my profile|tell me about myself)\b/i.test(m)) {
    const { getClientFacingInsight } = await import("../intelligence/profile");
    const insight = await getClientFacingInsight(user.id, (user.name || "").split(" ")[0] || "");
    return insight || `Still learning you — a couple more weeks of logs and I'll show you exactly what I see. The more you log, the sharper I get on *you* specifically.`;
  }

  // ---- WEEK 9 PATH CHOICE ----
  if (user.awaitingInputType === "week9_choice") {
    const isMaintenance = /^1$|^maintenance$/i.test(m.trim());
    const isAdvanced = /^2$|^advanced$/i.test(m.trim());
    if (isMaintenance || isAdvanced) {
      const daysPerWeek = isMaintenance ? 3 : 5;
      const newPhase = isAdvanced ? 2 : 1;
      await db.update(users).set({
        awaitingInputType: null,
        trainingDaysPerWeek: daysPerWeek,
        programmePhase: newPhase,
        programmeWeek: 1,
        programmeDayInWeek: 1,
      }).where(eq(users.phoneNumber, phone));
      const firstName = user.name?.split(" ")[0] || "";
      const week9Goal = user.goalType || "fat_loss";
      const modeLabel = isMaintenance ? "Maintenance" : "Advanced";
      let modeDesc: string;
      if (isMaintenance) {
        modeDesc = week9Goal === "muscle_gain"
          ? "3 sessions/week. Built to hold your muscle and strength without overloading your recovery."
          : week9Goal === "recomposition"
          ? "3 sessions/week. Sustainable structure to keep the recomp going without burnout."
          : "3 sessions/week. Built to sustain your fat loss results without burning out.";
      } else {
        modeDesc = week9Goal === "muscle_gain"
          ? "5 sessions/week. Higher volume, progressive overload, new movements — maximum muscle stimulus."
          : week9Goal === "recomposition"
          ? "5 sessions/week. Harder progressions, body composition focus — muscle up, fat down."
          : "5 sessions/week. Harder progressions, new exercises — push your body composition further.";
      }
      const reply = `${firstName}, *${modeLabel} Phase* locked in.\n\n${modeDesc}\n\nYour programme resets from Week 1 with the new structure. Reply *today* for your first session.`;
      await logChat(user.id, message, reply, "WEEK9_CHOICE");
      return reply;
    }
  }

  // ---- SUPPLEMENT INSTANT GUIDE (Item 22) — hardcoded, no GPT ----
  const suppKeywords: Record<string, string> = {
    "creatine": "creatine",
    "protein powder": "protein powder",
    "protein shake": "protein powder",
    "whey isolate": "whey",
    "whey protein": "whey",
    "whey": "whey",
    "pre workout": "pre-workout",
    "pre-workout": "pre-workout",
    "preworkout": "pre-workout",
    "bcaa": "bcaa",
    "fat burner": "fat burner",
    "fat burning": "fat burner",
    "multivitamin": "multivitamin",
    "multi vitamin": "multivitamin",
    "vitamin": "multivitamin",
  };
  const suppMatch = Object.entries(suppKeywords).find(([kw]) => m.includes(kw));
  if (suppMatch || m.includes("supplement") || m.includes("what should i take") || m.includes("should i take")) {
    // ALREADY TAKING IT (2026-07-16 live: 'But I'm already taking creatine daily' was
    // first week-gated, then SOLD the full creatine pitch — contradiction + deaf). A
    // client already on a supplement gets acknowledgment + usage guidance, no gate, no sell.
    if (/\b(already|currently)\b.{0,20}\b(taking|on|using|use|drink(ing)?)\b/i.test(m) || /\bi take\b/i.test(m)) {
      const suppName = suppMatch ? suppMatch[1] : "it";
      const alreadyReply = suppName === "creatine"
        ? `Good — keep the creatine going: 5g every day (training days and rest days), any time, with water. Consistency is the whole game with it; you'll feel the full effect after 2–4 weeks. Nothing else needed.`
        : `Good — if it's working for you and it's a basic (${suppName}), keep it consistent and keep your protein from real food the priority. If you ever notice side effects, tell me.`;
      await logChat(user.id, message, alreadyReply, "SUPPLEMENT");
      return alreadyReply;
    }
    // Supplement week gate — locked before week 4, BUT safety/medical questions always get
    // through, and a RESET programme week never re-locks a veteran (2026-07-16: a rebuild
    // set programmeWeek back to 1 and week-gated a 21-session client): lifetime sessions count.
    const isSafetyQuestion = /\b(safe|safety|danger|dangerous|side effect|kidney|liver|heart|allergy|allergic|interact|reaction|risk|harm|harmful|dose|overdose|too much|cancer|blood pressure|diabetes)\b/i.test(m);
    const progWeek = user.programmeWeek || 1;
    const isVeteran = (user.totalWorkoutsCompleted || 0) >= 12;
    if (progWeek < 4 && !isVeteran && !isSafetyQuestion) {
      const weekGate = `Supplements unlock at Week 4.\n\nYou are in Week ${progWeek} — food consistency is the foundation. No supplement will out-work a solid week of eating right.\n\nFocus now: hit your ${user.proteinTarget || 120}g protein target daily from real food. When you reach Week 4, I give you the full supplement protocol — creatine, protein timing, the works.`;
      await logChat(user.id, message, weekGate, "SUPPLEMENT_GATED");
      return weekGate;
    }
    const suppKey = suppMatch ? suppMatch[1] : null;
    let suppReply: string;
    if (suppKey && SUPPLEMENT_GUIDE[suppKey]) {
      suppReply = SUPPLEMENT_GUIDE[suppKey];
    } else {
      // General supplement overview
      suppReply = `*Supplement priority order for ${user.goalType === "muscle_gain" ? "muscle gain" : "fat loss"}:*\n\n1. Creatine — 5g daily. R80-120/month. Proven, safe, cheap. Start here.\n2. Protein powder — only if you cannot hit your ${user.proteinTarget || 140}g protein target from food. Whey isolate, USN or Biogen.\n3. Pre-workout — replace with black coffee. Free and identical.\n4. Everything else — skip it. Food first, always.\n\nFat burners: none are proven. Do not spend money on them.`;
    }
    await logChat(user.id, message, suppReply, "SUPPLEMENT");
    return suppReply;
  }

  // ---- FIX 3: HANDLER 3 — Motivation and struggle ----

  // ---- PAIN TRIAGE — soreness vs. real injury (2026-07-12, Kam: "catch whether it's just
  // sensitivity from a workout or a real injury"). The old handler fired the full STOP-72-HOURS
  // protocol on ANY pain mention, and over-reacting to normal DOMS kills momentum. Now: clear
  // injury → protocol (PERSISTED, so the programme trains around it); ambiguous → ONE triage
  // question; plain soreness → the DOMS handler.
  const painClass = classifyPainReport(m);
  if (painClass === "injury" || painClass === "ambiguous") {
    const injuredArea = m.includes("knee") ? "knee" : m.includes("shoulder") ? "shoulder" : m.includes("back") ? "back" : m.includes("ankle") ? "ankle" : m.includes("wrist") ? "wrist" : m.includes("hip") ? "hip" : m.includes("neck") ? "neck" : m.includes("elbow") ? "elbow" : "the affected area";

    if (painClass === "ambiguous") {
      // Ask the coach's question before prescribing anything — stash the area so the
      // answer (caught at the top of early-commands) knows what we're talking about.
      await db.update(users).set({ awaitingInputType: `pain_triage:${injuredArea}` }).where(eq(users.id, user.id)).catch(() => {});
      const triageQ = `Before I change anything — help me understand the pain in ${injuredArea === "the affected area" ? "that area" : `your ${injuredArea}`}:\n\nIs it *sharp or stabbing* (especially in the joint, or worse when you load it)?\nOr more of a *dull all-over soreness/stiffness* that eases once you warm up?\n\n[BUTTONS:Sharp / stabbing|Just sore / stiff]`;
      await logChat(user.id, message, triageQ, "PAIN_TRIAGE");
      return triageQ;
    }

    const safeAlternative: Record<string, string> = {
      knee: "upper body — chest press, rows, shoulder press, and arm work are all safe",
      shoulder: "lower body and core — squats, leg press, lunges, planks",
      back: "upper body machines seated — chest press, lat pulldown, cable rows with a straight back",
      ankle: "seated upper body — anything you can do sitting down",
      wrist: "legs and core — squats, leg press, lunges, walking",
      hip: "upper body — everything from the waist up",
      neck: "lower body and light machines — avoid anything overhead",
      elbow: "lower body and shoulder press — avoid any pulling or curling movements",
    };
    const safe = safeAlternative[injuredArea] || "anything that does not load that area";
    // REMEMBER the injury — the programme and swap logic read user.injuries, so from
    // now every workout trains around it instead of re-prescribing the painful move.
    if (injuredArea !== "the affected area") {
      // ONE OWNER for the append (Cut 7) — this block was duplicated verbatim in
      // pain-triage.ts and misc-commands.ts, and recordClientFacts needed a third copy.
      const updatedInj = addFact(user.injuries, injuredArea);
      if (updatedInj !== user.injuries) {
        await db.update(users).set({ injuries: updatedInj }).where(eq(users.id, user.id)).catch(() => {});
      }
    }
    const injuryReply = `Stop loading ${injuredArea} immediately. Rest it today. Ice for 15 minutes if swollen.\n\nIf the pain is severe, sharp, or does not settle within 48 hours — see a doctor or physio. Do not train through sharp pain.\n\nYou CAN still train ${safe}. One body part stops, the rest keeps going — I've noted it, so your sessions train *around* it from now on.\n\nRest ${injuredArea} for 72 hours minimum then reassess. Update me when you are back.\n\n[BUTTONS:Today's workout|Log food]`;
    await logChat(user.id, message, injuryReply, "INJURY");
    return injuryReply;
  }

  // ---- Period / cycle awareness ----
  if (
    /\b(my period|on my period|period started|period week|period cramps?|period pains?|menstrual|menstruation|time of (the )?month|that time of month|pms|pmdd|luteal phase|follicular phase|ovulation|ovulating|my cycle|my hormones|hormones (are|going|messing)|cycle week|cycle day)\b/i.test(m)
    || /\b(bloating|cramps?|spotting)\b/i.test(m) && /\b(period|cycle|hormones?|monthly)\b/i.test(m)
    || m === "my period" || m === "period" || m === "pms"
  ) {
    const cycleContext = `Client mentioned their menstrual cycle or period. Ask which phase they are in using EXACTLY these options: "Just started (Day 1–5)", "Middle of cycle (Day 6–14)", "PMS week (Day 15–21)", or "Period week (Day 22–28)". Then based on their reply: Phase 1 (period) — lighter training is fine, walking counts, iron-rich foods essential (red meat, spinach, pilchards), no guilt for lower energy. Phase 2 (follicular) — best training week, peak strength, push harder, carbs support performance. Phase 3 (PMS) — reduce intensity slightly, higher protein reduces cravings, magnesium from dark leafy greens helps mood. Phase 4 (period) — same as Phase 1. Normalise all of it. Weight fluctuates 1–3kg from water retention before period — not fat. Do not panic. Coach the next meal or session, not the feelings. SA voice. Max 3 sentences unless giving phase-specific advice.`;
    const cycleReply = await withTimeout("gpt_cycle", 20000, () => askCoachK(message, user, cycleContext));
    await logChat(user.id, message, cycleReply, "CYCLE");
    return cycleReply;
  }

  // ---- SMART NEXT MEAL — "what should I eat next?" based on daily gap ----
  // A PERSON CAN ASK BY INSTRUCTING (2026-08-26, live phone trace). This accepted "suggest a meal"
  // but not "give me a meal", so the imperative form reached no owner at all once the totals
  // branch correctly stopped claiming it. Stopping the wrong claimant is only half the fix — the
  // right one has to take the turn. Same request verbs as the guard in early-commands, so the two
  // doors agree on what a meal request looks like.
  // `what should i eat` (not `...next`): the bare form is the SAME plate-ask as "what can I eat",
  // which this door already owns. Requiring the suffix is what sent it to the meal-plan door
  // instead (2026-08-27). Dropping one word covers both, and adds no new vocabulary.
  if (/\b(what should i eat|next meal|(?:suggest|give|send|show|recommend)(?:\s+me)?\s*a?n?\s*meal|what.?s? next|what to eat now|what can i eat|what must i eat|hungry|starving|i.?m hungry|what now)\b/i.test(m) && !/\b(breakfast|lunch|dinner|supper|braai|social)\b/i.test(m)) {
    const ledger = await getDayLedger(user.id, { user });
    const todayCals = ledger.kcal;
    const todayProt = ledger.protein;
    const calTarget = user.calorieTarget || 1800;
    const protTarget = user.proteinTarget || 120;
    const calLeftRaw = calTarget - todayCals;
    const calLeft = Math.max(0, calLeftRaw);
    const protLeft = Math.max(0, protTarget - todayProt);
    const budget = user.weeklyFoodBudget || "100_300";
    const name = user.name?.split(" ")[0] || "";
    const goal = user.goalType || "fat_loss";
    // WHAT THIS PERSON EATS (#128). This is the door for "what should I eat?", and it was the one
    // food surface with ZERO calls to the constraint owner: the grocery list, the meal plan and
    // the permission-ask all consult foodConstraints, and this menu was hand-written animal
    // protein from top to bottom. A client whose column says "vegan" was handed five plates of
    // chicken, beef, pilchards and eggs — with "Does not eat: vegan" sitting in the same profile.
    //
    // No new recommender. The option sets stay hand-authored in exactly the style they were, with
    // the alternatives a constrained client can actually eat added beside them; `allows` — the
    // same predicate the shopping list and the swap engine use — decides which survive.
    const constraints = foodConstraints(user);
    const firstAllowed = (options: string[]): string | undefined => options.find(o => constraints.allows(o));

    // Determine what's needed
    const needsProtein = protLeft > 20;
    const lowCalBudget = calLeft < 400;
    const highCalBudget = calLeft > 800;

    let suggestion = `*🍽️ Next Meal Suggestion${name ? ` — ${name}` : ""}*\n\n`;

    // THE CLIENT ALREADY CLOSED THE DAY (2026-09-03, #125 sweep).
    //
    // "I'm done eating for the day" is a decision, and this door was the one place that did not
    // hear it. The fact was already known and already owned: foodDayIsClosed reads it,
    // readHeldConstraints holds it for the turn, and chooseAction guards its eat_more and protein
    // rungs on it. This branch simply never asked, so a client who had stopped eating on 188 of
    // 189g protein was handed two meals to close a 1g gap.
    //
    // THE OUTBOUND FLOOR CANNOT COVER FOR IT, which is why the fix belongs here rather than one
    // layer out. enforceOutboundTruth refuses a reply that asksForFoodToday, and that recogniser
    // returns FALSE on this one — it is a menu with bolded option labels, not an imperative to
    // eat. Widening the recogniser to catch menus would make it fire on every food surface we
    // have; the door that knows the constraint is the door that should obey it.
    //
    // This is the same shape as the calorie branch immediately below, which already stands down
    // because "suggesting more food contradicts the day's assessment". The difference is only
    // whose assessment it is: there the ledger's, here the client's own — and theirs outranks it.
    const held = await readHeldConstraints(phone, user);
    // ...AND THIS TURN'S OWN WORDS (#152). readHeldConstraints reads history, and the message being
    // answered is not in it yet, so "I'm eating now, what should I eat?" carried its own reversal
    // and was still refused. Same owner as the Meaning Engine uses, so both doors read one sentence
    // the same way; a closure inside the utterance still wins.
    if (foodDayClosedWith(held.foodDayClosed, message)) {
      const landed = `You finished on *${todayCals} kcal* and *${todayProt}g protein*.`;
      // needsProtein is this branch's existing bar for "a gap worth acting on". A 1g shortfall is
      // not a reason to reopen a decision they made; a real one is worth naming for TOMORROW,
      // which is a next move that does not ask them to eat now.
      const tomorrow = needsProtein
        ? `\n\nYou came up ${protLeft}g short on protein — start tomorrow with it at breakfast rather than chasing it tonight.`
        : "";
      suggestion += `You said you are done eating today, so I am leaving it there.\n\n${landed}${tomorrow}`;
      await logChat(user.id, message, suggestion, "MEAL_SUGGESTION_DAY_CLOSED");
      return suggestion;
    }

    // Calorie target already hit — suggesting more food contradicts the day's assessment
    if (todayCals > 0 && calLeftRaw <= 0) {
      const snacks = allowedAlternatives("eggs, yoghurt, biltong, hummus, roasted chickpeas", constraints);
      const protNote = protLeft > 20
        ? `You're about ${protLeft}g short on protein — a small protein snack${snacks ? ` (${snacks})` : ""} is a good shout if you're hungry.`
        : "Protein's on track. ✅";
      suggestion += `You've hit your calories for today. ${protNote}\n\nIf you're genuinely hungry, keep it light and protein-first — no need to force more food.`;
      await logChat(user.id, message, suggestion, "MEAL_SUGGESTION");
      return suggestion;
    }

    if (todayCals === 0) {
      suggestion += `No food logged yet today.\n\n`;
      const starts = budget === "under_100"
        ? (goal === "muscle_gain"
            ? [`*3 eggs + pap + spinach* (~420 kcal, 24g protein)\nCheap, filling, high protein to start the day.`,
               `*Sugar beans + pap + spinach* (~450 kcal, 22g protein)\nCheap, filling, high protein to start the day.`]
            : [`*2 eggs + oats with water* (~350 kcal, 18g protein)\nLow calorie, high protein start.`,
               `*Oats with water + a handful of nuts* (~340 kcal, 12g protein)\nLow calorie, slow-release start.`])
        : (goal === "muscle_gain"
            ? [`*3 eggs + 2 toast + banana* (~550 kcal, 25g protein)\nCarbs + protein for energy and muscle.`,
               `*Soya mince on toast + banana* (~560 kcal, 28g protein)\nCarbs + protein for energy and muscle.`,
               `*Oats + soya milk + peanuts + banana* (~540 kcal, 22g protein)\nCarbs + protein for energy and muscle.`]
            : [`*2 eggs + oats + coffee* (~380 kcal, 20g protein)\nBalanced, keeps you full until lunch.`,
               `*Oats + soya milk + a handful of nuts* (~370 kcal, 14g protein)\nBalanced, keeps you full until lunch.`]);
      // A CONSTRAINED CLIENT IS NOT LEFT WITH NOTHING. If every plate here is off their list, the
      // honest answer is the principle rather than a plate we cannot name.
      suggestion += firstAllowed(starts)
        ? `Start with: ${firstAllowed(starts)}`
        : `Start with something you actually eat, protein first — a bean or lentil base with your starch and veg will do the job.`;
    } else if (lowCalBudget && needsProtein) {
      suggestion += `You have ${calLeft} kcal and ${protLeft}g protein left.\n\n`;
      // Pick a suggestion that actually fits within remaining calories
      if (calLeft < 150) {
        const tiny = firstAllowed([
          "2 boiled eggs (~140 kcal, 12g protein)",
          "50g biltong (~130 kcal, 20g protein)",
          "Small tub of plain yoghurt (~120 kcal, 12g protein)",
          "Half a cup of sugar beans (~120 kcal, 8g protein)",
        ]);
        suggestion += tiny
          ? `*High-protein, low-cal finish:* ${tiny} — fits your budget.`
          : `*High-protein, low-cal finish:* keep it to a small protein-first portion of something you eat — that is all the room you have left.`;
      } else if (calLeft < 220) {
        const fit = firstAllowed(budget === "under_100"
          ? ["2 eggs + spinach (~160 kcal, 14g protein)", "Sugar beans + spinach (~180 kcal, 11g protein)"]
          : ["Tuna salad, no dressing (~190 kcal, 25g protein)", "Chickpea salad, no dressing (~200 kcal, 11g protein)"]);
        suggestion += `*Best fit:* ${fit || "a small protein-first plate of something you eat"}\nProtein first — just fits your remaining calories.`;
      } else {
        const best = firstAllowed(budget === "under_100"
          ? ["Tin of tuna with lemon (~180 kcal, 22g protein)", "Sugar beans + tomato and onion (~230 kcal, 13g protein)"]
          : ["Grilled chicken breast + salad (~250 kcal, 30g protein)", "Tofu + salad (~250 kcal, 20g protein)", "Lentils + salad (~240 kcal, 14g protein)"]);
        suggestion += `*Best option:* ${best || "a protein-first plate of something you eat"}\nHigh protein, low calories — exactly what you need to finish the day.`;
      }
    } else if (lowCalBudget && !needsProtein) {
      suggestion += `You have ${calLeft} kcal left and protein is sorted.\n\n`;
      suggestion += `*Best option:* Vegetable stir-fry or salad (~150 kcal)\nOr just call it — you're close to target. ${goal === "fat_loss" ? "Slight deficit is fine for fat loss." : ""}`;
    } else if (needsProtein) {
      // THE RECOMMENDATION HAS TO ADDRESS THE NUMBER IT JUST QUOTED (2026-08-28, live trace).
      //
      // Observed: "You need 129g more protein today. That is the priority." followed by two eggs
      // and pap — 18g, with 2,146 kcal still to spend. The branch printed protLeft and then never
      // read it again, and never read calLeft at all, so a 21g gap and a 129g gap got the same
      // two lines. A coach that states a deficit and then ignores it is not giving advice, it is
      // reciting a menu.
      //
      // No new nutrition engine and no threshold. The existing per-meal options already carry
      // their own protein and calorie figures, so the fix is to lead with the strongest option the
      // remaining calories can actually pay for, and — when that option still does not reach the
      // stated gap — to say so and hand the client the priority, not a prescribed meal count.
      suggestion += `You need *${protLeft}g more protein* today. That is the priority.\n\n`;
      // THE MENU HAD NO FULL PLATE IN IT (2026-09-01, Defect 2).
      //
      // Traced before changing anything: protLeft and calLeft are both read and both printed, so
      // this is not missing evidence and not the wrong claimant. What the owner could not do was
      // answer in proportion to the evidence it held. Driving the real path on main, a client with
      // 2 146 kcal of headroom and one with 420 kcal were offered plates from the same 380–450
      // kcal band, because that band was the entire menu. Headroom could only ever REMOVE an
      // option; nothing in the list could express "you have most of a day left, eat properly".
      //
      // So the correction is to the option set and the ordering, not to the architecture: fuller
      // plates in the same hand-authored style as the entries already here, and a choice rule that
      // fits the plate to the need.
      //
      // EVERY ENTRY BELOW WAS ANIMAL PROTEIN (#128). The plates a constrained client can eat are
      // added here in the same style and at the same price point, and `allows` — not a second menu
      // and not a different door — decides which of them this person is shown.
      const allMeals: Array<{ text: string; protein: number; kcal: number }> = budget === "under_100"
        ? [
            { text: "Tin of pilchards + 2 eggs + pap (~600 kcal, 42g protein)", protein: 42, kcal: 600 },
            { text: "Sugar beans + 2 eggs + pap + spinach (~620 kcal, 30g protein)", protein: 30, kcal: 620 },
            { text: "Soya mince + pap + spinach (~600 kcal, 40g protein)", protein: 40, kcal: 600 },
            { text: "Sugar beans + lentils + pap + spinach (~610 kcal, 26g protein)", protein: 26, kcal: 610 },
            { text: "Tin of pilchards + pap (~350 kcal, 24g protein)", protein: 24, kcal: 350 },
            { text: "2 eggs + pap (~300 kcal, 18g protein)", protein: 18, kcal: 300 },
            { text: "Sugar beans + pap (~340 kcal, 14g protein)", protein: 14, kcal: 340 },
          ]
        : [
            { text: "2 chicken thighs + rice + mixed veg (~680 kcal, 55g protein)", protein: 55, kcal: 680 },
            { text: "Soya mince + rice + mixed veg (~620 kcal, 45g protein)", protein: 45, kcal: 620 },
            { text: "Beef mince + pap + spinach (~640 kcal, 40g protein)", protein: 40, kcal: 640 },
            { text: "Chicken breast + rice + spinach (~450 kcal, 35g protein)", protein: 35, kcal: 450 },
            { text: "Tofu stir-fry + rice (~550 kcal, 30g protein)", protein: 30, kcal: 550 },
            { text: "Lentil and chickpea curry + rice (~600 kcal, 26g protein)", protein: 26, kcal: 600 },
            { text: "Tin of pilchards + sweet potato (~380 kcal, 24g protein)", protein: 24, kcal: 380 },
            { text: "3 eggs + brown bread + tomato (~400 kcal, 24g protein)", protein: 24, kcal: 400 },
            { text: "Sugar beans + sweet potato + spinach (~420 kcal, 16g protein)", protein: 16, kcal: 420 },
          ];
      const meals = allMeals.filter(mm => constraints.allows(mm.text));
      // FIT THE PLATE TO THE NEED, and it takes no arithmetic beyond a comparison.
      //
      // "Biggest protein first" was right while every option was small and becomes wrong the
      // moment a 680 kcal plate exists: a client 22g short would be led to it. Ranking rule:
      //   - the SMALLEST plate that actually covers the gap, if one does — enough is enough;
      //   - otherwise the BIGGEST the day's calories can pay for, because nothing will finish it
      //     and the largest dent is the most useful answer.
      // No threshold, no percentage, no division, no meal count. The calorie filter is what stops
      // the fuller plates being offered to somebody who has no room for them.
      const affordable = meals.filter(mm => mm.kcal <= calLeft);
      const covers = affordable.filter(mm => mm.protein >= protLeft).sort((a, b) => a.kcal - b.kcal);
      const dents = affordable.filter(mm => mm.protein < protLeft).sort((a, b) => b.protein - a.protein);
      // FIVE, AS BEFORE. Widening the option set so a constrained client has a real menu must not
      // hand an unconstrained one a wall of nine plates to choose between; the ranking above
      // already puts the right ones at the top, so the tail is what gets dropped.
      const ordered = [...covers, ...dents].slice(0, 5);
      if (ordered.length === 0) {
        const only = allowedAlternatives("eggs, biltong, tuna, plain yoghurt, sugar beans, lentils", constraints);
        suggestion += only
          ? `You do not have the calories left for a full meal — go protein-only: ${only}, and leave the starch off the plate.`
          : `You do not have the calories left for a full meal — go protein-only from what you do eat, and leave the starch off the plate.`;
      } else {
        suggestion += `Pick one:\n${ordered.map((mm, i) => `${i + 1}. ${mm.text}`).join("\n")}`;
        if (ordered[0].protein < protLeft) {
          // SAY IT PLAINLY RATHER THAN PRESCRIBE A NUMBER. How the client spreads the rest across
          // the eating opportunities they have left is theirs to decide; counting meals for them
          // would be inventing a plan out of two figures.
          suggestion += `\n\nNone of those closes ${protLeft}g on its own, so make protein the first thing on the plate for every meal you have left today. You have *${calLeft} kcal* to work with.`;
        }
      }
    } else {
      suggestion += `${calLeft} kcal and ${protLeft}g protein to go.\n\n`;
      const balanced = firstAllowed(budget === "under_100"
        ? ["Pap + beans + cabbage (~400 kcal, 14g protein)"]
        : ["Chicken + sweet potato + vegetables (~500 kcal, 30g protein)",
           "Tofu + sweet potato + vegetables (~480 kcal, 22g protein)",
           "Lentils + sweet potato + vegetables (~470 kcal, 18g protein)"]);
      const second = firstAllowed(budget === "under_100"
        ? ["2 eggs + pilchards + pap (~500 kcal, 28g protein)",
           "Soya mince + pap + cabbage (~480 kcal, 32g protein)"]
        : ["Greek yoghurt + banana + oats (~350 kcal, 18g protein)",
           "Oats + soya milk + peanuts + banana (~360 kcal, 14g protein)"]);
      const secondLabel = budget === "under_100" ? "Protein push" : "Light option";
      const twoOptions = [
        balanced ? `*Balanced option:* ${balanced}` : "",
        second ? `*${secondLabel}:* ${second}` : "",
      ].filter(Boolean).join("\n");
      suggestion += twoOptions
        || `Build it from what you actually eat: protein first, then your starch, then something green. That is the whole rule with this much room left.`;
    }

    await logChat(user.id, message, suggestion, "MEAL_SUGGESTION");
    return suggestion;
  }

  // ---- HABIT CALENDAR — visual 4-week consistency grid ----
  if (m === "calendar" || m === "habit calendar" || m === "my calendar" || m === "consistency" || m === "habit tracker" || /\b(habit\s*calendar|consistency\s*check|my\s*consistency)\b/i.test(m)) {
    try {
      const twentyEightDaysAgo = new Date(Date.now() - 28 * 86_400_000);
      const [workoutDates, stepDates, foodDates] = await Promise.all([
        db.select({ date: workoutLogs.loggedAt }).from(workoutLogs)
          .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, twentyEightDaysAgo))),
        db.select({ date: stepLogs.loggedAt, steps: stepLogs.steps }).from(stepLogs)
          .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, twentyEightDaysAgo))),
        db.select({ date: chatHistory.createdAt }).from(chatHistory)
          .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, twentyEightDaysAgo))),
      ]);

      const stepsTarget = user.stepsTarget || 8500;

      // Build day-by-day map for last 28 days
      const workoutSet = new Set(workoutDates.map(w => new Date(w.date!).toISOString().slice(0, 10)));
      const stepMap: Record<string, number> = {};
      for (const s of stepDates) { const d = new Date(s.date!).toISOString().slice(0, 10); stepMap[d] = Math.max(stepMap[d] || 0, s.steps); }
      const foodSet = new Set(foodDates.map(f => new Date(f.date!).toISOString().slice(0, 10)));

      const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      let cal = `*📅 4-Week Habit Calendar*\n\n`;
      cal += `Legend: 💪=workout ✅=steps hit 🍽️=food logged ·=nothing\n\n`;

      let perfectDays = 0;
      let activeDays = 0;

      for (let week = 3; week >= 0; week--) {
        const weekStart = new Date(Date.now() - (week * 7 + 6) * 86_400_000);
        let weekLine = `*W${4 - week}:* `;
        for (let d = 0; d < 7; d++) {
          const day = new Date(weekStart.getTime() + d * 86_400_000);
          const dateStr = day.toISOString().slice(0, 10);
          const hasWorkout = workoutSet.has(dateStr);
          const stepsHit = (stepMap[dateStr] || 0) >= stepsTarget;
          const hasFood = foodSet.has(dateStr);

          if (hasWorkout && stepsHit && hasFood) { weekLine += "⭐"; perfectDays++; activeDays++; }
          else if (hasWorkout && stepsHit) { weekLine += "💪"; activeDays++; }
          else if (hasWorkout) { weekLine += "💪"; activeDays++; }
          else if (stepsHit) { weekLine += "✅"; activeDays++; }
          else if (hasFood) { weekLine += "🍽️"; activeDays++; }
          else weekLine += "·";
        }
        cal += weekLine + "\n";
      }
      cal += `     ${dayNames.join("")}\n\n`;
      cal += `⭐ Perfect days: ${perfectDays}/28\n`;
      cal += `Active days: ${activeDays}/28 (${Math.round(activeDays / 28 * 100)}%)\n\n`;
      cal += activeDays >= 24 ? `Elite consistency. This is how results happen.` :
             activeDays >= 18 ? `Good consistency. Fill the gaps and watch what happens.` :
             activeDays >= 10 ? `Building the habit. More dots = more results.` :
             `Plenty of room to fill in — and that's the opportunity. One workout and one step log today starts the next streak.`;

      await logChat(user.id, message, cal, "HABIT_CALENDAR");
      return cal;
    } catch (err) {
      console.error("[HABIT CALENDAR]", err);
      return `Calendar not available right now. Try again.`;
    }
  }

  // ---- MONTHLY TRANSFORMATION REPORT — converged 2026-08-21 ----
  //
  // A FIFTH progress calculator: five of its own queries, its own 30-day weight window, its own
  // `daysOn` off programmeStartDate, and a step average computed per LOG ROW rather than per day
  // — so two step logs on one day halved it against every other surface.
  //
  // It also claimed "monthly report", "my month", "month report" and "month's summary", all of
  // which the shareable report card in early-commands.ts:135 matches and answers first. Four dead
  // phrases in a block that looked like an owner. The words it can actually win are left here;
  // the numbers now come from the one source.
  if (m === "transformation" || m === "monthly" || /\b(this month|my transformation|30.?day\s*report)\b/i.test(m)) {
    try {
      const { getProgressTruth } = await import("../day-ledger");
      const truth = await getProgressTruth(user, { days: 30, weightWindowDays: 30, clientMessage: message });
      const sleepLogs = await db.select({ id: chatHistory.id }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "SLEEP_LOG"),
          gte(chatHistory.createdAt, new Date(Date.now() - 30 * 86_400_000))));

      const name = getDisplayName(user) || "you";
      const stepsTarget = user.stepsTarget || 8500;

      let weightLine = "No weight logs this month — step on the scale.";
      if (truth.weight.known && truth.weight.changeKg !== null) {
        const diff = truth.weight.changeKg;
        weightLine = diff < -0.5 ? `⚖️ Weight: *${Math.abs(diff).toFixed(1)}kg DOWN* this month (now ${truth.weight.currentKg}kg)`
          : diff > 0.5 ? `⚖️ Weight: ${diff.toFixed(1)}kg up this month (now ${truth.weight.currentKg}kg)`
          : `⚖️ Weight: Holding steady at ${truth.weight.currentKg}kg`;
      } else if (truth.weight.currentKg) {
        weightLine = `⚖️ Weight: ${truth.weight.currentKg}kg — log more to track trend`;
      }

      const workoutCount = truth.sessions;
      const planned = (user.trainingDaysPerWeek || 3) * 4; // 4 weeks
      const workoutRate = planned > 0 ? Math.round(workoutCount / planned * 100) : 0;
      const avgSteps = truth.avgSteps;
      const foodDays = truth.window.daysLogged;

      // Grade — unchanged thresholds, canonical inputs. "weights.length >= 3" became
      // "the weight is known", which is the same evidence question the truth object already answers.
      let grade = "D";
      const score = (workoutRate >= 75 ? 2 : workoutRate >= 50 ? 1 : 0) +
        (avgSteps >= stepsTarget ? 2 : avgSteps >= stepsTarget * 0.7 ? 1 : 0) +
        (foodDays >= 20 ? 1 : 0) +
        (truth.weight.known ? 1 : 0);
      if (score >= 5) grade = "A";
      else if (score >= 4) grade = "B";
      else if (score >= 3) grade = "C";

      const report = `*📊 Monthly Transformation Report — ${name}*\n` +
        `_${truth.daysOnProgramme} days on programme_\n\n` +
        `${weightLine}\n` +
        `💪 Workouts: *${workoutCount}/${planned}* planned (${workoutRate}%)\n` +
        `👟 Steps: ${avgSteps.toLocaleString()} avg/day\n` +
        `🍽️ Days food logged: ${foodDays}/30\n` +
        `😴 Sleep logged: ${sleepLogs.length} times\n` +
        `🔥 Current streak: ${user.workoutStreak || 0} sessions\n\n` +
        `*Month Grade: ${grade}*\n\n` +
        (grade === "A" ? `Elite consistency${name ? `, ${name}` : ""}. This is how bodies change. Keep it going.` :
         grade === "B" ? `Strong month. Tighten up the gaps and A is yours next month.` :
         grade === "C" ? `Room to improve. Focus on showing up — 3 workouts and 8,500 steps every single day.` :
         `Tough month — but you're still here, and that counts for a lot. Fresh month ahead: one workout today is all it takes to start again. I've got you.`);

      await logChat(user.id, message, report, "MONTHLY_REPORT");
      return report;
    } catch (err) {
      console.error("[MONTHLY REPORT]", err);
      return `Could not generate report right now. Try again later.`;
    }
  }

  // ---- STEPS QUERY (bare "steps", "my steps", or explicit today query) ----
  const isStepWeekQuery = /\b(steps?\s*(?:this\s+)?week|my\s+step\s*(?:history|stats?|average|trend)|step\s*(?:history|stats?|average|trend|report)|weekly\s*steps?|7[\s-]day\s*steps?)\b/i.test(m);
  const isNaturalStepFollowUp = /^(?:and|what about|how about)\s+(?:the\s+)?steps?\s*\?$/i.test(m.trim());
  // "what are my steps" reached NONE of these and fell through to the model, which has no step
  // ledger and answered with the offline-agent apology (2026-08-21, found by the factual-question
  // check once production-parity started awaiting its async cases). A held number must never be
  // reconstructed by the model. This last alternative is a SHAPE — an interrogative in front of
  // "my steps" — rather than another phrasing added to the list, because the list is what missed.
  if (["steps", "my steps", "step target", "steps target", "daily steps"].includes(m) ||
      /\b(steps?\s*today|how many steps|steps?\s*logged|did i hit my steps?|steps?\s*(count|so far|this morning|tonight)|today.?s steps?)\b/i.test(m) ||
      /\b(?:what(?:'|’)?s|what is|what are|show me|tell me)\b[^?]{0,24}\bmy\s+steps?\b/i.test(m) ||
      isStepWeekQuery || isNaturalStepFollowUp) {
    try {
      const target = user.stepsTarget || 8500;
      const name2 = user.name?.split(" ")[0] || "";

      if (isStepWeekQuery) {
        // 7-day step history
        const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
        const weekSteps = await db.select({ steps: stepLogs.steps, loggedAt: stepLogs.loggedAt })
          .from(stepLogs)
          .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo)))
          .orderBy(desc(stepLogs.loggedAt))
          .limit(14); // up to 2 per day (update + insert edge case)
        // Deduplicate to most recent per day (SAST)
        const byDay = new Map<string, number>();
        for (const row of weekSteps) {
          const sast = new Date(new Date(row.loggedAt!).getTime() + 2 * 3_600_000);
          const day = sast.toISOString().slice(0, 10);
          if (!byDay.has(day)) byDay.set(day, row.steps);
        }
        if (byDay.size === 0) return `${name2 ? name2 + " — " : ""}No steps logged this week. Send your count daily: "8,500 steps" or "walked 5km".`;
        const days = [...byDay.entries()].sort(([a], [b]) => b.localeCompare(a));
        const avg = Math.round(days.reduce((s, [, v]) => s + v, 0) / days.length);
        const hitDays = days.filter(([, v]) => v >= target).length;
        const lines = days.slice(0, 7).map(([day, steps]) => {
          const d = new Date(day + "T00:00:00Z");
          const label = d.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" });
          const status = steps >= target ? "✅" : steps >= target * 0.75 ? "⚠️" : "🔴";
          return `${label}: ${steps.toLocaleString()} ${status}`;
        }).join("\n");
        const verdict = avg >= target ? "Above target — keep it up." : avg >= target * 0.75 ? "Close to target. Push a bit more daily." : "Below target — add a 20-min walk each day.";
        return `*Steps — Last 7 Days*\n\n${lines}\n\nAvg: *${avg.toLocaleString()} steps/day* | Target: ${target.toLocaleString()}\n${hitDays}/${days.length} days hit target. ${verdict}`;
      }

      // Today only
      const [todayStep] = await db.select({ steps: stepLogs.steps })
        .from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sastDayStart())))
        .orderBy(desc(stepLogs.loggedAt))
        .limit(1);
      const logged = todayStep?.steps || 0;
      // RECORD WHAT WE HOLD (2026-08-21). The verifier judges a step number in the reply against
      // the turn's evidence; without this line the deterministic answer had no provenance and was
      // allowed through only because the client's wording looked like a step question. Provenance
      // is the thing that should decide, so the door states it.
      turnEvidence({ stepsToday: logged });
      const remaining = Math.max(0, target - logged);
      if (!logged) return `${name2 ? name2 + " — " : ""}${target.toLocaleString()} steps is your target. No steps logged yet today — send your count: "8,500 steps" or "walked 5km".`;
      if (remaining === 0) return `${name2 ? name2 + " — " : ""}${logged.toLocaleString()} steps today. Target hit ✅`;
      return `${name2 ? name2 + " — " : ""}${logged.toLocaleString()} steps logged today. ${remaining.toLocaleString()} to go to hit your ${target.toLocaleString()} target.`;
    } catch {
      const stepsT = user.stepsTarget || 8500;
      const name2 = user.name ? `${user.name} — ` : "";
      return `${name2}${stepsT.toLocaleString()} steps is your target. Log your steps — "8500 steps" or "I walked 6km".`;
    }
  }

  // ---- WEIGHT HISTORY — "weight history", "weight trend", "how much have I lost" ----
  if (/\b(weight history|weight trend|my weights|all my weights|weight progress|how much (weight )?(have i|did i) (lost?|gained?)|total (weight )?(lost?|gained?)|weight (since|over time))\b/i.test(m)) {
    try {
      // THEY ASKED, SO THEY GET AN ANSWER (2026-08-25, P0-5 · weight). The owner applies the
      // do-not-mention rule, and `clientMessage` is what tells it this client raised the scale
      // themselves — "don't mention my weight" is not "refuse to tell me my weight when I ask".
      // That exemption used to be accidental: this command simply never checked. Now it is stated.
      const wt = await getWeightTruth(user, { clientMessage: m });
      const logs = wt.points;
      if (logs.length === 0) return `No weight history yet. Log your first weight — just send "84kg".`;
      const first = logs[0].kg;
      const latest = logs[logs.length - 1].kg;
      const totalChange = latest - first;
      const goal = user.goalType || "fat_loss";
      // Computed below once the owner has answered — see the note at the return.
      let changeDir = "";
      // A DIRECTION IS A TREND CLAIM, AND IT HAS AN OWNER (2026-08-28, live trace).
      //
      // Observed, in one message: the response gate refused — "I'm not going to call a trend off
      // those weigh-ins — they sit around the time you were ill" — and this line then said "Scale
      // is going up — keep fuelling." Both were true to their own reasoning, because this verdict
      // was computed from `latest - first` alone and never asked whether those two points can
      // carry a trend at all. Two owners of "which way is the scale going", one refusing and one
      // answering, in consecutive paragraphs.
      //
      // weightTrendUsable is the owner the gate consults. This asks it too, so the refusal and
      // the verdict cannot disagree. When the trend is unusable the numbers still ship — the
      // client asked for their history and gets it — but no direction is asserted over them.
      // ONE OWNER, ONE CALLER-FACING SHAPE (#126). This assembled the window inline — count,
      // oldest, newest, the two illness edges — and the chart below did not assemble it at all.
      // Same owner, same answer, plumbing written once so a second surface cannot forget it.
      const { weightDirectionSpeakable } = await import("../adaptive-targets");
      const trend = await weightDirectionSpeakable(logs, user);
      const verdict = !trend.speakable ? ""
        : goal === "fat_loss" && totalChange < -1 ? "Moving in the right direction."
        : goal === "muscle_gain" && totalChange > 0.5 ? "Scale is going up — keep fuelling."
        : goal === "fat_loss" && totalChange >= 0 ? "Scale hasn't moved yet — check food logging consistency."
        : "";
      const recent = logs.slice(-5).map(l =>
        `• ${l.kg.toFixed(1)}kg — ${l.at.toLocaleDateString("en-ZA", { day: "numeric", month: "short" })}`,
      ).join("\n");
      // "Up 2.4kg since you started" IS A DIRECTION CLAIM, and the outbound gate reads it as one.
      // Traced on current main against an illness-spanning window: the gate correctly refused it
      // and rewrote the WHOLE reply, so the three weigh-ins the client had just asked for were
      // deleted along with it. Refusing to call a trend must not cost them their own history.
      //
      // So when the direction cannot be spoken the same numbers ship as data — start and now,
      // no up/down word — which is honest and is also what the gate leaves intact.
      changeDir = trend.speakable
        ? (totalChange < 0 ? `Down ${Math.abs(totalChange).toFixed(1)}kg` : totalChange > 0 ? `Up ${totalChange.toFixed(1)}kg` : "No change")
        : `Started ${first.toFixed(1)}kg · now ${latest.toFixed(1)}kg`;
      const name2 = user.name?.split(" ")[0] || "";
      const tail = trend.speakable ? `${changeDir} since you started. ${verdict}` : changeDir;
      return `*${name2 ? name2 + "'s " : ""}Weight History*\n\n${recent}\n\n${tail}`.trim();
    } catch { /* fall through */ }
  }
  if (["protein", "my protein", "protein target", "daily protein", "protein daily", "how much protein", "my protein target"].includes(m)) {
    const p = user.proteinTarget || 140;
    const perMeal = Math.round(p / 4);
    return `*Your Daily Protein Target*\n\n💪 ${p}g protein per day.\n\nSpread across 4 meals — roughly ${perMeal}g each. Best SA sources: eggs (6g each), pilchards (20g per tin), chicken breast (30g per 100g), tinned tuna (25g per tin). This drives everything — muscle, fat loss, fullness.`;
  }
  if (["weight", "my weight", "current weight"].includes(m)) {
    const w = user.currentWeight ? `${user.currentWeight}kg` : "not logged yet";
    // FROM THE WEIGHT THEY ARE (#128) — users.bmi is the onboarding snapshot and never moves.
    const bmiLive = bmiOf(user);
    const bmiText = bmiLive ? ` BMI: ${bmiLive.toFixed(1)}.` : "";
    return `*Your Weight*\n\n⚖️ Last logged: *${w}*${bmiText}\n\nWeigh yourself every morning — same time, same conditions, after bathroom, before food. Send me the number like this: *84kg*. Weekly trends matter more than daily changes.`;
  }
  if (["programme", "program", "my programme", "my program"].includes(m)) {
    return getKamlifeProgramme(user);
  }
  if (["7 day meals", "7day meals", "full meal plan", "day by day meals"].includes(m)) {
    return getOnboardingMealPlan(user);
  }
  // A BUTTON WE OFFER MUST HAVE AN OWNER (2026-08-06). "My progress" is one of the three menu
  // quick-replies, so tapping it sends this exact text — and this branch used to stand down
  // whenever the engine was live, which it has been for every client for weeks. The button has
  // therefore been reaching the model, and the model then writes its own numbers about the
  // client's body: the one thing the 2026-07-28 note two hundred lines up says must never
  // happen. Ungated now. Anything carrying "today" still means today and gets the card
  // (early-commands owns that); bare "progress" means the journey so far.
  // ── PROGRESS HAS ONE OWNER (2026-08-20, response-graph audit) ────────────────────────────
  //
  // This branch built its own scoreboard from four `users` columns — totalWorkoutsCompleted,
  // programmeStartDate, programmeWeek, currentWeight — and never touched the ledger. So the
  // client had THREE progress authorities: this one, the day ledger behind "today's progress",
  // and getProgressTruth behind the cards. Cut 11 consolidated the cards and left the two doors
  // a person actually types.
  //
  // It also printed "Day 35, week 1" — daysOn derived from programmeStartDate against a stored
  // programmeWeek column, two parallel scoreboards contradicting each other inside one sentence.
  // Reading one source removes the contradiction rather than patching the arithmetic.
  //
  // And it advertised "Send *this week*" — a command NO handler owned, so it fell to the model,
  // which improvised averages and handed the next move back to the client. Both doors are owned
  // here now, from the same truth.
  const wantsToday = ["progress", "my progress", "how am i doing"].includes(m);
  // The weekly doors this handler can actually WIN, and no others. The deleted WEEKLY PROGRESS
  // CARD block also listed "my week", "week report", "week card" and "weekly card" — but the
  // shareable report card in early-commands.ts:135 matches those and runs earlier, so that block
  // could never answer them. Folding them in here would have rebuilt the same dead claimant one
  // file to the left: code that looks like it owns a question and only loses on chain order.
  // Those four belong to the report card; production-parity asserts they still reach it.
  const wantsWeek = ["this week", "week", "weekly", "this weeks progress", "this week's progress"].includes(m)
    || /\b(?:weekly stats|progress card|how.*i doing this week|weekly progress|my weekly|my stats this week|progress this week)\b/i.test(m);
  if (wantsToday || wantsWeek) {
    const name = getDisplayName(user) || "there";
    try {
      const { getProgressTruth } = await import("../day-ledger");
      const truth = await getProgressTruth(user, { days: 7, clientMessage: message });
      const calTarget = Number(user.calorieTarget) || 0;
      const protTarget = Number(user.proteinTarget) || 0;
      const weightLine = truth.weight.known && truth.weight.currentKg
        ? `\n⚖️ Weight: *${truth.weight.currentKg}kg*${truth.weight.changeKg !== null ? ` (${truth.weight.changeKg <= 0 ? "down" : "up"} ${Math.abs(truth.weight.changeKg)}kg)` : ""}`
        : "";
      if (wantsWeek) {
        // ONE NEXT MOVE, NEVER A QUESTION BACK. The model's version ended "What's one action you
        // can take this week?" — the coach asking the client to coach himself, which is the exact
        // inverse of the product contract.
        // THE SAME DECISION CONTRACT AS THE PROACTIVE PATH (2026-08-21). This called chooseAction
        // raw, so the weekly card could prescribe on a week the proactive gate would have refused
        // to prescribe on — one decision function fed two policies, chosen by caller. It cannot
        // run the full gate (that needs a ProactiveState), so it applies the contract directly.
        //
        // EVIDENCE, from the same truth object the card is built from: a week with fewer than
        // three logged days is the sparse-log case the gate exists for. Two days is not evidence,
        // and acting on it is how the product invented the over-target accusation.
        // ONE DECISION CONTEXT, NOT JUST ONE DECISION FUNCTION (2026-08-21).
        //
        // This fed WEEKLY AVERAGES into fields that mean TODAY — `proteinPct` from
        // window.avgProtein, `stepsToday` (the name says it) from avgSteps — and froze the clock
        // at `hour: 12`, so the evening rule could never fire here and the same client could get a
        // different "one thing" from the weekly card than from the coach five minutes earlier.
        // One constitution does not mean one decision if two callers hand it different worlds.
        //
        // The CARD is a weekly recap; the ACTION is what to do next, which is a daily question and
        // the only one chooseAction was built to answer. So the numbers stay weekly and the
        // decision context becomes today's — identical semantics to computeNextMove and morning.
        const { chooseAction, underPolicy, PROACTIVE_LOG_FLOOR } = await import("../one-action");
        const { sastHour } = await import("../sast");
        const act = underPolicy(chooseAction({
          goal: (user.goalType as any) || "general", weeksOnProgramme: Math.max(0, (user.programmeWeek || 1) - 1),
          dreamGoal: user.dreamGoal, biggestStruggle: user.biggestStruggle, lifeContext: user.lifeContext,
          doNotMention: user.doNotMention,
          daysSinceAnyLog: truth.today.kcal > 0 ? 0 : (truth.window.daysLogged > 0 ? 1 : 7),
          daysSinceWeighIn: truth.weight.known ? 0 : null, loggedToday: truth.today.kcal > 0,
          proteinPct: protTarget > 0 ? truth.today.protein / protTarget : 1,
          caloriePct: calTarget > 0 ? truth.today.kcal / calTarget : 1,
          sessionsThisWeek: truth.sessions, sessionsTarget: Number(user.trainingDaysPerWeek) || 3,
          stepsToday: truth.today.steps, stepsTarget: Number(user.stepsTarget) || 0,
          hour: sastHour(), atKeyboard: true,
        } as any), { foodSufficient: truth.window.daysLogged >= PROACTIVE_LOG_FLOOR,
         // WEIGHT EVIDENCE IS NOT COUNTED HERE, and that is a known gap rather than a
         // decision: the proactive side reads a stall verdict this path never computes, so
         // passing anything but false would be inventing evidence. It means a client with a
         // usable weight trend and a thin food log is still held on this path.
         weightSufficient: false, dreamGoal: user.dreamGoal });
        return `*${name} — last 7 days*\n\n💪 Sessions: *${truth.sessions}*\n📋 Days logged: *${truth.window.daysLogged}/7*\n🔥 Avg: *${truth.window.avgKcal} kcal* · *${truth.window.avgProtein}g* protein\n👟 Avg steps: *${truth.avgSteps.toLocaleString()}*${weightLine}\n\n*${act.todo}*`;
      }
      const todayLine = truth.today.kcal > 0
        ? `🔥 Today: *${truth.today.kcal}${calTarget ? `/${calTarget}` : ""} kcal* · *${truth.today.protein}${protTarget ? `/${protTarget}` : ""}g* protein`
        : `🔥 Today: *nothing logged yet*`;
      const stepsLine = truth.today.steps > 0 ? `\n👟 Steps today: *${truth.today.steps.toLocaleString()}*` : "";
      return `*${name}'s Progress*\n\n${todayLine}${stepsLine}\n💪 Sessions this week: *${truth.sessions}*\n📋 Days logged (7d): *${truth.window.daysLogged}/7*${weightLine}\n\nSend *this week* for the 7-day breakdown.`;
    } catch (e) {
      console.warn("[PROGRESS] truth unavailable:", (e as any)?.message || e);
      return `${name}, I can't read your numbers this second — give me a moment and ask again. I'd rather say that than guess.`;
    }
  }
  if (["targets", "my targets", "goals"].includes(m)) {
    const goalLabel: Record<string, string> = {
      fat_loss: "Fat loss", muscle_gain: "Muscle gain", recomposition: "Body recomposition",
      general: "General fitness", health_condition: "Health management",
    };
    return `*Your Daily Targets*\n\n🔥 Calories: *${user.calorieTarget || "not set"} kcal*\n💪 Protein: *${user.proteinTarget || "not set"}g*\n👟 Steps: *${(user.stepsTarget || 0).toLocaleString()}*\n🎯 Goal: *${goalLabel[user.goalType || ""] || user.goalType || "not set"}*\n\nHit all three every day. That is the whole programme.`;
  }

  // ---- ALL-TIME / JOURNEY — the LAST independent progress calculation, converged 2026-08-21 ----
  //
  // It ran its own SUM(steps), its own first/last weight queries and its own daysOn off
  // programmeStartDate, and read totalWorkoutsCompleted straight off the users row — a scoreboard
  // column that drifts from workoutLogs the moment one write fails. Four private facts, none of
  // them from the source every other progress surface uses.
  //
  // Same window, same numbers, one owner: getProgressTruth over the whole journey. The suspicious-
  // data warning survives because it is PRESENTATION over the canonical change, not a second
  // reading of the weight history.
  if (["all time", "my journey", "total", "overall", "my results", "how far"].includes(m)) { // "stats"/"my stats" owned by early-commands (Targets card)
    try {
      const { getProgressTruth } = await import("../day-ledger");
      const seed = user.programmeStartDate || user.createdAt;
      const daysOn = seed
        ? Math.max(1, Math.floor((Date.now() - new Date(seed).getTime()) / 86_400_000))
        : 1;
      const truth = await getProgressTruth(user, { days: daysOn + 1, clientMessage: message });
      const streak = await getStepStreak(user.id);
      let weightLine = "";
      const change = truth.weight.changeKg;
      if (truth.weight.known && change !== null) {
        // A 10kg swing, or 5kg inside a fortnight, is a data-entry problem rather than a result.
        const isSuspicious = Math.abs(change) > 10 || (Math.abs(change) > 5 && daysOn < 14);
        weightLine = isSuspicious
          ? `\n⚠️ Weight data: a ${Math.abs(change).toFixed(1)}kg swing since you started — looks like a data issue. Send "weight Xkg" with your real current weight to fix it.`
          : change < 0 ? `\n⬇️ Weight: down ${Math.abs(change).toFixed(1)}kg since you started`
          : change > 0 ? `\n⬆️ Weight: up ${change.toFixed(1)}kg since you started`
          : `\n⚖️ Weight: unchanged since you started`;
      } else if (truth.weight.currentKg) {
        weightLine = `\n⚖️ Current weight: ${truth.weight.currentKg}kg`;
      }
      const name = getDisplayName(user) || "there";
      const statsReply = `*${name}'s Journey with Coach K* 💪\n\n✅ Workouts completed: ${truth.sessions}\n👟 Total steps logged: ${truth.totalSteps.toLocaleString()}\n📅 Days on programme: ${truth.daysOnProgramme}\n🔥 Current streak: ${streak} day${streak !== 1 ? "s" : ""}${weightLine}\n\nThis is what you have built. Keep going.`;
      await logChat(user.id, message, statsReply, "STATS_LOOKUP");
      return statsReply;
    } catch (e) { console.error("[STATS]", e); }
  }

  // ---- TRAJECTORY: "on track?", "where am I going", "is this working" ----
  // A directional assessment, not a wall of numbers. Gated to the engine when live.

  /*
   * WEEKLY PROGRESS CARD — REMOVED (2026-08-20, progress convergence follow-up).
   *
   * A FOURTH progress calculator, and the last competing weekly authority. It ran its own four
   * queries (workouts, meals, steps, weights), bucketed days with a hand-rolled `+2h` SAST offset
   * rather than sastDayKey, measured weight over its own 14-day window, and derived `weekNum` from
   * programmeStartDate — so it disagreed with "this week" on the same seven days, and the answer a
   * client got depended only on which synonym they happened to type.
   *
   * `my week` was matched by BOTH this block and the owner above; the owner won on chain order,
   * which is a coincidence, not ownership. Its phrases now belong to that one owner, which reads
   * getProgressTruth. Nothing is lost: the same seven days, from the source every other progress
   * surface uses, ending in one instruction instead of "screenshot this".
   */



  // ---- JOIN CHALLENGE (friend accepting an invite) ----
  if (/^join\s+([A-Z]{3}\d{4})$/i.test(m.trim())) {
    const challengeCode = m.trim().split(/\s+/)[1].toUpperCase();
    const [inviter] = await db.select({ id: users.id, name: users.name, phoneNumber: users.phoneNumber })
      .from(users).where(eq(users.referralCode, challengeCode)).limit(1);
    if (inviter && inviter.id !== user.id) {
      await db.update(users).set({ referredBy: inviter.id }).where(eq(users.phoneNumber, phone));
      await logChat(user.id, message, `Challenge accepted`, "CHALLENGE_JOIN");
      return `Challenge accepted. You and ${inviter.name?.split(" ")[0] || "your friend"} are now in the same weekly challenge.\n\nYour target: ${user.trainingDaysPerWeek || 3} workouts + food logged 5 days this week.\n\nLet's go. Send me your first meal or reply *programme* to see your workout plan.`;
    }
    return `I could not find that challenge code. Double-check it and try again, or reply *challenge a friend* to create your own.`;
  }

  // ---- REFERRAL ----
  const isReferralRequest =
    ["refer", "referral", "my referral", "my code", "referral code", "refer a friend", "invite"].includes(m) ||
    /\b(my friend wants to (join|try|sign up|start)|how do i (refer|invite|get my friend|bring.*friend)|can i (refer|invite|get.*friend|bring.*friend)|referral (code|link)|share.*coach|get.*friend.*on (this|here|it)|want.*friend.*join|friend.*interested)\b/i.test(m);
  if (isReferralRequest) {
    let code = user.referralCode;
    if (!code) {
      const namePrefix = (user.name || "KAM").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "K");
      const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
      code = `${namePrefix}${randomSuffix}`;
      await db.update(users).set({ referralCode: code }).where(eq(users.phoneNumber, phone));
    }
    const waNum = (process.env.TWILIO_WHATSAPP_NUMBER || "").replace(/^whatsapp:/, "").replace(/\D/g, "");
    const waLink = waNum ? `https://wa.me/${waNum}?text=Hi%2C+I+was+referred+by+${code}` : null;
    const shareMsg = waLink
      ? `_"I've been using a WhatsApp fitness coach — real SA food, full workouts, daily check-ins. ${PRICING.monthlyDisplay}, no app, and a ${GUARANTEE_PHRASE} so there's no risk: ${waLink}"_`
      : `_"I've been using KamLife Coach — WhatsApp fitness coaching, real SA food, ${PRICING.monthlyDisplay}. Use my code ${code} when you join — there's a ${GUARANTEE_PHRASE}, so zero risk."_`;
    const referralReply = `*Your referral code: ${code}* 🎯\n\nSend your friend this:\n\n${shareMsg}\n\nWhen they subscribe, *you get a free month.* No cap — every friend who joins earns you one.`;
    await logChat(user.id, message, referralReply, "REFERRAL");
    return referralReply;
  }

  // ---- NEW: BMI ----
  if (["bmi", "my bmi", "what is my bmi", "what's my bmi", "check bmi"].includes(m)) {
    // THE STORED COLUMN IS THE DAY THEY SIGNED UP. A client who has lost 14kg asked this and was
    // told the category they left months ago, with "Meaningful progress is possible" underneath.
    const bmiVal = bmiOf(user);
    if (bmiVal === null) {
      return `Your BMI has not been calculated yet. Send me your weight and height — for example: "I am 75kg and 1.72m tall" — and I will calculate it.`;
    }
    const cat = bmiVal < 18.5 ? "underweight" : bmiVal < 25 ? "healthy weight range" : bmiVal < 30 ? "overweight range" : "obese range";
    const bmiNote = bmiVal < 18.5
      ? "Focus on eating enough — caloric surplus, high protein, strength training."
      : bmiVal < 25
        ? "Solid baseline. Build on this with consistency."
        : bmiVal < 30
          ? "Room to improve. Your programme and targets are calibrated for this."
          : "Meaningful progress is possible. Stay on the programme.";
    return `Your BMI is ${bmiVal.toFixed(1)} — ${cat}.\n\n${bmiNote}\n\nBMI is one number, not the full picture. Strength, energy, and consistency matter more.`;
  }

  // ---- NEW: TODAY'S WORKOUT ---- Exact phrases PLUS a tolerant matcher. Voice transcripts arrive with artifacts ("Meet today's workout." — Whisper mishearing "what's"), real typing arrives with punctuation ("Today's workout?"), and follow-ups arrive
  // as deixis ("Show it to me"). Every one of these must deliver the plan deterministically — when they miss, GPT improvises an unformatted workout paragraph with no warm-up and no logging path.
  const wReqStripped = m.replace(/^[.!?,;:'"\s]+|[.!?,;:'"\s]+$/g, "");
  const WORKOUT_REQ_EXACT = ["today", "today's workout", "todays workout", "my workout", "workout today", "show workout", "give me workout",
    "show me", "show", "send it", "send workout", "show session", "today's session", "todays session",
    "show it", "show it to me", "show me it", "send it to me", "send me it", "let me see", "let me see it",
    // "show me the exercises" — the exact phrase that used to fall through to the model,
    // which then hallucinated a DIFFERENT workout (2026-07-09). Route it to the real plan.
    "exercises", "the exercises", "show me the exercises", "show exercises", "show me exercises",
    "see the exercises", "show me the moves", "the moves", "exercise demos", "show me the exercise",
    "1", "day 1", "day 2", "day 3", "day 4", "day 5", "day 6"];
  const wReqNoun = /\b(workout|session|programme?|program|training|exercises?|moves?)\b/i.test(wReqStripped);
  // Completions, schedule moves, and complaints are NOT plan requests — other handlers own those.
  const wReqExcluded = /\b(done|did|finished|complete[d]?|smashed|crushed|killed|logged|next|tomorrow|yesterday|change|switch|swap|cancel|stop|pause|skip|move|reschedule|hate|boring|harder|easier|rest)\b/i.test(wReqStripped);
  const wReqShape = /\b(today.?s?|my|the|me|what.?s|what|give|show|send|see|meet|get|need|want|whats)\b/i.test(wReqStripped);
  const isWorkoutRequest = WORKOUT_REQ_EXACT.includes(wReqStripped)
    || (wReqNoun && !wReqExcluded && wReqShape && wReqStripped.split(/\s+/).length <= 6);
  if (isWorkoutRequest) {
    // Frictionless swipe-through of every move — one link, opens a full-screen page you
    // slide through (demo per exercise + the alternative). Server-rendered from the SAME
    // workout, so it can never disagree with the plan below. Only added for a real client.
    const viewerUrl = buildWorkoutViewerUrl(user.id);
    const viewerLine = viewerUrl ? `\n\n▶️ *See every move* — swipe through: ${viewerUrl}` : "";
    const dayMatch = wReqStripped.match(/^day\s*([1-6])$/);
    if (dayMatch) {
      const requestedDay = parseInt(dayMatch[1]);
      const dayUser = { ...user, programmeDayInWeek: requestedDay };
      const workout = buildDayWorkout(dayUser);
      const gif1 = getPrimaryWorkoutGifUrl(workout);
      return `*Day ${requestedDay} Workout*\n\n${workout}\n\nSend *done* when finished.${viewerLine}${gif1 ? `\n[MEDIA:${gif1}]` : ""}`;
    }
    const workout = buildDayWorkout(user);
    const dayNum = user.programmeDayInWeek || 1;
    const week = user.programmeWeek || 1;
    const totalSessions = user.totalWorkoutsCompleted || 0;
    // programmeWeek is phase-relative (resets to 1 each new phase), so "Week 1 | Session 19"
    // read as broken. Anchor the week to its phase so the two numbers make sense together.
    const phaseName = getPhaseNames()[user.programmePhase || 1] || "Foundation";
    const sessionNote = totalSessions > 0 ? ` · Session ${totalSessions + 1}` : "";
    const gif2 = getPrimaryWorkoutGifUrl(workout);
    return `*${phaseName} Phase · Week ${week}${sessionNote}*\n\n*Day ${dayNum} — Today's Workout*\n\n${workout}\n\nSend *done* when finished.${viewerLine}${gif2 ? `\n[MEDIA:${gif2}]` : ""}`;
  }

  // ---- NEW: NEXT WORKOUT ---- Exact bare phrases PLUS a shape match, so prefixed and voice-transcribed phrasings ("show me tomorrow's workout", "what's tomorrow's session") route here deterministically. "tomorrow" is
  // deliberately excluded from the today handler above, so without this these requests fall through to GPT — which fabricates a generic workout with no sets, weights, or logging path.
  const nextStripped = m.replace(/^[.!?,;:'"\s]+|[.!?,;:'"\s]+$/g, "");
  // Bare "tomorrow"/"what's tomorrow" removed: "Tomorrow???" is usually the client
  // QUESTIONING something the coach just said ("Tomorrow: lead breakfast with 3
  // eggs…") — answering it with a full workout dump was pure confusion (production,
  // 2026-07-03). Workout intent needs a workout word; bare questions go to the coach.
  const NEXT_WORKOUT_EXACT = ["next", "next workout", "tomorrow workout", "tomorrows workout", "what's next", "whats next", "next session", "next day", "tomorrow's session", "tomorrows session", "tomorrow's workout", "show me tomorrow"];
  const isNextWorkoutByShape =
    /\b(tomorrow|tomorrows|next)\b/i.test(nextStripped)
    && /\b(workout|session|programme?|program|training)\b/i.test(nextStripped)
    && !/\b(done|did|finished|complete[d]?|logged|change|switch|swap|cancel|skip|move|reschedule|rest|hate|boring|harder|easier)\b/i.test(nextStripped)
    && nextStripped.split(/\s+/).length <= 7;
  if (!ctx.isQuestion && (NEXT_WORKOUT_EXACT.includes(nextStripped) || isNextWorkoutByShape)) {
    // programmeDayInWeek is already set to the NEXT session after each "done" log —
    // just use it directly instead of advancing by one more step.
    const nextDay = user.programmeDayInWeek || 1;
    const nextDayUser = { ...user, programmeDayInWeek: nextDay };
    const nextWorkout = buildDayWorkout(nextDayUser);
    const week = user.programmeWeek || 1;
    const gifNext = getPrimaryWorkoutGifUrl(nextWorkout);
    return `*Week ${week} — Next Session (Day ${nextDay}):*\n\n${nextWorkout}\n\nSend *done* when finished.${gifNext ? `\n[MEDIA:${gifNext}]` : ""}`;
  }

  // ---- NEW: STREAK ----
  if (["streak", "my streak", "step streak", "current streak"].includes(m)) {
    const streak = await getStepStreak(user.id);
    // "Total workouts completed: N" is a progress claim, so it comes from workoutLogs.
    const workoutCount = (await getProgressTruth(user, { days: 3650 }).catch(() => null))?.sessions ?? 0;
    if (streak === 0) {
      return `No step streak yet — log today's steps and it starts at 1. 👟`;
    }
    const streakMsg = streak >= 7
      ? `🔥 ${streak}-day step streak. That is serious consistency — do not stop now.`
      : streak >= 3
        ? `🔥 ${streak}-day step streak. You are building something real. Keep it going.`
        : `${streak} days in a row. Keep adding days — streaks build habits.`;
    return `${streakMsg}\n\nTotal workouts completed: ${workoutCount}.`;
  }

  // ---- NPS / CLIENT FEEDBACK — "rate", "feedback", "survey" ----
  if (m === "rate" || m === "feedback" || m === "survey" || m === "rate coach k" || m === "nps" || /\b(rate\s*coach|give\s*feedback|how.?s?\s*the\s*service|satisfaction)\b/i.test(m)) {
    // Check if they are sending a rating (0-10) — also capture bare numbers when last bot msg was NPS survey
    const ratingMatch = m.match(/\b(0|[1-9]|10)\s*(?:out of 10|\/10|stars?)?\b/);
    const lastBotForNPS = await db.select({ messageOut: chatHistory.messageOut, intent: chatHistory.intent })
      .from(chatHistory).where(eq(chatHistory.userId, user.id)).orderBy(desc(chatHistory.createdAt)).limit(1);
    const lastWasNPS = (lastBotForNPS[0]?.intent === "NPS_SURVEY") || /scale of 1-10|recommend Coach K/i.test(lastBotForNPS[0]?.messageOut || "");

    // Accept a bare number if the last bot message was the NPS survey
    const scoreStr = ratingMatch && (lastWasNPS || /\b(rate|rating|score|feedback|survey|nps)\b/i.test(m)) ? ratingMatch[1] : null;
    if (scoreStr !== null) {
      const score = parseInt(scoreStr);
      const category = score >= 9 ? "promoter" : score >= 7 ? "passive" : "detractor";
      await logChat(user.id, message, `NPS: ${score}/10 (${category})`, "NPS_RATING");

      let followUp = "";
      if (score >= 9) {
        followUp = `${score}/10 — sharp. Type *refer* to get your referral code and share this with someone who needs it.`;
      } else if (score >= 7) {
        followUp = `${score}/10. What is the one thing that would make it a 10? Tell me straight.`;
      } else if (score >= 4) {
        followUp = `${score}/10. What specifically is not working? One thing. I will fix it.`;
      } else {
        // 0-3: low score — acknowledge directly, no corporate speak
        followUp = `${score}/10 — I needed to hear that. What broke down? Be specific and I will address it directly.`;
      }
      return followUp;
    }

    // Check if they're giving written feedback after a rating
    const recentNPS = await db.select({ id: chatHistory.id }).from(chatHistory)
      .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "NPS_RATING")))
      .orderBy(desc(chatHistory.createdAt)).limit(1);

    if (recentNPS.length > 0 && m.length > 10 && !/\b(rate|feedback|survey)\b/i.test(m)) {
      await logChat(user.id, message, "Feedback noted", "NPS_FEEDBACK");
      return `Noted. I will use this to improve. Keep telling me what works and what does not.`;
    }

    // Prompt for rating — no emojis, Coach K voice
    const name = user.name?.split(" ")[0] || "there";
    const daysOn = daysOnProgramme(user);
    await logChat(user.id, message, `NPS survey prompted (${daysOn} days on programme)`, "NPS_SURVEY");
    return `${name}, one question:\n\nHow likely are you to recommend Coach K to a friend? Reply with a number from 1 to 10.\n\n1 = Not at all. 10 = Definitely.\n\nHonest answer only — I read every one.`;
  }

  // ---- WATER REPORT — "my water" trend report ----
  if (m === "my water" || m === "water report" || m === "water stats" || m === "water history" || /\b(water\s*report|water\s*history|water\s*trend|how.?s?\s*my\s*water|water\s*stats)\b/i.test(m)) {
    try {
      const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
      const waterLogs = await db.select({ messageIn: chatHistory.messageIn, date: chatHistory.createdAt }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "WATER_LOG"), gte(chatHistory.createdAt, fourteenDaysAgo)))
        .orderBy(desc(chatHistory.createdAt));

      if (waterLogs.length === 0) {
        return `No water logs in the last 14 days. Start logging: "drank 500ml water" or "had 2 glasses water". Hydration is recovery.`;
      }

      // Group by date and sum litres
      const dailyTotals: Record<string, number> = {};
      for (const log of waterLogs) {
        if (!log.date) continue;
        const dateKey = new Date(log.date).toISOString().slice(0, 10);
        const litreMatch = (log.messageIn || "").match(/(\d+(?:\.\d+)?)\s*(?:l|litre|liter|ml|glass|cup|bottle)/i);
        if (litreMatch) {
          const val = parseFloat(litreMatch[1]);
          const unit = (log.messageIn || "").match(/(ml|glass|cup|bottle)/i)?.[1]?.toLowerCase() || "l";
          let litres = val;
          if (unit === "ml") litres = val / 1000;
          else if (unit === "glass" || unit === "cup") litres = val * 0.25;
          else if (unit === "bottle") litres = val * 0.5;
          dailyTotals[dateKey] = (dailyTotals[dateKey] || 0) + litres;
        }
      }

      const days = Object.entries(dailyTotals).sort((a, b) => b[0].localeCompare(a[0]));
      const wKg = parseFloat(user.currentWeight as string || "0") || 75;
      const waterTarget = waterTargetLitres(user.currentWeight as string);
      const avgDaily = days.length > 0 ? days.reduce((s, [, v]) => s + v, 0) / days.length : 0;
      const targetHitDays = days.filter(([, v]) => v >= waterTarget).length;
      const name = user.name?.split(" ")[0] || "there";

      let grade = "🔴";
      if (avgDaily >= waterTarget * 0.9) grade = "🟢";
      else if (avgDaily >= waterTarget * 0.6) grade = "🟡";

      const wrTodaySAST = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
      const wrYestSAST = new Date(Date.now() + 2 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
      const displayedWaterStreak = (user.waterLastResetDate === wrTodaySAST || user.waterLastResetDate === wrYestSAST) ? (user.waterStreak || 0) : 0;

      const historyLines = days.slice(0, 7).map(([date, litres]) => {
        const d = new Date(date).toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" });
        const emoji = litres >= waterTarget ? "✅" : litres >= waterTarget * 0.5 ? "⚠️" : "🔴";
        return `${d}: ${litres.toFixed(1)}L ${emoji}`;
      }).join("\n");

      const report = `*💧 Water Report — ${name}*\n\n` +
        `Target: *${waterTarget}L/day* (based on ${wKg}kg)\n` +
        `Average: *${avgDaily.toFixed(1)}L/day* ${grade}\n` +
        `Target hit: ${targetHitDays}/${days.length} days\n` +
        `Streak: ${displayedWaterStreak} days\n\n` +
        `_Last 7 days:_\n${historyLines}\n\n` +
        (avgDaily < waterTarget * 0.6 ? `You are significantly under-hydrated. Dehydration slows fat loss, kills energy, and makes training harder. Set a phone alarm every 2 hours to drink.` :
         avgDaily < waterTarget * 0.9 ? `Close but not consistent. Carry a bottle everywhere. If you can see it, you will drink it.` :
         `Solid hydration. This supports every other goal — fat loss, recovery, energy. Keep it up.`);

      await logChat(user.id, message, report, "WATER_REPORT");
      return report;
    } catch (err) {
      console.error("[WATER REPORT]", err);
      return `Could not generate water report. Try again later.`;
    }
  }


  // ---- BODY RECOMPOSITION TRACKER — "my body", "body check", "recomp" ----
  if (m === "my body" || m === "body check" || m === "recomp" || m === "body recomp" || m === "body composition" || /\b(body\s*check|body\s*comp|recomp|my\s*body|body\s*progress)\b/i.test(m)) {
    try {
      const [weights, measurements, workouts, clothingData] = await Promise.all([
        // Same owner, same reason: "body check" is the client asking about their own body.
        getWeightTruth(user, { clientMessage: m }).then(w => w.points.map(p => ({ weight: p.kg, date: p.at }))),
        db.select({ type: bodyMeasurements.measurementType, value: bodyMeasurements.value, date: bodyMeasurements.loggedAt })
          .from(bodyMeasurements).where(eq(bodyMeasurements.userId, user.id)).orderBy(desc(bodyMeasurements.loggedAt)).limit(20),
        db.select({ id: workoutLogs.id }).from(workoutLogs).where(eq(workoutLogs.userId, user.id)),
        db.select().from(clothingCheckins).where(eq(clothingCheckins.userId, user.id)).orderBy(desc(clothingCheckins.loggedAt)).limit(1),
      ]);

      const name = user.name?.split(" ")[0] || "there";
      const daysOn = daysOnProgramme(user);
      let report = `*🏋️ Body Composition Check — ${name}*\n_${daysOn} days on programme_\n\n`;

      // Weight trend
      //
      // THE THIRD MOUTH (#128). #126 wired the chart and the history command to the owner of "may
      // a direction be spoken", and this one — the client asking about their own BODY — still
      // computed `last − first` and asserted an arrow, a monthly pace and a verdict over it. Three
      // surfaces answering one question, two of them asking permission. On a window that spans an
      // illness the client could read "I'm not calling a direction off these" from the chart and
      // "⬇️ Down 3.1kg · 2.4kg/month ✅ healthy pace" from "body check", in the same hour.
      //
      // The pace and the verdict are strictly MORE than the arrow, so they are gated by the same
      // answer rather than by rules of their own.
      const { weightDirectionSpeakable } = await import("../adaptive-targets");
      const bodySpeech = await weightDirectionSpeakable(
        weights.map(w => ({ at: new Date(w.date as any) })), user);
      if (weights.length >= 2) {
        const first = parseFloat(String(weights[0].weight));
        const last = parseFloat(String(weights[weights.length - 1].weight));
        const diff = last - first;
        const trend = diff < -0.5 ? `⬇️ Down ${Math.abs(diff).toFixed(1)}kg` : diff > 0.5 ? `⬆️ Up ${diff.toFixed(1)}kg` : "➡️ Stable";
        // THE NUMBERS ARE NOT THE CLAIM — the same shape the chart and the history command use.
        // They asked about their body and still get their weigh-ins; what is withheld is the
        // word that reads as a direction.
        report += bodySpeech.speakable
          ? `*Weight:* ${last.toFixed(1)}kg (${trend} from ${first.toFixed(1)}kg start)\n`
          : `*Weight:* start ${first.toFixed(1)}kg · now ${last.toFixed(1)}kg — not enough clear weigh-ins to call a direction\n`;

        // Monthly rate
        const monthsOn = Math.max(1, daysOn / 30);
        const monthlyRate = Math.abs(diff) / monthsOn;
        if (bodySpeech.speakable && user.goalType === "fat_loss" && diff < 0) {
          report += `Rate: ${monthlyRate.toFixed(1)}kg/month ${monthlyRate >= 2 && monthlyRate <= 4 ? "✅ healthy pace" : monthlyRate > 4 ? "⚠️ fast — ensure you are eating enough" : "— could push harder"}\n`;
        }
      } else {
        report += `*Weight:* ${user.currentWeight || "not logged"}kg — log more to see trends\n`;
      }

      // Measurements
      const latestByType: Record<string, string> = {};
      for (const m2 of measurements) {
        if (!latestByType[m2.type]) latestByType[m2.type] = m2.value;
      }
      if (Object.keys(latestByType).length > 0) {
        report += `\n*Measurements:*\n`;
        for (const [type, val] of Object.entries(latestByType)) {
          report += `• ${type}: ${val}\n`;
        }
      }

      // Clothing check-in
      if (clothingData.length > 0) {
        const c = clothingData[0];
        report += `\n*Last Clothing Check-In:*\n`;
        if (c.jeansFit) report += `Jeans: ${c.jeansFit}\n`;
        if (c.energyLevel) report += `Energy: ${c.energyLevel}\n`;
        if (c.stomachFeel) report += `Stomach: ${c.stomachFeel}\n`;
      }

      // Training volume
      report += `\n*Training:* ${workouts.length} total sessions | Streak: ${user.workoutStreak || 0}\n`;

      // Verdict
      // A VERDICT IS A DIRECTION WITH A CONCLUSION ATTACHED. "Losing fat while training
      // consistently" carries the claim without using a direction word, which is exactly what the
      // sentence-by-sentence outbound gate cannot catch — the same trap #126 documented on the
      // chart. So it asks the same owner, and when the answer is no it says what it can honestly
      // say: keep logging.
      const totalWorkoutsN = workouts.length;
      if (weights.length >= 2 && totalWorkoutsN >= 5 && bodySpeech.speakable) {
        const wDiff = parseFloat(String(weights[weights.length - 1].weight)) - parseFloat(String(weights[0].weight));
        if (wDiff < -1 && totalWorkoutsN >= 10) {
          report += `\n✅ *Verdict:* Losing fat while training consistently. Body recomposition in progress. Stay the course.`;
        } else if (wDiff > 1 && user.goalType === "muscle_gain") {
          report += `\n✅ *Verdict:* Gaining weight while training. If lifts are going up — this is muscle. Keep pushing.`;
        } else if (Math.abs(wDiff) < 1 && totalWorkoutsN >= 10) {
          report += `\n📊 *Verdict:* Weight stable but training hard. This often means fat loss + muscle gain happening simultaneously. Check measurements and how clothes fit — the scale does not tell the full story.`;
        } else {
          report += `\n📊 Keep logging weight and training. More data = better insights.`;
        }
      } else {
        report += `\n📊 Need more data — keep logging weight and workouts for a full picture.`;
      }

      await logChat(user.id, message, report, "BODY_RECOMP");
      return report;
    } catch (err) {
      console.error("[BODY RECOMP]", err);
      return `Could not generate body check right now. Try again later.`;
    }
  }

  // ---- SHARE CARD — "share my progress", "share" ----
  if (m === "share" || m === "share my progress" || m === "share progress" || m === "brag" || /\b(share\s*my|share\s*progress|tell\s*everyone|brag)\b/i.test(m)) {
    const name = user.name?.split(" ")[0] || "there";
    const daysOn = daysOnProgramme(user);
    const streak = user.workoutStreak || 0;
    const foodStreakForShare = await computeFoodLogStreak(user.id).catch(() => 0);

    // ONE TRUTH FOR THE THING THEY FORWARD (2026-08-19, Cut 11). This ran its own weight query
    // with the OPPOSITE sign convention to report-card — first minus last here, last minus first
    // there — so the same client's week could read "down 2kg" on a shared card and "up 2kg" in a
    // report. The card is the one that goes to their friends, which makes it the worst place for
    // the divergence to live.
    //
    // The object also refuses to carry the number at all when they asked us to drop the scale, so
    // a public card cannot leak what a private chat is honouring.
    let weightLine = "";
    let kgDown = 0;
    let totalWorkouts = 0;
    try {
      const truth = await getProgressTruth(user, { days: 3650 });
      totalWorkouts = truth.sessions; // workoutLogs, not the users-row counter that drifts from it
      if (truth.weight.known && truth.weight.changeKg !== null && truth.weight.changeKg < -1) {
        kgDown = Math.abs(truth.weight.changeKg);
        weightLine = `\n⚖️ Down ${kgDown.toFixed(1)}kg`;
      }
    } catch { /* non-fatal — the card falls back to streak and sessions */ }

    // A PICTURE, NOT HOMEWORK (2026-07-28, founder: "if a person wants to share it with their friends, THAT is what it brings up"). This used to hand back text ending in "copy this and share it" — asking the client to do the work, in a format nobody forwards. Now it is the achievement card, built from their strongest REAL number; fail-open to the old text.
    const ach = shareAchievement({ firstName: name, weightChangeKg: kgDown > 0 ? -kgDown : undefined, streak: foodStreakForShare, sessions: totalWorkouts });
    const marker = ach ? achievementCardMarker(ach) : "";
    const shareCard = marker
      ? `${name}, here's your card. 👇\n\nSave it or put it straight on your status — everything on it is real, and it's yours.${marker}`
      : `*💪 ${name}'s KamLife Coach Progress*\n\n📅 ${daysOn} days on programme\n✅ ${totalWorkouts} workouts completed\n🔥 ${streak}-session streak${weightLine}\n\n_Coached by KamLife Coach on WhatsApp._\n\nLog a few more days and I'll make you a proper card to share.`;

    await logChat(user.id, message, shareCard, "SHARE_CARD");
    return shareCard;
  }

  // ---- MEAL TIMING COACH — "when should I eat", "pre workout meal", "post workout" ----
  // Conversational nutrition question (kcal-heavy template) — engine owns it when live.

  // ---- WEEKLY FOOD AUDIT — "food audit", "eating audit", "diet check" ----
  if (m === "food audit" || m === "diet check" || m === "eating audit" || m === "audit" || /\b(food\s*audit|diet\s*check|eating\s*audit|week.?s?\s*eating|how.?s?\s*my\s*diet|diet\s*review)\b/i.test(m)) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const foodLogs = await db.select({ messageIn: chatHistory.messageIn, date: chatHistory.createdAt }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, sevenDaysAgo)))
        .orderBy(desc(chatHistory.createdAt));

      if (foodLogs.length < 3) {
        return `Not enough food logs this week for an audit. Log at least 3 meals and I will analyse your eating patterns.\n\nJust tell me what you ate — "2 eggs and toast" — and I will track it.`;
      }

      let junkCount = 0;
      let proteinMeals = 0;
      let totalMeals = foodLogs.length;
      const foodFreq: Record<string, number> = {};

      for (const log of foodLogs) {
        const text = (log.messageIn || "").toLowerCase();
        // Junk detection
        if (JUNK_WORDS.some(j => text.includes(j))) junkCount++;
        // Protein detection
        if (PROTEIN_WORDS.some(p => text.includes(p))) proteinMeals++;
        // Food frequency
        const matched = scanForSAFoods(text);
        for (const food of matched) {
          const key = food.name;
          foodFreq[key] = (foodFreq[key] || 0) + 1;
        }
      }

      const topFoods = Object.entries(foodFreq).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const proteinRate = Math.round(proteinMeals / totalMeals * 100);
      const junkRate = Math.round(junkCount / totalMeals * 100);
      const name = user.name?.split(" ")[0] || "there";

      let audit = `*🔍 Weekly Food Audit — ${name}*\n_${totalMeals} meals logged this week_\n\n`;

      // Top foods
      if (topFoods.length > 0) {
        audit += `*Most eaten:*\n${topFoods.map(([food, count]) => `• ${food} (${count}×)`).join("\n")}\n\n`;
      }

      // Protein consistency
      audit += `*Protein in meals:* ${proteinRate}% ${proteinRate >= 80 ? "✅" : proteinRate >= 50 ? "⚠️" : "🔴"}\n`;
      if (proteinRate < 50) audit += `_Add protein to every meal — eggs, chicken, pilchards, beans._\n`;

      // Junk frequency
      audit += `*Junk food frequency:* ${junkCount}/${totalMeals} meals (${junkRate}%) ${junkRate <= 10 ? "✅" : junkRate <= 20 ? "⚠️" : "🔴"}\n`;
      if (junkRate > 20) audit += `_More than 1 in 5 meals is junk. Replace one junk meal per week with a real food option._\n`;

      // Variety check
      const uniqueFoods = Object.keys(foodFreq).length;
      audit += `*Variety:* ${uniqueFoods} different foods ${uniqueFoods >= 10 ? "✅ Good variety" : uniqueFoods >= 5 ? "⚠️ Could be more varied" : "🔴 Very limited — try new foods"}\n`;

      // Overall grade
      const auditScore = (proteinRate >= 70 ? 2 : proteinRate >= 50 ? 1 : 0) +
        (junkRate <= 10 ? 2 : junkRate <= 20 ? 1 : 0) +
        (uniqueFoods >= 8 ? 1 : 0);
      const auditGrade = auditScore >= 4 ? "A" : auditScore >= 3 ? "B" : auditScore >= 2 ? "C" : "D";

      audit += `\n*Week Grade: ${auditGrade}*\n`;
      audit += auditGrade === "A" ? `Elite eating this week. Keep it up.` :
        auditGrade === "B" ? `Good week. Small tweaks — more protein, less junk — and this is an A.` :
        auditGrade === "C" ? `Room to improve. Focus on protein at every meal and cut one junk meal.` :
        `Inconsistent week. Start tomorrow with eggs and build from there.`;

      await logChat(user.id, message, audit, "FOOD_AUDIT");
      return audit;
    } catch (err) {
      console.error("[FOOD AUDIT]", err);
      return `Could not generate food audit right now. Try again later.`;
    }
  }


  // ---- WORKOUT HISTORY — "my workouts", "workout history", "workout diary" ----
  if (m === "my workouts" || m === "workout history" || m === "workout diary" || m === "recent workouts" || /\b(workout\s*history|workout\s*diary|my\s*workouts|recent\s*workout|past\s*workout|training\s*history)\b/i.test(m)) {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
      const recentWorkouts = await db.select({ date: workoutLogs.loggedAt, completed: workoutLogs.workoutCompleted })
        .from(workoutLogs)
        .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, thirtyDaysAgo)))
        .orderBy(desc(workoutLogs.loggedAt));

      if (recentWorkouts.length === 0) {
        return `No workouts logged in the last 30 days. Say *workout* to see today's session and get started.`;
      }

      const name = getDisplayName(user) || "there";
      // A PROGRESS CLAIM, so it comes from workoutLogs — not the users-row counter, which is a
      // separate scoreboard that drifts from the log table the moment one write fails.
      const totalWorkouts = (await getProgressTruth(user, { days: 3650 }).catch(() => null))?.sessions ?? 0;
      const streak = user.workoutStreak || 0;

      // Group workouts by week
      const weekMap: Record<string, number> = {};
      for (const w of recentWorkouts) {
        if (!w.date) continue;
        const d = new Date(w.date);
        const weekStart = new Date(d); weekStart.setDate(d.getDate() - d.getDay());
        const key = weekStart.toLocaleDateString("en-ZA", { day: "numeric", month: "short" });
        weekMap[key] = (weekMap[key] || 0) + 1;
      }

      let history = `*📋 Workout History — ${name}*\n` +
        `_${recentWorkouts.length} sessions in last 30 days | ${totalWorkouts} all-time | Streak: ${streak}_\n\n`;

      // Weekly breakdown
      history += `*By week:*\n`;
      for (const [week, count] of Object.entries(weekMap)) {
        const target = user.trainingDaysPerWeek || 3;
        const emoji = count >= target ? "✅" : count >= target - 1 ? "⚠️" : "🔴";
        history += `• Week of ${week}: ${count}/${target} sessions ${emoji}\n`;
      }

      // Consistency check
      const weeksTracked = Object.keys(weekMap).length;
      const avgPerWeek = weeksTracked > 0 ? (recentWorkouts.length / weeksTracked).toFixed(1) : "0";
      history += `\n*Average:* ${avgPerWeek} sessions/week`;
      history += parseFloat(avgPerWeek) >= (user.trainingDaysPerWeek || 3) ? ` ✅ On target` : ` — target is ${user.trainingDaysPerWeek || 3}/week`;

      await logChat(user.id, message, history, "WORKOUT_HISTORY");
      return history;
    } catch (err) {
      console.error("[WORKOUT HISTORY]", err);
      return `Could not load workout history. Try again later.`;
    }
  }

  // ---- MOOD / STRESS CHECK-IN — "stressed", "mood", "how am I feeling" ----
  if (m === "mood" || m === "stress" || m === "stressed" || m === "anxious" || m === "feeling down" || m === "mental health" || /\b(stress|mood|anxious|anxiety|depressed|burnt?\s*out|overwhelm|mental\s*health|feeling\s*down|feeling\s*low|not\s*coping)\b/i.test(m)) {
    // Check if they are logging a mood score
    const moodScore = m.match(/\b(mood|stress|feeling)\b.*?(\d)\s*(?:out of|\/)\s*(?:5|10)/i) || m.match(/\b(mood|stress)\s*(\d)\b/i);
    if (moodScore) {
      const score = parseInt(moodScore[2]);
      await logChat(user.id, message, `Mood: ${score}`, "MOOD_LOG");
      const reply = score <= 3
        ? `Mood ${score} — noted. On hard days, a 15-minute walk outside does more for your brain than any motivational quote. Move your body even if training feels impossible today. Small action beats no action.`
        : score <= 6
          ? `Mood ${score} — middle ground. Your body and mind are connected. A good training session or even a walk will shift this upward. What can you do in the next 30 minutes?`
          : `Mood ${score} — strong. Channel that energy into today's session. Good headspace = good training = good results. Let's go.`;
      return reply;
    }

    return null; // the engine owns this — its own guards keep the SADAG net
  }


  // ---- EXERCISE SUBSTITUTION ENGINE — "can't do X", "alternative to X" ----
  if (/\b(can.?t\s+do|cannot\s+do|alternative\s+(?:to|for)|replace\s+(?:squat|bench|deadlift|pull.?up|push.?up|lunge|press|curl|row)|instead\s+of\s+(?:squat|bench|deadlift|pull.?up|push.?up|lunge|press|curl|row))\b/i.test(m)) {
    const exerciseSubs: Record<string, { why: string; home: string[]; gym: string[] }> = {
      squat: { why: "knee, hip, or back issue", home: ["Wall sit (30-60 seconds)", "Glute bridge (3×15)", "Step-ups on chair (3×10 each leg)", "Sumo squat (wider stance, less knee pressure)"], gym: ["Leg press (less spine load)", "Goblet squat (lighter, controlled)", "Smith machine squat (guided path)", "Hack squat"] },
      deadlift: { why: "lower back concern", home: ["Hip hinge with water bottles (3×12)", "Single-leg Romanian deadlift (3×10)", "Glute bridge (3×15)", "Bird dog (3×10 each)"], gym: ["Trap bar deadlift (neutral spine)", "Romanian deadlift (lighter, controlled)", "Cable pull-through", "Hip thrust (barbell or machine)"] },
      bench: { why: "shoulder or chest strain", home: ["Push-ups (knees if needed, 3×12)", "Floor press with water bottles (3×12)", "Wall push-ups (3×15)", "Resistance band chest press"], gym: ["Dumbbell bench (better shoulder position)", "Incline dumbbell press", "Cable chest fly", "Machine chest press"] },
      "pull-up": { why: "not strong enough yet or shoulder issue", home: ["Doorframe row with towel (3×10)", "Resistance band pull-apart (3×15)", "Inverted row under table (3×8)", "Superman hold (3×20 seconds)"], gym: ["Lat pulldown (build strength first)", "Assisted pull-up machine", "Cable row", "Band-assisted pull-ups"] },
      "push-up": { why: "wrist, shoulder, or strength limitation", home: ["Wall push-ups (3×15)", "Knee push-ups (3×12)", "Incline push-ups on chair (3×10)", "Plank hold (3×30 seconds)"], gym: ["Machine chest press", "Dumbbell bench press", "Cable chest press", "Smith machine push-up"] },
      lunge: { why: "knee or balance issue", home: ["Split squat (stationary, 3×10)", "Step-ups (3×10 each)", "Wall sit (3×30 seconds)", "Glute bridge (3×15)"], gym: ["Leg press (single leg)", "Bulgarian split squat (bench support)", "Step-ups with dumbbells", "Leg extension + leg curl combo"] },
      "overhead press": { why: "shoulder impingement or pain", home: ["Lateral raise with bottles (3×12)", "Front raise (3×10)", "Wall slide (3×12)", "Resistance band press (45° angle)"], gym: ["Landmine press (shoulder-friendly angle)", "Cable lateral raise", "Machine shoulder press (guided path)", "Incline dumbbell press (30°)"] },
    };

    const exerciseNames = Object.keys(exerciseSubs);
    const matchedExercise = exerciseNames.find(ex => m.includes(ex) || m.includes(ex.replace("-", " ")) || m.includes(ex.replace("-", "")));
    const mode = user.trainingMode || "home";
    const name = user.name?.split(" ")[0] || "";

    if (matchedExercise) {
      const sub = exerciseSubs[matchedExercise];
      const alternatives = mode === "gym" ? sub.gym : sub.home;
      const reply = `*🔄 ${matchedExercise.charAt(0).toUpperCase() + matchedExercise.slice(1)} Alternatives${name ? ` — ${name}` : ""}*\n\n` +
        `Common reason: ${sub.why}\n\n` +
        `*${mode === "gym" ? "Gym" : "Home"} alternatives:*\n${alternatives.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n\n` +
        `Pick one and work it into your programme. Same muscles, different movement. Reply *done* after your session.`;
      await logChat(user.id, message, reply, "EXERCISE_SUB");
      return reply;
    }

    // Generic substitution advice
    const reply = `Tell me which exercise you cannot do and I will give you alternatives.\n\nExamples:\n• "can't do squats" (knee issue)\n• "alternative to deadlift" (back concern)\n• "can't do pull-ups" (not strong enough yet)\n• "instead of bench press" (shoulder pain)\n\nI have alternatives for every exercise — ${mode === "gym" ? "gym" : "home"} options based on your setup.`;
    return reply;
  }

  // ---- EXERCISE VARIANTS GUIDE — "show me shoulder press", "types of leg press", "row options" ---- A GENERIC movement name ("shoulder press") means "which machine is this and how
  // do I use it" — clients without a trainer ask this constantly. Show the menu of real-world variants with how-to-spot-each. A SPECIFIC variant ("machine shoulder press") or an explicit
  // form request ("shoulder press form") returns null here and falls through to the single-image demo below — so the guide can safely point users at "<movement> form" without looping.
  {
    const famKey = matchVariantGuideRequest(m);
    if (famKey) {
      const guide = formatVariantGuide(famKey);
      if (guide) {
        await logChat(user.id, message, `${famKey} variants guide`, "EXERCISE_VARIANTS");
        return guide;
      }
    }
  }

  // ---- EXERCISE DEMO — "show me squat", "how to do a bicep curl", "squat form" ----
  // Extraction is two-stage: capture the phrase after a lead-in, THEN strip filler
  // words ("how to do", "a/an/the", trailing "please/exercise/form") so the leftover
  // is a clean exercise name the slug lookup can resolve. Previously "show me how to
  // do a dumbbell bicep curl" captured the literal filler and failed to match.
  {
    let demoName = (
      m.match(/^(?:can\s+you\s+|could\s+you\s+|please\s+)?show\s+(?:me\s+)?(.+?)$/i)?.[1] ||
      m.match(/^how\s+(?:to|do\s+(?:i|you))\s+(.+?)$/i)?.[1] ||
      m.match(/^demo(?:nstrate)?\s+(.+?)$/i)?.[1] ||
      m.match(/^what\s+(?:does|do)\s+(?:a\s+|an\s+|the\s+)?(.+?)\s+look\s+like\b.*$/i)?.[1] ||
      m.match(/^(.+?)\s+(?:gif|form|technique|demo)$/i)?.[1]
    )?.trim().toLowerCase();
    if (demoName) {
      demoName = demoName
        .replace(/^(?:how\s+to\s+(?:do\s+)?|do\s+(?:a\s+)?|a\s+|an\s+|the\s+)/i, "")
        .replace(/\s+(?:gif|form|technique|demo|please|exercise|movement|properly|correctly|for\s+me)$/i, "")
        .replace(/^(?:a\s+|an\s+|the\s+)/i, "")
        .trim();
    }
    if (demoName && demoName.length > 2 && demoName.length < 40) {
      const demoGifUrl = getExerciseGifUrl(demoName);
      const displayName = demoName.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      if (demoGifUrl) {
        const formCue = getExerciseDemoFormCue(demoName);
        const demoReply = `*${displayName} — Form Demo*\n\n${formCue}\n\nDoing it today? Hit *done* after your session and tell me how it felt. If anything feels sharp, stop and reply *injury*.\n[MEDIA:${demoGifUrl}]`;
        await logChat(user.id, message, `${displayName} — Form Demo (image sent)`, "EXERCISE_DEMO");
        return demoReply;
      }
      // Known exercise phrase but no image yet — still catch it, don't let GPT respond
      const KNOWN_EXERCISE_WORDS = /\b(squat|lunge|press|row|curl|raise|thrust|bridge|deadlift|rdl|plank|push.?up|pull.?up|pulldown|dip|extension|kickback|crunch|fly|flye|step.?up|hinge|deadbug|dead bug|hip|glute|calf|leg)\b/i;
      if (KNOWN_EXERCISE_WORDS.test(demoName)) {
        const textReply = `*${displayName}*\n\nImage not available yet — but here's the key form:\n\nFull range of motion on every rep. Control the down phase — don't let gravity do the work. If it hurts sharp, stop immediately and reply *injury*.\n\nTrying it today? Send *done* after and tell me how it felt. For a full demo, search *"${displayName} form"* on YouTube.`;
        await logChat(user.id, message, `${displayName} — Form (text only, no image)`, "EXERCISE_DEMO");
        return textReply;
      }
    }
  }

  // ---- MEAL PLATE IMAGES — "breakfast plate", "show me lunch portions", "dinner plate guide" ----
  // EDUCATOR, not the Coach. "breakfast" in a logged meal + "guide" in a day-plan ask used to
  // claim the resumed turn (live 2026-08-22 13:05) and return The Plate Method while chooseAction
  // never ran. A genuine plate ask still owns the turn — only a write on THIS turn stands it down.
  {
    const plateMealMatch = m.match(/\b(breakfast|lunch|dinner|supper)\b/i);
    const isPlateRequest = plateMealMatch && /\b(plate|portion|image|pic|show|guide|look|example|what does|how does)\b/i.test(m);
    if (isPlateRequest) {
      if (wroteThisTurn) return null;
      const rawMeal = plateMealMatch[1].toLowerCase();
      const mealType = rawMeal === "supper" ? "dinner" : rawMeal as "breakfast" | "lunch" | "dinner";
      const { imageUrl, caption } = getPortionGuide(mealType);
      const plateReply = imageUrl ? `${caption}\n[MEDIA:${imageUrl}]` : caption;
      await logChat(user.id, message, caption, "PORTION_IMAGE");
      return plateReply;
    }
  }

  // ---- PORTION SIZE GUIDE — "portions", "how much should I eat", "serving size" ----
  if (!wroteThisTurn && (m === "portions" || m === "portion guide" || m === "serving size" || /\b(portion\s*(?:size|guide|control)|serving\s*size|how\s*much\s*(?:should|must|do)\s*i\s*eat|plate\s*size|hand\s*portion)\b/i.test(m))
    && !/\b(weight|gain(?:ing)?|los(?:e|ing)|per week|kg)\b/i.test(m)) {
    const goal = user.goalType || "fat_loss";
    const name = user.name?.split(" ")[0] || "";
    const portionGuide = `*✋ Portion Size Guide${name ? ` — ${name}` : ""}*\n_Use your hand — works everywhere, no scale needed_\n\n` +
      `*Protein* (palm size = ~25-30g protein):\n` +
      `👋 ${goal === "muscle_gain" ? "2 palms per meal (men), 1.5 palms (women)" : "1 palm per meal (women), 1.5 palms (men)"}\n` +
      `That is: 1 chicken breast, 150g mince, 2 eggs + pilchards, 200g fish\n\n` +
      `*Carbs* (cupped hand = ~25-30g carbs):\n` +
      `🤲 ${goal === "fat_loss" ? "1 cupped hand per meal" : "2 cupped hands per meal"}\n` +
      `That is: 1 scoop pap, 1 scoop rice, 1 slice bread, 1 small sweet potato\n\n` +
      `*Vegetables* (fist size):\n` +
      `✊ 2 fists per meal — fill half your plate\n` +
      `That is: big portion spinach, cabbage, broccoli, salad, tomatoes\n\n` +
      `*Fats* (thumb size = ~7-10g fat):\n` +
      `👍 ${goal === "fat_loss" ? "1 thumb per meal" : "2 thumbs per meal"}\n` +
      `That is: 1 tsp oil, 1 tbsp peanut butter, small handful nuts\n\n` +
      `*The Plate Rule:*\n` +
      `Half vegetables | Quarter protein | Quarter carbs\n` +
      `This works at any braai, restaurant, or family dinner. No counting needed.`;

    await logChat(user.id, message, portionGuide, "PORTION_GUIDE");
    return portionGuide;
  }

  // ---- WEIGHT TREND CHART — "weight chart", "weight graph", "weight trend" ----
  // "Where SHOULD my weight be in 6 months??" matched bare "my weight" and got an
  // ASCII history chart instead of an answer (2026-07-03). Future/target questions
  // are projections — handled below; bare "my weight" now shows the clean summary.
  const asksWeightProjection = /\b(should|target|goal|aim)\b.{0,40}\bweight\b|\bweight\b.{0,40}\b(in|by)\s+(\d+\s*(?:weeks?|months?)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|next year)\b/i.test(m);
  if (!asksWeightProjection && !ctx.isQuestion && (m === "weight chart" || m === "weight graph" || m === "weight trend" || m === "my weight" || /\b(weight\s*(?:chart|graph|trend|history|journey)|scale\s*trend)\b/i.test(m))) {
    try {
      // "my weight" / "weight chart" — they raised it, so the owner answers rather than withholds.
      const weights = (await getWeightTruth(user, { clientMessage: m })).points
        .map(p => ({ weight: p.kg, date: p.at }));

      if (weights.length < 2) {
        return `Not enough weight logs for a trend. Log your weight regularly — "84.5kg" — and I will show you the full picture over time.`;
      }

      const name = user.name?.split(" ")[0] || "there";
      const vals = weights.map(w => parseFloat(String(w.weight)));

      // WhatsApp is not a terminal — the old ASCII dot-chart rendered as broken
      // monospace soup on phones ("nobody's paying R199 for this", 2026-07-03).
      // A clean start→now line + pace tells the same story properly.
      const spanDays = weights.length >= 2 && weights[0].date && weights[weights.length - 1].date
        ? Math.max(1, Math.round((new Date(weights[weights.length - 1].date as any).getTime() - new Date(weights[0].date as any).getTime()) / 86_400_000))
        : 0;
      const first = vals[0];
      const last = vals[vals.length - 1];
      const diff = last - first;
      // A DIRECTION IS A TREND CLAIM HERE TOO (#126, 2026-09-02).
      //
      // The history command asked weightTrendUsable after the 16:49 contradiction. This one never
      // did: it computed `last - first` and rendered an arrow, a pace, and a coaching line off it.
      // Traced on current main with weigh-ins spanning a recorded illness, that produced
      //
      //   Start: 95.0kg → Now: 97.4kg (⬆️ Up 2.4kg)
      //   3 weigh-ins over 2 weeks · pace +1.05kg/week
      //   Gaining as planned. If lifts are going up, this is muscle. Keep training hard.
      //
      // while the canonical evidence refuses to call any direction at all.
      //
      // THE OUTBOUND GATE IS NOT A SUBSTITUTE, and the same trace shows why: it classifies claims
      // one SENTENCE at a time, so it caught the header, deleted the weigh-ins with it, and left
      // "this is muscle. Keep training hard." standing — a conclusion carrying the direction with
      // no direction words in it. Deferring the decision to the boundary loses the client's data
      // and keeps the claim. It has to be made here, before the reply is composed.
      const { weightDirectionSpeakable } = await import("../adaptive-targets");
      const speech = await weightDirectionSpeakable(
        (await getWeightTruth(user, { clientMessage: m })).points, user);
      const trend = !speech.speakable ? "" : diff < -0.5 ? `⬇️ Down ${Math.abs(diff).toFixed(1)}kg` : diff > 0.5 ? `⬆️ Up ${diff.toFixed(1)}kg` : `➡️ Stable`;
      // Pace is a direction with a rate attached — strictly more than the arrow, so it is gated by
      // the same answer rather than by its own rule.
      const paceWk = speech.speakable && spanDays >= 7 ? ` · pace ${(diff / (spanDays / 7)) >= 0 ? "+" : ""}${(diff / (spanDays / 7)).toFixed(2)}kg/week` : "";
      // THE NUMBERS ARE NOT THE CLAIM. They asked for their chart, so start, now, the count and the
      // span all still ship when the direction cannot — stated as data, with no word that reads as
      // a direction, which is also what keeps the outbound gate from deleting them.
      const reply = `*⚖️ Weight — ${name}*\n\n` +
        `Start: *${first.toFixed(1)}kg* → Now: *${last.toFixed(1)}kg*${trend ? ` (${trend})` : ""}\n` +
        `${weights.length} weigh-ins over ${spanDays >= 7 ? Math.round(spanDays / 7) + " weeks" : spanDays + " days"}${paceWk}\n\n` +
        (!speech.speakable
          ? (speech.why === "illness"
            ? `I'm not calling a direction off these — they sit around the time you were ill, and weight moves on fluid and appetite then. Weigh in a few clear mornings and I'll read it properly.`
            : `I'm not calling a direction off these yet. Weigh in a few more mornings and I'll give you a straight read.`)
         : diff < -2 ? `Consistent progress. The deficit is working — stay patient and stay on plan.` :
         diff > 2 && user.goalType === "muscle_gain" ? `Gaining as planned. If lifts are going up, this is muscle. Keep training hard.` :
         Math.abs(diff) < 1 ? `Weight holding. Check measurements — you could be recomping (losing fat, gaining muscle). The tape does not lie.` :
         `Keep logging. Trends become clear after 4+ weeks of consistent data.`);

      await logChat(user.id, message, reply, "WEIGHT_TREND");
      return reply;
    } catch (err) {
      console.error("[WEIGHT TREND]", err);
      return `Could not generate weight chart. Try again later.`;
    }
  }

  // ---- SA HOLIDAY MEAL GUIDE — braai, Christmas, Easter, Heritage Day ----
  // Conversational advisory template (no data write) — engine owns it when live.

  return null;
}
