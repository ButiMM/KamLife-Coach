/**
 * Workout difficulty feedback — the Freeletics/Future "how was it?" loop, the lean way.
 *
 * The audit wanted: after a session, capture too easy / good / too hard and adapt.
 * We deliberately AVOID a numbered (1–4) reply + awaitingInputType state machine —
 * "1" already means "show workout" and collides with menu numbers, which is exactly
 * the kind of routing collision that has caused bugs. Instead we match distinct,
 * unambiguous phrases and only treat them as session feedback right after a workout
 * (the caller supplies that recency gate). Pain is NOT handled here — the safety
 * detector catches pain/injury upstream and escalates.
 */

export type WorkoutFeedbackKind = "too_easy" | "just_right" | "too_hard";

const TOO_EASY = /\b(too\s+easy|was\s+easy|felt\s+easy|that\s+was\s+easy|piece\s+of\s+cake|not\s+(?:challenging|hard\s+enough|enough)|need(?:s|ed)?\s+more|too\s+light|way\s+too\s+easy|bored)\b/i;
const TOO_HARD = /\b(too\s+hard|too\s+tough|too\s+difficult|too\s+heavy|too\s+much|so\s+hard|really\s+hard|brutal|killed\s+me|kicked\s+my|couldn.?t\s+finish|could\s+not\s+finish|struggled|wiped\s+me|destroyed\s+me|too\s+intense)\b/i;
const JUST_RIGHT = /\b(just\s+right|just\s+fine|perfect|felt\s+(?:good|great)|good\s+(?:session|workout|one)|spot\s+on|manageable|challenging\s+but|nailed\s+it|just\s+enough)\b/i;

/**
 * Classify a message as workout difficulty feedback, or null if it isn't.
 * too_hard takes precedence over too_easy when both somehow appear ("not too hard"
 * style phrasing is rare; if conflicting, treat as just_right to avoid over-adjusting).
 */
export function classifyWorkoutFeedback(message: string): WorkoutFeedbackKind | null {
  const m = (message || "").toLowerCase();
  const easy = TOO_EASY.test(m);
  const hard = TOO_HARD.test(m);
  const right = JUST_RIGHT.test(m);
  if (easy && !hard) return "too_easy";
  if (hard && !easy) return "too_hard";
  if (right) return "just_right";
  return null;
}

/** Coach K's adaptive reply for each feedback kind. firstName may be empty. */
export function workoutFeedbackReply(kind: WorkoutFeedbackKind, firstName = ""): string {
  const fn = firstName ? `${firstName}, ` : "";
  switch (kind) {
    case "too_easy":
      return `${fn}good — that means your body has adapted. Next session, add load: *+2.5kg* on each lift, or *+1–2 reps* if you can't add weight. Still easy after that? We add a set. Progressive overload is the whole game.`;
    case "too_hard":
      return `${fn}noted — we scale it. Next session: drop the weight *10–20%* and focus on clean form and full reps. Nailing 3×10 lighter beats failing 3×6 too heavy. It gets easier fast — your body adapts in 2–3 sessions.`;
    case "just_right":
      return `${fn}perfect — that's exactly the zone we want: hard but doable. Keep these weights next session, then push *+1 rep* the moment it starts feeling easy. That's how you progress without burning out.`;
  }
}
