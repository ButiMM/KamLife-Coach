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

// Fitness MYTHS the model absorbed from the broscience-soaked internet and will reach
// for unprompted (2026-07-09: told a client an 8th chest exercise would "confuse that
// focus" — echoing muscle-confusion, a myth — instead of the correct answer, targeted
// volume). Caught in CODE, not left to the prompt, because a prompt line the model can
// ignore is exactly what let this through. Goal-independent — it's just false.
const FITNESS_MYTH_RE =
  /\b(muscle confusion|confus\w+ (?:the |your |that )?(?:muscle|muscles|focus|plan)|shock(?:ing)? (?:the |your )?muscles?|spot[- ]?reduc\w+|muscles? turn\w* (?:in)?to fat|fat turn\w* (?:in)?to muscle)\b/i
;
// …but ALLOW the bot to correctly DEBUNK a myth ("muscle confusion is a myth",
// "you can't spot reduce") — only flag when the myth is being endorsed, not refuted.
const MYTH_DEBUNK_RE =
  /\b(myth|no such thing|not (?:a )?real|isn'?t real|not (?:a )?thing|can'?t|cannot|doesn'?t work|false|nonsense|ignore that)\b/i
;

// PROGRAMME SOVEREIGNTY (2026-07-21 live: asked "where can I improve?", the front-door
// engine freelanced a workout menu — "incorporate exercises like rows and planks… squats
// and lunges" — inventing movements that AREN'T in the client's FIXED machine programme.
// The programme is fixed and delivered deterministically (the *programme* command); a
// conversational reply must NEVER prescribe a menu of exercises. Improving a body part =
// targeted volume + progressive overload on the lifts they ALREADY have, plus the lagging
// muscle from their photo read. The prompt already says this (BRAIN_SYSTEM training
// philosophy) — but a prompt line the model can ignore is exactly what let this through,
// so it is enforced HERE in code. High precision: the giveaway is "exercises like/such as"
// (introducing examples of a category = freelancing) or a prescription verb naming a fresh
// movement. Progressive-overload phrasing ("add 2.5kg", "add a rep/set to your press")
// never matches — those are the CORRECT answer, not a violation.
const PROGRAMME_FREELANCE_RE =
  /\bexercises?\s+(?:like|such as|including)\b|\b(?:incorporate|throw in|mix in|start doing|add in|try (?:doing |adding |some ))\b[^.!?]{0,24}?\b(?:squats?|lunges?|deadlifts?|burpees?|crunches|sit[- ]?ups?|planks?|pull[- ]?ups?|chin[- ]?ups?|dips|mountain climbers?|kettlebell\w*|box jumps?|jumping jacks?|russian twists?|leg raises?|jump squats?|snatch\w*|clean(?:s| and jerks?)?)\b/i
;

export function verifyBrainReply(reply: string, facts: VerifierFacts): VerifierResult {
  const r = reply || "";

  if (FITNESS_MYTH_RE.test(r) && !MYTH_DEBUNK_RE.test(r)) {
    return { ok: false, violation: "Your reply invokes a fitness MYTH (muscle confusion / shocking the muscle / spot reduction / muscle-turns-to-fat). None of these are real — never tell a client to 'confuse' or 'shock' a muscle. Rewrite with the correct principle: progressive overload on the core lifts, and for a lagging body part, TARGETED VOLUME (a couple more sets, or one focused accessory) on that muscle." };
  }

  if (PROGRAMME_FREELANCE_RE.test(r)) {
    return { ok: false, violation: "You prescribed exercises as if writing a workout ('exercises like…', 'incorporate squats and lunges'). The client's programme is FIXED and machine-based — you must NEVER invent, list, or suggest movements in a chat reply. To bring up a body part the answer is ALWAYS: targeted volume + progressive overload on the lifts they ALREADY have (add a rep or 2.5kg), plus the lagging muscle from their photo read in the numbers above — name the SPECIFIC weak part and one concrete number. If they want the actual plan, tell them to send *programme*. Rewrite now with no new exercises." };
  }

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
