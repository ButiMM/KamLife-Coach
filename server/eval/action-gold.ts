/**
 * THE GOLD SET — hand-verified truth for action-correctness (increment 7).
 *
 * WHY THIS EXISTS (the honest version): the history replay scored Coach K against
 * PRODUCTION'S OWN intent labels — a cheap gpt-4o-mini classifier that is itself wrong on
 * the hard cases. It labelled "tell me about my progress" as SET_SICK and then marked Coach
 * K WRONG for not writing a sick record. We were chasing a broken answer key. You cannot
 * gate a go-live decision on a ruler that's bent.
 *
 * This file is the straight ruler: real messages, each labelled with the action a human
 * KNOWS is right, with the reasoning written down so it can be argued with and grown. It is
 * version-controlled, unit-tested, and reviewable. The gate reads THIS, not the classifier.
 *
 * LABELLING PRINCIPLES:
 *  - A fresh transaction the client REPORTS/REQUESTS → its action.
 *  - A question, a plan/intention, a feeling, or general talk → CONVERSATION (JUST_REPLY).
 *  - A complaint or a memory grievance ("why did you forget I'm sick") → CONVERSATION: you
 *    acknowledge, you do NOT re-write state. Re-writing an existing sick record adds nothing
 *    and re-dumps the template — the exact bug we already fixed on the deterministic side.
 *  - A genuine CORRECTION of a value that changes the desired end-state (rest until Monday,
 *    not Friday) IS a write — the goal state changed. Labelled as the write it should be.
 *
 * Pure + dependency-free. Add cases as production surfaces new shapes — this only grows.
 */

import { type ExpectedAction } from "./action-score";

export interface GoldCase {
  message: string;
  expected: ExpectedAction;
  note?: string; // why this label — the argument, so a future edit must beat the reasoning
}

export const ACTION_GOLD: GoldCase[] = [
  // ── FOOD (reported, past tense) → LOG_MEAL ──
  { message: "i had a burger for lunch", expected: "LOG_MEAL" },
  { message: "ate 2 eggs and pap this morning", expected: "LOG_MEAL" },
  { message: "just had chicken and rice", expected: "LOG_MEAL" },
  { message: "had a magwinya and polony for breakfast", expected: "LOG_MEAL" },
  { message: "I ate some chips and a coke", expected: "LOG_MEAL" },

  // ── FOOD that is NOT a log → CONVERSATION ──
  { message: "can I eat rice at night?", expected: "CONVERSATION", note: "a question, not a report" },
  { message: "I'll have chicken later", expected: "CONVERSATION", note: "a plan/intention, hasn't happened" },
  { message: "what should I eat after gym?", expected: "CONVERSATION", note: "advice request" },
  { message: "is pap bad for weight loss?", expected: "CONVERSATION", note: "a myth/question" },

  // ── STEPS / WATER / WEIGHT (reported numbers) → their logs ──
  { message: "I did 9000 steps today", expected: "LOG_STEPS" },
  { message: "walked 12000 steps", expected: "LOG_STEPS" },
  { message: "drank 2 litres of water", expected: "LOG_WATER" },
  { message: "had 3 glasses of water so far", expected: "LOG_WATER" },
  { message: "I'm 82kg this morning", expected: "LOG_WEIGHT" },
  { message: "weighed in at 78.5kg", expected: "LOG_WEIGHT" },
  { message: "how many steps should I aim for?", expected: "CONVERSATION", note: "a target question, not a report" },

  // ── WORKOUT / MEALS lookups → SHOW_* ──
  { message: "show me my workout", expected: "SHOW_WORKOUT" },
  { message: "what's today's session", expected: "SHOW_WORKOUT" },
  { message: "what's my workout for today", expected: "SHOW_WORKOUT" },
  { message: "what did I eat today", expected: "SHOW_MEALS" },
  { message: "show me today's meals", expected: "SHOW_MEALS" },
  { message: "remove my last meal", expected: "REMOVE_LAST_MEAL" },
  { message: "delete that last food log", expected: "REMOVE_LAST_MEAL" },

  // ── SICK: declaration & recovery → the writes ──
  { message: "I'm sick, can't train today", expected: "SET_SICK" },
  { message: "too sick to train, resting for 3 days", expected: "SET_SICK" },
  { message: "I'm not feeling well, need to rest until Monday", expected: "SET_SICK" },
  { message: "I'm back, feeling better", expected: "END_SICK" },
  { message: "feeling better now, ready to train again", expected: "END_SICK" },

  // ── SICK: the overloaded cases the broken ruler got WRONG ──
  { message: "No, I'm resting until Monday, not Friday", expected: "SET_SICK",
    note: "a correction that CHANGES the desired end-state (rest longer) — a legit write, not a false write. The old ruler marked this wrong." },
  { message: "I said I'm still sick until Monday, why did you forget?", expected: "CONVERSATION",
    note: "a memory grievance — acknowledge and confirm, do NOT re-write the sick record or re-dump the template" },
  { message: "But I'm still sick.", expected: "CONVERSATION",
    note: "reaffirmation of an existing state — re-writing adds nothing; acknowledge" },
  { message: "tell me about my progress, my overall progress", expected: "CONVERSATION",
    note: "THE proof the old ruler was broken: it labelled this SET_SICK. It is a progress/talk turn, no state write" },

  // ── PURE CONVERSATION ──
  { message: "why am I not losing weight?", expected: "CONVERSATION" },
  { message: "I feel wrecked today", expected: "CONVERSATION", note: "a feeling — hear it, don't act" },
  { message: "thanks coach, appreciate you", expected: "CONVERSATION" },
  { message: "I'm struggling to stay motivated", expected: "CONVERSATION" },
];
