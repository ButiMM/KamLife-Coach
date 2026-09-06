/**
 * THE CANONICAL NEXT MOVE, FOR PROACTIVE SENDERS (2026-08-25, P0-4b).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACES
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured on main@d005081: eleven of fourteen sending files ran their own action ladder. Not a
 * wording variant — a second decision engine, several of them, each with its own thresholds:
 *
 *   evening.ts   score = food + workout + steps, then a seven-branch cascade ending in
 *                "get to 120g tonight" / "training day and the session is still not done"
 *   weekly.ts    `warning` (zero sessions → train; junk ≥ 3 → fix the source; no-protein days
 *                ≥ 3 → "Tonight: pilchards") and `focus` (train N more / protein every meal /
 *                log your steps / maintain), chosen by its own if-else
 *   programme.ts plateau ladder: cut carbs a third → add 2,000 steps → hold the carbs
 *
 * Every one of them decided from the LEDGER alone, so none could know what the client had said
 * that day, and all of them could disagree with the morning brief that went out eleven hours
 * earlier from `chooseAction`.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS NOT
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Not a new decision engine, not a router, not a second opinion. It is the assembly the morning
 * job already performs — canonical state → held constraints → decideProactive → formatOneAction —
 * lifted out of that one job so the other senders can reach the SAME decision instead of writing
 * their own. If this file ever contains an `if` about protein, steps or sessions, it has become
 * the twelfth ladder and should be deleted.
 *
 * Recognition, reports and questions do not come through here. A sender that only tells the
 * client what happened, or asks them something, has no behavioural instruction to source — see
 * proactive-registry.ts, where that is stated per job rather than left to be inferred.
 */

import { chooseAction, decideProactive, formatOneAction, underPolicy, type OneAction } from "../one-action";
import { readHeldConstraints, NO_CONSTRAINTS, type HeldConstraints } from "../held-constraints";
import { loadProactiveState } from "./shared";
import { foodConstraints } from "../food-swaps";

export interface CanonicalMove {
  /** Ready to place in a message. "" when the decision is `hold` — nothing to add is an answer. */
  line: string;
  action: OneAction;
  /** CONTINUE / CHANGE / INVESTIGATE / REFER, the shared verdict vocabulary. */
  state: "CONTINUE" | "CHANGE" | "INVESTIGATE" | "REFER";
  held: HeldConstraints;
  /** True when the ledger read failed and the degraded contract was applied instead. */
  degraded: boolean;
}

function profileOf(client: any) {
  return {
    dreamGoal: client.dreamGoal,
    biggestStruggle: client.biggestStruggle,
    lifeContext: client.lifeContext,
    doNotMention: client.doNotMention,
    constraints: foodConstraints(client || {}),
    weeksOnProgramme: Math.max(0, (client.programmeWeek || 1) - 1),
    sessionsTarget: Number(client.trainingDaysPerWeek) || 3,
    calorieTarget: Number(client.calorieTarget) || 0,
    proteinTarget: Number(client.proteinTarget) || 0,
    stepsTarget: Number(client.stepsTarget) || 0,
  };
}

/**
 * The one behavioural instruction this client should hear right now.
 *
 * Fails soft, and the fallback is still the ladder — the same degradation morning has applied
 * since Cut 6. A ledger timeout must not produce silence, and it must not produce a hand-written
 * sentence either; it produces the same decision from the facts we still hold, under the same
 * policy boundary (no evidence, no prescription).
 */
