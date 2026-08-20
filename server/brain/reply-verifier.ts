/**
 * REPLY VERIFIER — the self-correcting loop on the brain's mouth.
 *
 * Deterministic, zero-cost checks on every freeform Coach K reply. The verifier owns the
 * policy surface so the engine can self-correct once and fail open rather than sending a
 * reply already known to be wrong.
 */

import { parseMessyIntake } from "../understanding/messy-intake";
import { currentRuntimeDecision, forceRuntimeReferral, type RuntimeDecisionResult } from "../understanding/state";
import { detectMedicationContext } from "../medication-context";

export interface VerifierFacts {
  goalType?: string | null;
  clientMessage?: string | null;
}

export interface VerifierResult {
  ok: boolean;
  violation?: string;
}

const DECISION_VIOLATIONS = {
  empty: "empty reply",
  investigateMissing: "INVESTIGATE reply must explicitly acknowledge insufficient evidence and identify the minimum evidence needed",
  investigateChange: "INVESTIGATE reply must not prescribe a plan-level change before evidence is sufficient",
  continueChange: "CONTINUE reply must not invent a plan-level change when the deterministic decision is no-change",
  referMissing: "REFER reply must clearly direct the client to appropriate professional/medical support",
};

function lowerWords(text: string): string[] {
  return text.toLowerCase().split(" ").map(word => word
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
    .trim()
  ).filter(Boolean);
}

function containsAny(text: string, phrases: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some(phrase => lower.includes(phrase));
}

function containsPlanChange(text: string): boolean {
  const words = lowerWords(text);
  const change = ["lower", "raise", "increase", "decrease", "cut", "add", "remove", "change", "adjust", "drop", "bump"];
  const plan = ["calorie", "calories", "kcal", "protein", "steps", "step", "target", "intake", "deficit", "plan"];
  return change.some(word => words.includes(word)) && plan.some(word => words.includes(word));
}

function decisionBoundaryViolation(reply: string, decision: RuntimeDecisionResult): string | null {
  const text = (reply || "").trim();
  if (!text) return DECISION_VIOLATIONS.empty;

  if (decision.state === "INVESTIGATE") {
    if (!containsAny(text, [
      "i don't know yet", "i do not know yet", "not enough data", "not enough logged", "not enough evidence",
      "need another day", "need more days", "need more data", "need more evidence", "log another day", "log a few more", "i need to see more",
    ])) return DECISION_VIOLATIONS.investigateMissing;
    if (containsPlanChange(text)) return DECISION_VIOLATIONS.investigateChange;
  }

  if (decision.state === "CONTINUE" && containsPlanChange(text)) return DECISION_VIOLATIONS.continueChange;

  if (decision.state === "REFER" && !containsAny(text, [
    "doctor", "dietitian", "clinician", "healthcare professional", "medical help", "seek medical care", "emergency",
  ])) return DECISION_VIOLATIONS.referMissing;

  return null;
}

function medicationBoundaryViolation(reply: string, clientMessage: string): string | null {
  const medication = detectMedicationContext(clientMessage);
  if (!medication.unsafeRequest) return null;
  const text = (reply || "").toLowerCase();
  if (!containsAny(text, ["doctor", "pharmacist", "clinician", "healthcare professional", "medical care", "seek medical help", "emergency"])) {
    return `Unsafe medication request (${medication.reason}) must be redirected to a doctor, pharmacist, or other appropriate medical professional; do not answer it as ordinary coaching.`;
  }
  if (/\b(calorie|calories|kcal|protein|steps|step|workout|training|session|deficit|meal plan|diet)\b/i.test(text)) {
    return `Unsafe medication request (${medication.reason}) must remain a referral/safety response. Do not continue ordinary diet, training, or weight-loss coaching in the same reply.`;
  }
  if (medication.reason === "sourcing" && /\b(buy|seller|supplier|source|sourcing|black market|hairdresser)\b/i.test(text)) {
    return "The reply must not facilitate medication sourcing or black-market access.";
  }
  return null;
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

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};

