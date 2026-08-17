/**
 * REPLY VERIFIER — the self-correcting loop on the brain's mouth.
 *
 * Deterministic, zero-cost checks on every freeform Coach K reply. The verifier owns the
 * policy surface so the engine can self-correct once and fail open rather than sending a
 * reply already known to be wrong.
 */

import { currentRuntimeDecision } from "../understanding/state";
import { decisionBoundaryViolation } from "../understanding/decision-boundary";

export interface VerifierFacts {
  goalType?: string | null;
  clientMessage?: string | null;
}

export interface VerifierResult {
  ok: boolean;
  violation?: string;
}

function normaliseStepToken(word: string): string {
  return word
    .replaceAll(",", "")
    .replaceAll(".", "")
    .replaceAll(":", "")
    .replaceAll(";", "")
    .replaceAll("!", "")
    .replaceAll("?", "")
    .replaceAll("(", "")
    .replaceAll(")", "")
    .replaceAll("\"", "")
    .replaceAll("'", "")
    .trim();
}

function stepWords(text: string): string[] {
  return (text || "").toLowerCase().split(" ").map(normaliseStepToken).filter(Boolean);
}

function isStepWord(word: string): boolean {
  return word === "step" || word === "steps" || word === "walk" || word === "walked" || word === "walking";
}

function extractStepNumbers(text: string): number[] {
  const words = stepWords(text);
  const out: number[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (isStepWord(word)) {
      const next = Number(words[i + 1]?.replaceAll(",", ""));
      if (Number.isFinite(next)) out.push(next);
      continue;
    }
    const number = Number(word.replaceAll(",", ""));
    if (Number.isFinite(number) && isStepWord(words[i + 1] || "")) out.push(number);
  }
  return [...new Set(out)];
}

function isExplicitStepQuery(text: string): boolean {
  const q = (text || "").toLowerCase();
  return q.includes("how many steps")
    || q.includes("what are my steps")
    || q.includes("what's my step count")
    || q.includes("what is my step count")
    || q.includes("my steps")
    || q.includes("step progress")
    || q.includes("step total");
}

function verifyStepAttribution(reply: string, clientMessage: string): VerifierResult {
  const replySteps = extractStepNumbers(reply);
  if (replySteps.length === 0) return { ok: true };
  if (isExplicitStepQuery(clientMessage)) return { ok: true };
  const reported = extractStepNumbers(clientMessage);
  if (reported.length === 0) {
    return { ok: false, violation: "Your reply attributes a step/walking number to the client, but their current message did not report a step count. Stored snapshot state is not a current-turn client statement. Do not say they walked or did a number of steps unless they reported it in this message; if they asked about progress, that is a different case and you may answer from state." };
  }
  if (replySteps.some(n => !reported.includes(n))) {
    return { ok: false, violation: "Your reply attributes a step count that is not one of the numbers the client reported in this message. Do not substitute a stored/context step value for the client's own current-turn number." };
  }
  return { ok: true };
}

/**
 * The verifier is the single policy owner. The individual checks stay next to each other so
 * each failure retains its precise rewrite instruction, while no separate pattern list/file
 * can silently become another meaning engine. The inline regexes are intentionally not exported
 * or named: they are implementation details of this owner.
 */