export async function canonicalNextMove(
  client: any,
  opts?: { hour?: number },
): Promise<CanonicalMove> {
  const firstName = String(client.name || "").split(" ")[0] || undefined;
  const profile = profileOf(client);
  const held = await readHeldConstraints(client.phoneNumber, client).catch(() => NO_CONSTRAINTS);

  try {
    const state = await loadProactiveState(client);
    const decision = decideProactive(state, profile, {
      hour: opts?.hour,
      foodDayClosed: held.foodDayClosed,
      trainingDeclined: held.trainingDeclined,
    });
    console.log(`[PROACTIVE_DECISION] ${String(client.id || "").slice(-6)} decision=${decision.state} action=${decision.action.kind} foodClosed=${held.foodDayClosed} trainingDeclined=${held.trainingDeclined}`);
    return {
      line: decision.action.kind === "hold" ? "" : formatOneAction(decision.action, firstName),
      action: decision.action,
      state: decision.state,
      held,
      degraded: false,
    };
  } catch (e: any) {
    console.warn(`[PROACTIVE_DECISION] state unavailable for ${String(client.id || "").slice(-6)}: ${e?.message || e}`);
    // We cannot build a ProactiveState — that is what just failed — so the evidence gate cannot
    // run. Apply its contract directly: an unevidenced prescription is downgraded, never sent.
    const action = underPolicy(chooseAction({
      firstName,
      goal: (client.goalType as any) || "general",
      dreamGoal: client.dreamGoal,
      biggestStruggle: client.biggestStruggle,
      lifeContext: client.lifeContext,
      doNotMention: client.doNotMention,
      constraints: foodConstraints(client || {}),
      weeksOnProgramme: profile.weeksOnProgramme,
      daysSinceAnyLog: 0, daysSinceWeighIn: 0, loggedToday: false,
      proteinPct: 1, caloriePct: 1,
      sessionsThisWeek: 0, sessionsTarget: 0,
      stepsToday: 0, stepsTarget: 0,
      sick: held.sick,
      hour: opts?.hour ?? 12,
      foodDayClosed: held.foodDayClosed,
      trainingDeclined: held.trainingDeclined,
    }), { foodSufficient: false, weightSufficient: false, dreamGoal: client.dreamGoal });
    return {
      line: action.kind === "hold" ? "" : formatOneAction(action, firstName),
      action,
      state: action.kind === "hold" ? "CONTINUE" : "INVESTIGATE",
      held,
      degraded: true,
    };
  }
}

/**
 * ── THE REGISTER ──────────────────────────────────────────────────────────────────────────
 *
 * WHAT EVERY PROACTIVE SENDER IS ALLOWED TO SAY (2026-08-25, P0-4b).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE ACCEPTANCE CONDITION THIS FILE ANSWERS
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 *   "Every proactive behavioural instruction either comes from chooseAction, or the sender is
 *    explicitly classified as recognition-only."
 *
 * EXPLICITLY is the operative word. Before this file, the answer for any given cron was "read the
 * four hundred lines and find out" — which is why eleven senders grew their own action ladder
 * without anyone deciding they should. The classification is a product decision, so it is written
 * down as one, per job, with the reason.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE CLASSES
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 *   CANONICAL      Carries a next-move behavioural instruction, and sources it from
 *                  canonicalNextMove() → decideProactive → chooseAction. One coach.
 *
 *   RECOGNITION    Recognition, a report of what happened, or a question. No behavioural
 *                  instruction at all. This is a real and honourable class — a coach who ends
 *                  every message with a task teaches you that you can never be doing well.
 *
 *   RESOURCE       Delivers a scheduled artefact whose content IS the message: a shopping list,
 *                  a meal plan, a measurement prompt, a programme session. The artefact has its
 *                  own owner; this is not a daily next-move decision and routing it through
 *                  chooseAction would replace a meal plan with "eat more protein".
 *
 *   OPERATIONAL    Account, billing, trial, system. "Reply PAY to renew" is a transaction, not
 *                  coaching, and the decision owner has nothing to say about it.
 *
 *   LEGACY_LOCAL   Carries a behavioural instruction that is STILL decided locally. Named, not
 *                  hidden. Every one of these is a defect with a date on it; the count is a
 *                  budget in script/check-architecture.ts that may only go down.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHY LEGACY_LOCAL EXISTS RATHER THAN A CLAIM THAT THE MIGRATION IS FINISHED
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Thirty-two sends across eleven files were making their own decisions. Migrating all of them in
 * one commit is the "rewrite proactive" that was explicitly ruled out, and a registry that called
 * them all CANONICAL because a migration is planned would be the same false claim this whole cut
 * exists to stop. So the two daily coaching ladders are migrated now, the rest are named, and the
 * NON-CONTRADICTION rule at the outbound door (outbound-authority.ts rule 2) already binds every
 * sender in this table — migrated or not — from today.
 *
 * A LEGACY_LOCAL sender is not free to say anything. It is free to be wrong about WHICH useful
 * thing to say. It is not free to contradict what the client already told us.
 */
export type ProactiveClass = "CANONICAL" | "RECOGNITION" | "RESOURCE" | "OPERATIONAL" | "LEGACY_LOCAL";

