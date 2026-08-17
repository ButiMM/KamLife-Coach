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
 */

export interface VerifierFacts {
  goalType?: string | null;
  clientMessage?: string | null;
}

export interface VerifierResult {
  ok: boolean;
  violation?: string;
}

/**
 * One policy owner for reply-level claims. The meaning of a match is classified from the
 * matched phrase below; keeping one owner is deliberate so the architecture governor does
 * not permit ten independently growing policy lists.
 */
const POLICY_BREACH_RE = /\b(?:I(?:'?ll| will| am going to| can)\s+(?:adjust|update|change|increase|decrease|recalculate|reset)\s+(?:your\s+)?(?:targets?|goal|calories?|calorie target|protein target|programme|plan|macros)|we(?:'?ll| will| are going to)?\s+(?:shift|switch|move|change)(?:\s+\w+){0,3}\s+to\s+(?:fat loss|muscle gain|cutting|bulking)|your goal is now|I(?:'?ve| have) (?:changed|updated|switched) your goal|focus on (?:a )?calorie deficit|let'?s (?:focus on|aim for|target) (?:fat|weight) loss|we(?:'?ll| will)? (?:focus|aim|work) on losing (?:weight|fat)|great (?:progress|work|job)[^.!?]{0,40}\blos(?:ing|t)\b[^.!?]{0,20}\b(?:kg|weight)|keep losing|stay in (?:a|your) deficit|let'?s (?:focus on|aim for) (?:a )?(?:calorie )?surplus|eat (?:in a|at a) surplus|focus on bulking|let'?s bulk|aim to gain weight|we(?:'?ll| will)? (?:focus|work) on gaining (?:weight|mass|size)|muscle confusion|confus\w+ (?:the |your |that )?(?:muscle|muscles|focus|plan)|shock(?:ing)? (?:the |your )?muscles?|spot[- ]?reduc\w+|muscles? turn\w* (?:in)?to fat|fat turn\w* (?:in)?to muscle|exercises?\s+(?:like|such as|including)|(?:incorporate|throw in|mix in|start doing|add in|try (?:doing |adding |some ))[^.!?]{0,24}?(?:squats?|lunges?|deadlifts?|burpees?|crunches|sit[- ]?ups?|planks?|pull[- ]?ups?|chin[- ]?ups?|dips|mountain climbers?|kettlebell\w*|box jumps?|jumping jacks?|russian twists?|leg raises?|jump squats?|snatch\w*|clean(?:s| and jerks?)?)|(?:cure|reverse|heal|get rid of|eliminate|fix)\s+(?:your\s+|the\s+|his\s+|her\s+)?(?:diabetes|diabetic|hypertension|high blood pressure|blood pressure|cholesterol|pcos|thyroid|arthritis|ibs|cancer|condition|illness|disease|diagnosis)|(?:take|takes|taking|swallow|have)\s+(?:your |his |her |the |their )?(?:[a-z][\w-]*\s+){0,2}?(?:insulin|medication|meds|medicine|dose|doses|dosage|tablets?|pills?|metformin|statins?|arvs?|antiretrovirals?|treatment|prescription)\b[^.!?]{0,40}\b(?:with food|on an empty stomach|before (?:bed|meals?|eating|breakfast)|after (?:meals?|eating|breakfast|supper)|at night|in the morning|with (?:a )?meal|first thing)|(?:stop|start|adjust|change|increase|reduce|lower|skip|come off|go off|wean off|double|halve|cut)\s+(?:your |his |her |the |taking )?(?:[a-z][\w-]*\s+){0,3}?(?:insulin|medication|meds|medicine|dose|dosage|tablets|pills|metformin|statins?|treatment|prescription))\b/i;

const MYTH_DEBUNK_PHRASES = ["myth", "no such thing", "not a real", "isn't real", "not real", "not a thing", "can't", "cannot", "doesn't work", "false", "nonsense", "ignore that"];

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

function policyViolation(reply: string, hit: string, goal: string): string | null {
  const lower = hit.toLowerCase();
  if (lower.includes("muscle confusion") || lower.includes("shock") || lower.includes("spot") || lower.includes("turn") || lower.includes("confus")) {
    const replyLower = reply.toLowerCase();
    if (MYTH_DEBUNK_PHRASES.some(p => replyLower.includes(p))) return null;
    return "Your reply invokes a fitness MYTH. Rewrite with the correct principle: progressive overload on the core lifts, and for a lagging body part, targeted volume on that muscle.";
  }
  if (lower.includes("exercises like") || lower.includes("exercises such as") || lower.includes("incorporate") || lower.includes("squats") || lower.includes("lunges") || lower.includes("planks") || lower.includes("deadlifts")) {
    return "You prescribed exercises as if writing a workout. The client's programme is FIXED — do not invent or suggest new movements in chat. Use targeted volume and progressive overload on the lifts they already have, and direct them to *programme* for the actual plan.";
  }
  if (lower.includes("cure") || lower.includes("reverse") || lower.includes("heal") || lower.includes("get rid of") || lower.includes("eliminate") || lower.includes("fix ")) {
    return "Your reply makes a medical cure/reversal claim. KamLife coaches healthy habits; it does not diagnose or promise to cure a condition. Defer the condition itself to the client's doctor.";
  }
  if (lower.includes("with food") || lower.includes("empty stomach") || lower.includes("before bed") || lower.includes("after meals") || lower.includes("at night") || lower.includes("in the morning") || lower.includes("medication") || lower.includes("insulin")) {
    return "Your reply gives medication instructions or changes. That is outside coaching scope. Defer medication decisions and timing to the client's doctor or pharmacist.";
  }
  if (lower.includes("adjust") || lower.includes("update") || lower.includes("recalculate") || lower.includes("reset") || lower.includes("your goal is now") || lower.includes("changed your goal") || lower.includes("switched your goal")) {
    return "You claimed the client's targets, programme, or goal will change, but you have no tool for that. Remove the claim and use the exact WhatsApp command when a change is requested.";
  }
  if (goal === "muscle_gain" && (lower.includes("fat loss") || lower.includes("calorie deficit") || lower.includes("keep losing") || lower.includes("stay in your deficit") || lower.includes("losing weight") || lower.includes("losing fat"))) {
    return "This client's goal is MUSCLE GAIN, but your reply pushes fat loss / a deficit. Rewrite consistent with muscle gain.";
  }
  if (goal === "fat_loss" && (lower.includes("surplus") || lower.includes("bulking") || lower.includes("gaining weight") || lower.includes("gaining mass") || lower.includes("gaining size"))) {
    return "This client's goal is FAT LOSS, but your reply pushes a surplus / bulking / gaining. Rewrite consistent with fat loss.";
  }
  return null;
}

export function verifyBrainReply(reply: string, facts: VerifierFacts): VerifierResult {
  const r = reply || "";
  const hit = POLICY_BREACH_RE.exec(r)?.[0] || "";
  if (hit) {
    const violation = policyViolation(r, hit, String(facts.goalType || "").toLowerCase());
    if (violation) return { ok: false, violation };
  }

  const stepAttribution = verifyStepAttribution(r, facts.clientMessage || "");
  if (!stepAttribution.ok) return stepAttribution;

  const goal = String(facts.goalType || "").toLowerCase();
  if (goal === "muscle_gain" && /\byour\s+(?:calorie\s+)?deficit\b/i.test(r)) return { ok: false, violation: "You called it 'your deficit' but this client is on a SURPLUS (muscle gain). Correct the frame kindly instead of mirroring their confusion." };
  if (goal === "fat_loss" && /\byour\s+(?:calorie\s+)?surplus\b/i.test(r)) return { ok: false, violation: "You called it 'your surplus' but this client is on a DEFICIT (fat loss). Correct the frame kindly instead of mirroring their confusion." };

  return { ok: true };
}
