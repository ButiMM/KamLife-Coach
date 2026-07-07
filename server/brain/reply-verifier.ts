/**
 * REPLY VERIFIER — the self-correcting loop on the brain's mouth.
 *
 * The systemic disease (2026-07-07 goal-flip audit): model output could
 * contradict KNOWN client truth and nothing checked. This verifier runs on
 * every brain reply BEFORE it is sent: deterministic, zero-cost, reads the
 * same stored facts the brain reads. On violation the brain gets ONE
 * self-correction pass with the violation named; if the rewrite still
 * violates, the reply is dropped and the message defers to the deterministic
 * pipeline (fail open, never fail wrong).
 *
 * This is the GENERAL mechanism — the goal-flip, "losing 0.57kg" praise to a
 * gaining client, and "I'll adjust your targets" were all symptoms of its
 * absence. Pure — unit-tested in script/unit-tests.ts.
 */

export interface VerifierFacts {
  goalType?: string | null; // "muscle_gain" | "fat_loss" | "recomposition"
}

export interface VerifierResult {
  ok: boolean;
  violation?: string; // human-readable, also fed back to the model for the rewrite
}

// Claims of actions the brain has NO tool to perform. Saying them = lying.
const FORBIDDEN_ACTION_RE =
  /\bI(?:'?ll| will| am going to| can)\s+(?:adjust|update|change|increase|decrease|recalculate|reset)\s+(?:your\s+)?(?:targets?|goal|calories?|calorie target|protein target|programme|plan|macros)\b/i
;
const CLAIMED_GOAL_CHANGE_RE =
  /\b(?:we(?:'?ll| will| are going to)?\s+(?:shift|switch|move|change)(?:\s+\w+){0,3}\s+to\s+(?:fat loss|muscle gain|cutting|bulking)|your goal is now|I(?:'?ve| have) (?:changed|updated|switched) your goal)\b/i
;

// Direction language that contradicts the stored goal. High-precision patterns
// only — generic words like "loss" alone never match.
const FAT_LOSS_PUSH_RE =
  /\b(?:focus on (?:a )?calorie deficit|let'?s (?:focus on|aim for|target) (?:fat|weight) loss|we(?:'?ll| will)? (?:focus|aim|work) on losing (?:weight|fat)|great (?:progress|work|job)[^.!?]{0,40}\blos(?:ing|t)\b[^.!?]{0,20}\b(?:kg|weight)|keep losing|stay in (?:a|your) deficit)\b/i
;
const SURPLUS_PUSH_RE =
  /\b(?:let'?s (?:focus on|aim for) (?:a )?(?:calorie )?surplus|eat (?:in a|at a) surplus|focus on bulking|let'?s bulk|aim to gain weight|we(?:'?ll| will)? (?:focus|work) on gaining (?:weight|mass|size))\b/i
;

export function verifyBrainReply(reply: string, facts: VerifierFacts): VerifierResult {
  const r = reply || "";

  if (FORBIDDEN_ACTION_RE.test(r)) {
    return { ok: false, violation: "You claimed you will adjust targets/goal/programme — you have NO tool for that. Remove the claim; if they want it changed, tell them to say 'change my goal to …' so the system can confirm it properly." };
  }
  if (CLAIMED_GOAL_CHANGE_RE.test(r)) {
    return { ok: false, violation: "You claimed the client's goal changed or will change. Goals only change through an explicit confirmed request — never from you. Remove the claim." };
  }

  const goal = String(facts.goalType || "").toLowerCase();
  if (goal === "muscle_gain" && FAT_LOSS_PUSH_RE.test(r)) {
    return { ok: false, violation: "This client's goal is MUSCLE GAIN, but your reply pushes fat loss / a deficit / celebrates losing. Rewrite consistent with muscle gain (falling weight is a problem to fix, not progress)." };
  }
  if (goal === "fat_loss" && SURPLUS_PUSH_RE.test(r)) {
    return { ok: false, violation: "This client's goal is FAT LOSS, but your reply pushes a surplus / bulking / gaining. Rewrite consistent with fat loss." };
  }
  // Frame ownership: calling a muscle-gain client's plan "your deficit" (or a
  // fat-loss client's "your surplus") mirrors the client's confusion back at them
  // instead of correcting it (2026-07-07 sick-day reply: "your calorie deficit
  // doesn't matter right now" — to a client on a SURPLUS).
  if (goal === "muscle_gain" && /\byour\s+(?:calorie\s+)?deficit\b/i.test(r)) {
    return { ok: false, violation: "You called it 'your deficit' but this client is on a SURPLUS (muscle gain). Correct the frame kindly instead of mirroring their confusion." };
  }
  if (goal === "fat_loss" && /\byour\s+(?:calorie\s+)?surplus\b/i.test(r)) {
    return { ok: false, violation: "You called it 'your surplus' but this client is on a DEFICIT (fat loss). Correct the frame kindly instead of mirroring their confusion." };
  }

  return { ok: true };
}