export interface ProactiveSender {
  /** Exported job function name. */
  job: string;
  /** File under server/scheduler/jobs/, without the extension. */
  file: string;
  cls: ProactiveClass;
  /** Why this class, in one line. Not decoration — the next person changes it against this. */
  because: string;
}

export const PROACTIVE_SENDERS: readonly ProactiveSender[] = [
  // ── morning.ts ────────────────────────────────────────────────────────────────────────────
  { job: "runMorningCheckin", file: "morning", cls: "CANONICAL",
    because: "The brief's only instruction is decisionLine, from decideProactive; composeMorning strips directives out of the recognition prose." },

  // ── evening.ts ────────────────────────────────────────────────────────────────────────────
  { job: "runEveningAccountability", file: "evening", cls: "CANONICAL",
    because: "Migrated 2026-08-25. The score cascade and dinner ladder are gone; recognition of the day stays, the instruction comes from canonicalNextMove." },

  // ── weekly.ts ─────────────────────────────────────────────────────────────────────────────
  { job: "runFridayWeekendStrategy", file: "weekly", cls: "CANONICAL",
    because: "Migrated 2026-08-25. The week's numbers are a report; the weekend instruction is the canonical move." },
  { job: "runSundayWeeklyReport", file: "weekly", cls: "CANONICAL",
    because: "Migrated 2026-08-25. Report card and score are recognition; `warning` and `focus` were two local ladders and are now one canonical move." },
  { job: "runWeekendFoodAudit", file: "weekly", cls: "CANONICAL",
    because: "Migrated 2026-08-25. The weekday/weekend pattern is a genuine observation; the rule that followed it was a local prescription." },
  { job: "runSundayEveningCheckin", file: "weekly", cls: "RECOGNITION",
    because: "Every branch ends in a question about their week. It asks; it never instructs." },
  { job: "runNsvCheckin", file: "weekly", cls: "RECOGNITION",
    because: "Four non-scale-victory prompts, all questions. The point is that it asks for nothing." },
  { job: "runSundayMealPlan", file: "weekly", cls: "RESOURCE",
    because: "Delivers generateMealPlan's artefact. The plan is the message." },

  // ── monday.ts ─────────────────────────────────────────────────────────────────────────────
  { job: "runMondayProgress", file: "monday", cls: "RECOGNITION",
    because: "A progress report against the record." },
  { job: "runMondayGroceries", file: "monday", cls: "RESOURCE",
    because: "Delivers the shopping list artefact." },
  { job: "runWeightReminder", file: "monday", cls: "RESOURCE",
    because: "Adjudicated 2026-09-05 (#180). A measurement prompt on a fixed weekly ritual — the class this doctrine already names, and the same reading as runMonthlyMeasurements. It reads no client state to pick WHAT to say, honours do_not_mention by standing down entirely, and asks for the number the scale gives. It duplicates chooseAction's `weigh` rung in the sense that both may ask; it cannot contradict it, because neither can tell the client to do anything else." },
  { job: "runDietBreakCheck", file: "monday", cls: "OPERATIONAL",
    because: "Adjudicated 2026-09-05 (#180). 'Log your food today' — the one locally-chosen instruction — is deleted. What remains announces a target change the adaptive-targets owner made, which is runAutoCalAdjust's reading exactly: the change is the message." },

  // ── programme.ts ──────────────────────────────────────────────────────────────────────────
  { job: "runPhaseAdvancement", file: "programme", cls: "RESOURCE",
    because: "Announces a programme phase change and offers the session. The programme is the artefact." },
  { job: "runGoalCheck", file: "programme", cls: "RECOGNITION",
    because: "Checkpoint questions about the goal, plus a Week 9 choice. It asks." },
  { job: "runInjuryFollowup", file: "programme", cls: "RECOGNITION",
    because: "Asks how the injury is; adjusts only on the answer." },
  { job: "runWeeklyMondayCheckin", file: "programme", cls: "CANONICAL",
    because: "Migrated 2026-09-05 (#180). What each programme week FEELS like is real phase knowledge no daily decision can produce, and it stays. Every instruction that followed it is gone — including the weigh-in demand it prepended off its own weight_logs read, a third opinion beside runWeightReminder and chooseAction's `weigh` rung. The move now comes from canonicalNextMove." },
  { job: "runPlateauDetection", file: "programme", cls: "LEGACY_LOCAL",
    because: "Adjudicated 2026-09-05 (#180) and DELIBERATELY LEFT. It is the one of the six that is not a daily next-move decision wearing a schedule: it is a multi-week experiment — change one lever, stamp a baseline, verify against a weigh-in seven days later, iterate or stop. canonicalNextMove answers 'what is the one thing today', which cannot express 'we changed carbs last week, so this week we change steps instead'. Converging it would delete a capability, not remove a duplicate authority. It waits on the pace owner (P0-7), and it is the LAST one." },

  // ── business.ts ───────────────────────────────────────────────────────────────────────────
  { job: "runSubscriptionExpiryCheck", file: "business", cls: "OPERATIONAL", because: "Billing." },
  { job: "runPaymentFailureRecovery", file: "business", cls: "OPERATIONAL", because: "Billing." },
  { job: "runSignupNudge", file: "business", cls: "OPERATIONAL", because: "Pre-subscription funnel; there is no client state to decide from." },
  { job: "runWeeklyKpiReport", file: "business", cls: "OPERATIONAL", because: "Goes to the founder, not to a client." },
  { job: "runMonthlyNps", file: "business", cls: "OPERATIONAL", because: "One survey question." },
  { job: "runStepLeaderboard", file: "business", cls: "RECOGNITION", because: "Standings and a rank. No instruction." },
  { job: "runAutoCalAdjust", file: "business", cls: "OPERATIONAL",
    because: "Announces a target change the adaptive-targets owner made. The change is the message." },
  { job: "runStepTargetAdaptation", file: "business", cls: "OPERATIONAL",
    because: "Announces a step-target change made by targets.ts. Same reason." },
  { job: "runMonthEndBudget", file: "business", cls: "RESOURCE",
    because: "A costed shopping plan for the month-end squeeze. The list is the message." },
  { job: "runPaydayShoppingNudge", file: "business", cls: "RESOURCE",
    because: "A costed buy-list keyed to the pay cycle, pointing at the shopping-list owner." },
  { job: "runSupplementReminder", file: "business", cls: "RECOGNITION",
    because: "Adjudicated 2026-09-05 (#180). It asks — 'creatine taken yet?' — about a supplement the CLIENT chose and logged. It decides nothing from their day and prescribes nothing; a question about their own routine is the class this doctrine calls recognition." },

  // ── onboarding.ts ─────────────────────────────────────────────────────────────────────────
  { job: "runEarlyOnboarding", file: "onboarding", cls: "RESOURCE",
    because: "The seven-day welcome sequence. It teaches the product's surface — what to reply, what it can do — on a fixed calendar; it is not a decision about their day." },
  { job: "runMonthlyMeasurements", file: "onboarding", cls: "RESOURCE", because: "The measurement prompt artefact." },
  { job: "runReferralNudge", file: "onboarding", cls: "OPERATIONAL", because: "Growth ask." },
  { job: "runGoalReassessment", file: "onboarding", cls: "RECOGNITION",
    because: "Asks whether the stated goal still matches what they are chasing." },
  { job: "runStepSyncCatchup", file: "onboarding", cls: "RESOURCE",
    because: "Adjudicated 2026-09-05 (#180). Read the message rather than the job name: it lists the three ways to get steps into the product — type a number, send a screenshot, reply 'connect steps'. It teaches the product's surface, which is runEarlyOnboarding's reading, and never tells anyone to walk." },

  // ── trial.ts / reminders.ts / narrative.ts / media-recovery.ts / spend-watchdog.ts ─────────
  { job: "runTrialCountdown", file: "trial", cls: "OPERATIONAL", because: "Trial expiry and conversion." },
  { job: "runSpendWatchdog", file: "spend-watchdog", cls: "OPERATIONAL", because: "Cost alert to the founder." },
  { job: "runMediaJobRecovery", file: "media-recovery", cls: "OPERATIONAL",
    because: "Apologises for a failed media job and asks for a resend. A system apology, not coaching." },
  { job: "runMonthlyNarrative", file: "narrative", cls: "RECOGNITION",
    because: "The month told back to them as a story." },
  { job: "runDueReminders", file: "reminders", cls: "RESOURCE",
    because: "Replays a reminder the CLIENT set, in their own words. Ours to deliver, not to re-decide." },
] as const;
