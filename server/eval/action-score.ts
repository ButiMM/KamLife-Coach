/**
 * ACTION-CORRECTNESS SCORING — the pure heart of the action replay (increment 5).
 *
 * Kept dependency-free (only a TYPE from actions.ts) so it is fully unit-testable and
 * safe to import anywhere — the live runner (action-replay.ts) pulls the DB/engine chain,
 * this file never does. The scorer is what decides a "winning day", so it has to be the
 * part we can prove correct in the test harness without booting the app.
 */

import { type CoachActionType } from "../understanding/actions";

export type ExpectedAction = CoachActionType | "CONVERSATION";

// Production intent → the action the inversion SHOULD emit. Ordered, first match wins.
const INTENT_MAP: Array<[RegExp, CoachActionType]> = [
  [/\bFOOD_LOG\b/i, "LOG_MEAL"],
  [/STEP/i, "LOG_STEPS"],
  [/WATER/i, "LOG_WATER"],
  [/WEIGHT/i, "LOG_WEIGHT"],
  [/SICK_RECOVER|SICK_BACK/i, "END_SICK"],
  [/SICK/i, "SET_SICK"],
  [/WORKOUT_VIEW|WORKOUT_MISSED|WORKOUT_HOLIDAY|PROGRAMME_VIEW/i, "SHOW_WORKOUT"],
  [/REMOVE|FOOD_LOG_CORRECTED/i, "REMOVE_LAST_MEAL"],
  [/MEAL_LIST|MY_MEALS|SHOW_MEALS/i, "SHOW_MEALS"],
];
// Intents that are genuinely conversation — the engine should JUST_REPLY.
const CONVERSATION_RE = /GPT|ENGINE_LIVE|MINDSET|MISC|MOTIVAT|QUESTION|EMOTION|FRUSTRATION|EDUCATION|DOMAIN|BRAIN|COACH_|SUPPORT|EXPLAINER/i;

/** Ground-truth expected action for a production intent, or null when it's ambiguous
 *  (don't score what we can't judge confidently — that would only add noise). */
export function expectedActionForIntent(intent: string | null): ExpectedAction | null {
  const i = intent || "";
  for (const [re, act] of INTENT_MAP) if (re.test(i)) return act;
  if (CONVERSATION_RE.test(i)) return "CONVERSATION";
  return null;
}

export interface ActionReplayPair { expected: ExpectedAction; emitted: CoachActionType; message: string }

export interface ActionScore {
  n: number;
  correct: number;
  matchRate: number;
  missedActions: number;   // expected an action → emitted JUST_REPLY (JUST_REPLY-as-template)
  wrongActions: number;    // expected action A → emitted action B
  falseActions: number;    // expected conversation → emitted a state-write (dangerous)
  missRate: number;
  falseRate: number;
  passed: boolean;
  samples: string[];
}

const STATE_WRITES = new Set<CoachActionType>(["LOG_MEAL", "LOG_STEPS", "LOG_WATER", "LOG_WEIGHT", "REMOVE_LAST_MEAL", "SET_SICK", "END_SICK"]);

/** Pure scorer. WIN = ≥90% match, ≤2% false writes (the dangerous kind), ≤10% missed. */
export function scoreActionReplay(results: ActionReplayPair[]): ActionScore {
  let correct = 0, missed = 0, wrong = 0, falseA = 0;
  const samples: string[] = [];
  for (const r of results) {
    const snip = r.message.replace(/\s+/g, " ").slice(0, 50);
    if (r.expected === "CONVERSATION") {
      if (r.emitted === "JUST_REPLY") correct++;
      else if (STATE_WRITES.has(r.emitted)) { falseA++; samples.push(`FALSE-WRITE: "${snip}" → ${r.emitted} (should be reply)`); }
      else correct++; // a read-only action (show meals) on a chat turn is harmless
    } else {
      if (r.emitted === r.expected) correct++;
      else if (r.emitted === "JUST_REPLY") { missed++; samples.push(`MISSED: "${snip}" → JUST_REPLY (expected ${r.expected})`); }
      else { wrong++; samples.push(`WRONG: "${snip}" → ${r.emitted} (expected ${r.expected})`); }
    }
  }
  const n = results.length;
  const matchRate = n ? correct / n : 0;
  const missRate = n ? missed / n : 0;
  const falseRate = n ? falseA / n : 0;
  const passed = n >= 20 && matchRate >= 0.9 && falseRate <= 0.02 && missRate <= 0.1;
  return { n, correct, matchRate, missedActions: missed, wrongActions: wrong, falseActions: falseA, missRate, falseRate, passed, samples: samples.slice(0, 12) };
}