export function verifyBrainReply(reply: string, facts: VerifierFacts): VerifierResult {
  const r = reply || "";

  const decision = currentRuntimeDecision();
  if (decision) {
    const violation = decisionBoundaryViolation(r, decision);
    if (violation) return { ok: false, violation };
  }

  if (/\b(?:cure|reverse|heal|get rid of|eliminate|fix)\s+(?:your\s+|the\s+|his\s+|her\s+)?(?:diabetes|diabetic|hypertension|high blood pressure|blood pressure|cholesterol|pcos|thyroid|arthritis|ibs|cancer|condition|illness|disease|diagnosis)\b/i.test(r)) {
    return { ok: false, violation: "Your reply claims to cure/reverse/heal a medical CONDITION. KamLife is a wellness coach, NOT a doctor or medical device — this is a compliance and liability breach and must NEVER be said. Rewrite: coach the healthy HABITS (movement, food, sleep, consistency) that support how they feel, and for anything about the condition itself defer to their doctor ('I'm your coach, not your doctor — your doctor guides the condition, I'll help you build the habits around it'). Never promise to cure, reverse or fix a disease." };
  }
  if (/\b(?:take|takes|taking|swallow|have)\s+(?:your |his |her |the |their )?(?:[a-z][\w-]*\s+){0,2}?(?:insulin|medication|meds|medicine|dose|doses|dosage|tablets?|pills?|metformin|statins?|arvs?|antiretrovirals?|treatment|prescription)\b[^.!?]{0,40}\b(?:with food|on an empty stomach|before (?:bed|meals?|eating|breakfast)|after (?:meals?|eating|breakfast|supper)|at night|in the morning|with (?:a )?meal|first thing)\b/i.test(r)) {
    return { ok: false, violation: "Your reply instructs the client on HOW or WHEN to take medication (with food, on an empty stomach, at night, before bed). That is a pharmacist's or doctor's job and never a coach's — remove it entirely. Say that the timing of their medicine is a question for their doctor or pharmacist, and coach only what you actually coach: the food, the training, the sleep, the consistency." };
  }
  if (/\b(?:stop|start|adjust|change|increase|reduce|lower|skip|come off|go off|wean off|double|halve|cut)\s+(?:your |his |her |the |taking )?(?:[a-z][\w-]*\s+){0,3}?(?:insulin|medication|meds|medicine|dose|dosage|tablets|pills|metformin|statins?|treatment|prescription)\b/i.test(r)) {
    return { ok: false, violation: "Your reply directs a change to the client's MEDICATION (stopping / adjusting / skipping a dose). You must NEVER touch medication — it is dangerous and outside a coach's scope. Rewrite: tell them only their doctor decides anything about their medication, and steer back to the habits you DO coach (food, movement, sleep). Remove any instruction about medicine, insulin or dose." };
  }
  if (/\b(muscle confusion|confus\w+ (?:the |your |that )?(?:muscle|muscles|focus|plan)|shock(?:ing)? (?:the |your )?muscles?|spot[- ]?reduc\w+|muscles? turn\w* (?:in)?to fat|fat turn\w* (?:in)?to muscle)\b/i.test(r)
      && !/\b(myth|no such thing|not (?:a )?real|isn'?t real|not (?:a )?thing|can'?t|cannot|doesn'?t work|false|nonsense|ignore that)\b/i.test(r)) {
    return { ok: false, violation: "Your reply invokes a fitness MYTH (muscle confusion / shocking the muscle / spot reduction / muscle-turns-to-fat). None of these are real — never tell a client to 'confuse' or 'shock' a muscle. Rewrite with the correct principle: progressive overload on the core lifts, and for a lagging body part, TARGETED VOLUME (a couple more sets, or one focused accessory) on that muscle." };
  }
  if (/\bexercises?\s+(?:like|such as|including)\b|\b(?:incorporate|throw in|mix in|start doing|add in|try (?:doing |adding |some ))\b[^.!?]{0,24}?\b(?:squats?|lunges?|deadlifts?|burpees?|crunches|sit[- ]?ups?|planks?|pull[- ]?ups?|chin[- ]?ups?|dips|mountain climbers?|kettlebell\w*|box jumps?|jumping jacks?|russian twists?|leg raises?|jump squats?|snatch\w*|clean(?:s| and jerks?)?)\b/i.test(r)) {
    return { ok: false, violation: "You prescribed exercises as if writing a workout ('exercises like…', 'incorporate squats and lunges'). The client's programme is FIXED and machine-based — you must NEVER invent, list, or suggest movements in a chat reply. To bring up a body part the answer is ALWAYS: targeted volume + progressive overload on the lifts they ALREADY have (add a rep or 2.5kg), plus the lagging muscle from their photo read in the numbers above — name the SPECIFIC weak part and one concrete number. If they want the actual plan, tell them to send *programme*. Rewrite now with no new exercises." };
  }
  if (/\bI(?:'?ll| will| am going to| can)\s+(?:adjust|update|change|increase|decrease|recalculate|reset)\s+(?:your\s+)?(?:targets?|goal|calories?|calorie target|protein target|programme|plan|macros)\b/i.test(r)
      || /\b(?:we(?:'?ll| will| are going to)?\s+(?:shift|switch|move|change)(?:\s+\w+){0,3}\s+to\s+(?:fat loss|muscle gain|cutting|bulking)|your goal is now|I(?:'?ve| have) (?:changed|updated|switched) your goal)\b/i.test(r)) {
    return { ok: false, violation: "You claimed the client's targets/goal/programme will change, but you have NO tool for that. Remove the claim; if they want it changed, tell them to say 'change my goal to …' so the system can confirm it properly." };
  }

  const stepAttribution = verifyStepAttribution(r, facts.clientMessage || "");
  if (!stepAttribution.ok) return stepAttribution;

  const goal = String(facts.goalType || "").toLowerCase();
  if (goal === "muscle_gain" && /\b(?:focus on (?:a )?calorie deficit|let'?s (?:focus on|aim for|target) (?:fat|weight) loss|we(?:'?ll| will)? (?:focus|aim|work) on losing (?:weight|fat)|great (?:progress|work|job)[^.!?]{0,40}\blos(?:ing|t)\b[^.!?]{0,20}\b(?:kg|weight)|keep losing|stay in (?:a|your) deficit)\b/i.test(r)) {
    return { ok: false, violation: "This client's goal is MUSCLE GAIN, but your reply pushes fat loss / a deficit / celebrates losing. Rewrite consistent with muscle gain (falling weight is a problem to fix, not progress)." };
  }
  if (goal === "fat_loss" && /\b(?:let'?s (?:focus on|aim for) (?:a )?(?:calorie )?surplus|eat (?:in a|at a) surplus|focus on bulking|let'?s bulk|aim to gain weight|we(?:'?ll| will)? (?:focus|work) on gaining (?:weight|mass|size))\b/i.test(r)) {
    return { ok: false, violation: "This client's goal is FAT LOSS, but your reply pushes a surplus / bulking / gaining. Rewrite consistent with fat loss." };
  }
  if (goal === "muscle_gain" && /\byour\s+(?:calorie\s+)?deficit\b/i.test(r)) return { ok: false, violation: "You called it 'your deficit' but this client is on a SURPLUS (muscle gain). Correct the frame kindly instead of mirroring their confusion." };
  if (goal === "fat_loss" && /\byour\s+(?:calorie\s+)?surplus\b/i.test(r)) return { ok: false, violation: "You called it 'your surplus' but this client is on a DEFICIT (fat loss). Correct the frame kindly instead of mirroring their confusion." };

  return { ok: true };
}