/** "three thousand" / "fifteen hundred" → number. Fail-open on unknown phrasing. */
function parseWordNumberPhrase(words: string[], start: number): { value: number; consumed: number } | null {
  let i = start;
  let total = 0;
  let current = 0;
  let consumed = 0;
  while (i < words.length) {
    const w = words[i];
    const n = WORD_NUMBERS[w];
    if (n === undefined) break;
    if (n === 1000) {
      current = (current || 1) * 1000;
      total += current;
      current = 0;
    } else if (n === 100) {
      current = (current || 1) * 100;
    } else {
      current += n;
    }
    consumed += 1;
    i += 1;
  }
  const value = total + current;
  if (consumed === 0 || !Number.isFinite(value) || value <= 0) return null;
  return { value, consumed };
}

function extractStepNumbers(text: string): number[] {
  const words = stepWords(text);
  const out: number[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (isStepWord(word)) {
      const nextNum = Number(words[i + 1]?.replaceAll(",", ""));
      if (Number.isFinite(nextNum)) out.push(nextNum);
      const phraseBefore = parseWordNumberPhrase(words, Math.max(0, i - 4));
      // Prefer phrase immediately preceding the step word
      for (let back = 1; back <= 4 && i - back >= 0; back += 1) {
        const p = parseWordNumberPhrase(words, i - back);
        if (p && p.consumed === back) {
          out.push(p.value);
          break;
        }
      }
      continue;
    }
    const number = Number(word.replaceAll(",", ""));
    if (Number.isFinite(number) && isStepWord(words[i + 1] || "")) out.push(number);
    // "three thousand steps"
    if (WORD_NUMBERS[word] !== undefined && isStepWord(words[i + 1] || "") === false) {
      const p = parseWordNumberPhrase(words, i);
      if (p) {
        const after = words[i + p.consumed];
        if (isStepWord(after || "")) out.push(p.value);
      }
    }
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

/**
 * A TARGET IS NOT AN ATTRIBUTION (2026-08-19).
 *
 * This rule exists to stop the coach telling a client they walked a number they never reported.
 * It read every step figure in a reply as such a claim — including "8,000 steps/day", which is a
 * PRESCRIPTION about tomorrow, not a statement about yesterday.
 *
 * Cost of the confusion, once Cut 3 made the verdict binding: completeOnboarding() prints the
 * client's targets, so the FIRST MESSAGE A NEW CLIENT EVER RECEIVES — their programme, their
 * numbers, how the coach works — was replaced with "Let me not guess on that one." Every new
 * signup. Found by onboarding-e2e, which had been red on main and was sitting fourteenth in an
 * `&&` chain, so the eight guards behind it stopped running too.
 *
 * Deliberately narrow. Only the unambiguous per-day and named-target forms are redacted before
 * the attribution check; "you did 8,000 steps" and "you hit 8,000 steps today" are untouched and
 * must still fail. Redaction, not an exemption — a reply that ALSO makes a real attribution still
 * gets caught on that clause.
 */
/** A segment is prescriptive when it frames the number as something to reach. */
const TARGET_MARKER = /\btargets?\b|\bgoals?\b|\baim\s+for\b|\/\s*day\b|\bper\s+day\b|\ba\s+day\b|\bnon-negotiable\b/i;

/**
 * …and it stops being prescriptive the moment it also says the CLIENT DID IT. "You did 6,000
 * steps against a target of 8,000" names a target and is still an attribution, so it stays
 * subject to the rule. Deliberately generous: a false hit here only restores the strict old
 * behaviour, which is the safe direction to fail in.
 */
const CLIENT_DID_IT = /\b(?:you(?:'ve| have| are|'re)?\s+(?:already\s+)?(?:walked|did|done|hit|got|clocked|logged|managed|racked|at)|walked|clocked|racked\s+up)\b/i;

/**
 * Blank out prescriptive segments before the attribution check. Split per line AND per sentence,
 * so one bullet in a target list cannot borrow an attribution verb from another line.
 */
function withoutStepTargets(reply: string): string {
  return (reply || "")
    .split(/(\n+|(?<=[.!?])\s+)/)
    .map(seg => (TARGET_MARKER.test(seg) && !CLIENT_DID_IT.test(seg) ? " " : seg))
    .join("");
}

function verifyStepAttribution(reply: string, clientMessage: string): VerifierResult {
  const replySteps = extractStepNumbers(withoutStepTargets(reply));
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

export function verifyBrainReply(reply: string, facts: VerifierFacts, decisionOverride?: RuntimeDecisionResult): VerifierResult {
  const r = reply || "";
  const decision = decisionOverride || currentRuntimeDecision();
  if (decision) {
    const violation = decisionBoundaryViolation(r, decision);
    if (violation) return { ok: false, violation };
  }

  const medication = detectMedicationContext(facts.clientMessage || "");
  const medicationViolation = medicationBoundaryViolation(r, facts.clientMessage || "");
  if (medication.unsafeRequest) {
    forceRuntimeReferral();
  }
  if (medicationViolation) return { ok: false, violation: medicationViolation };

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

  // ── Food-turn grounding (live 2026-08-19 McDonald's voice failure) ─────────
  // Client described a meal; coach said "no meal logged / what did you eat?" AND
  // invented precise kcal/protein. Reality before reasoning: never re-ask for a meal
  // already in the client message; never pair "nothing logged" with macro precision.
  const clientMsg = String(facts.clientMessage || "");
  // ONE OWNER FOR "DID THEY REPORT FOOD" (Cut 3). This was its own noun regex, and it matched
  // the word "meal" in "remove last meal" — so a management command counted as a food report.
  // Harmless while a rejected reply was sent anyway; the moment the verdict BINDS, it blocked a
  // legitimate reply and the client got "let me not guess on that one". A planning question
  // ("what should I order at KFC") misfired the same way.
  //
  // parseMessyIntake owns the report-vs-command distinction and answers no to both. Narrower
  // than the old regex on foods it does not know by name, and stated rather than hidden: this is
  // a grounding rule, not a safety one, and a false block is worse than a missed nudge.
  const clientHasFood = parseMessyIntake(clientMsg).hasFoodReport;
  const asksWhatAte = /\b(what did you eat|what have you eaten|i don'?t have a meal logged|no meal logged|nothing logged for you today|i have no meal logged)\b/i.test(r);
  const claimsMealMacros = /\b\d{2,5}\s*kcal\b/i.test(r) && /\b\d{1,3}\s*g(?:rams?)?\s*protein\b/i.test(r);
  if (clientHasFood && asksWhatAte) {
    return { ok: false, violation: "The client already described food in this message. Do NOT ask what they ate or claim no meal is logged. Log or confirm that food in their words; if amounts are unclear ask ONLY for the missing amount — never pretend the meal was not stated." };
  }
  if (asksWhatAte && claimsMealMacros) {
    return { ok: false, violation: "Contradiction: you said no meal is logged (or asked what they ate) and also stated precise kcal/protein. You cannot invent macros for a meal you claim is missing. Either log the stated food without fake precision, or ask one clarifying question with no numbers." };
  }
  if (clientHasFood && claimsMealMacros && asksWhatAte === false && /\bi don'?t have a meal logged\b/i.test(r) === false) {
    // Still block precise macros when we have no proof a log write happened this turn.
    // VerifierFacts does not yet carry mealLoggedThisTurn — treat unanchored precision as unsafe.
    if (!/\b(logged|on the log|in the books|saved)\b/i.test(r)) {
      return { ok: false, violation: "Client described food but your reply states precise kcal/protein without confirming a log write. Log first (or confirm amounts), then reply in their words. If estimating, say it is an estimate and do not treat it as logged truth." };
    }
  }

  // Live 14:22: meal just logged, then "a lot of fried/takeaway" + "grill it don't fry it".
  // Least intervention: confirm the log. Do not shame the plate they already ate.
  if (clientHasFood && /\b(that'?s a lot of fried\/?takeaway|grill it,? don'?t fry it|heavy on the hidden fat)\b/i.test(r)) {
    return { ok: false, violation: "Do not lecture a client about fried/takeaway on the turn they just described a meal. Confirm the log. Next-meal direction only — no shame about the plate already eaten." };
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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// "DON'T TALK ABOUT THE SCALE" — THE ONE FACT WHOSE WHOLE VALUE IS BEING HONOURED
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// (2026-08-19, Cut 8.) Cut 7 started detecting this request and storing it in users.do_not_mention,
// and then told only the GPT context about it. Every deterministic path — the weigh-in ask, the
// progress reply, the morning decision — carried on saying the word.
//
// That is worse than the gap it replaced. Before Cut 7 we never heard the request; after it we
// hear it, record it, and visibly ignore it. Noticing what someone asked for and then doing it
// anyway is a broken promise, and this cut exists to close what Cut 7 opened.
//
// Pure, and deliberately in the verifier: this module already owns the question "may this reach a
// client", and it has no database or model, so the DECISION can import it without either.

/** Topics that are one topic. Asked not to mention "the scale", we must not say "weigh" either. */
const TOPIC_CLUSTERS: string[][] = [
  ["weight", "weigh", "weighed", "weighing", "weigh-in", "weighin", "scale", "scales", "kg", "kilos", "kilograms"],
  ["calories", "calorie", "kcal", "cals"],
];

/**
 * The pattern that means "this text names the thing they asked me to drop", or null when there is
 * nothing to honour. Word-bounded — "scale" must not fire on "escalate".
 */
export function forbiddenTopicPattern(doNotMention?: string | null): RegExp | null {
  const raw = (doNotMention || "").trim().toLowerCase();
  if (raw.length < 2 || raw.length > 60) return null;
  const asked = raw.split(/[,;]+| and /).map(s => s.trim()).filter(w => w.length >= 2);
  if (asked.length === 0) return null;

  const words = new Set<string>();
  for (const term of asked) {
    words.add(term);
    // One member of a cluster pulls in the rest — otherwise "don't mention the scale" is honoured
    // by a reply that says "let's get you weighed", which is the same sentence to the person who
    // asked. Terms outside every cluster are taken literally and nothing is inferred.
    for (const cluster of TOPIC_CLUSTERS) {
      if (cluster.some(c => c === term || term.includes(c))) cluster.forEach(c => words.add(c));
    }
  }
  const escaped = [...words].map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  // LETTER LOOKAROUNDS, NOT \b. "2kg" has no word boundary between the digit and the k, so \b
  // would silently fail on exactly the sentence this exists to catch — the identical mistake
  // replaceNumberToken in chat-log.ts carries a comment about, and the one the step-target P0
  // turned on. Guarding on letters still blocks a substring hit: "escalate" cannot match "scale"
  // because the preceding character is a letter.
  try { return new RegExp(`(?<![a-z])(?:${escaped.join("|")})(?![a-z])`, "i"); } catch { return null; }
}

export function mentionsForbidden(text: string, doNotMention?: string | null): boolean {
  const re = forbiddenTopicPattern(doNotMention);
  return !!re && re.test(String(text || ""));
}

export interface ForbiddenStripResult {
  /** What may be sent. "" when nothing substantive survived. */
  text: string;
  /** True when something was actually removed — the caller logs and escalates on this. */
  stripped: boolean;
}

/**
 * Remove the sentences that name the topic, and keep the rest of the reply.
 *
 * SENTENCE LEVEL ON PURPOSE. Blocking the whole reply — the Cut 3 treatment — would throw away a
 * correctly logged meal because the message happened to end with "weigh in tomorrow". Honouring
 * the request should cost the client the sentence, not the answer.
 *
 * A reply that is ENTIRELY about the topic strips to "", and the caller says so honestly instead
 * of sending an empty message.
 */
export function stripForbidden(reply: string, doNotMention?: string | null): ForbiddenStripResult {
  const re = forbiddenTopicPattern(doNotMention);
  const draft = String(reply || "");
  if (!re || !re.test(draft)) return { text: draft, stripped: false };

  // Split on bubble breaks first — `\n\n---\n\n` is a separate WhatsApp message, so a bubble that
  // is entirely about the topic must go whole rather than leave a stub behind.
  const bubbles = draft.split("\n\n---\n\n").map(bubble =>
    bubble.split("\n").map(line => {
      if (!re.test(line)) return line;
      const kept = line.split(/(?<=[.!?])\s+/).filter(s => !re.test(s));
      return kept.join(" ").trim();
    }).filter(l => l !== "" || false).join("\n").trim()
  ).filter(b => b.length > 0);

  const text = bubbles.join("\n\n---\n\n").replace(/\n{3,}/g, "\n\n").trim();
  // A leftover that is only punctuation, an emoji or a bare "*" is not an answer.
  return { text: /[a-z0-9]{3}/i.test(text) ? text : "", stripped: true };
}

/** What we say when the entire reply was about the thing they asked us to drop. */
export const HONOURED_SILENCE = "You asked me to leave that one alone, so I will. Tell me what you ate and we work from there.";
