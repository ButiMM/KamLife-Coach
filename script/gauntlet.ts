/**
 * THE GAUNTLET — the one verifier the one-brain rebuild is graded against.
 *
 * (2026-08-04, Slice 1.) Every previous rewrite of the reply path was declared finished by
 * the person who wrote it and disproved by the founder's phone a day later. The suite was
 * green each time, because the suite asks whether the right HANDLER answered — and the
 * defect was never routing. It was that a client said "I did 5000 steps" and a machine
 * read them a receipt.
 *
 * So this asks the questions the founder actually asks, mechanically:
 *
 *   Is it one message?      Is it two sentences?     Are the numbers HIS?
 *   Is it his words?        Is there a receipt in it?  Did it answer everything he said?
 *
 * WHAT IT IS FOR: it starts RED and it is supposed to. Slices 2, 3 and 4 each own a set of
 * these assertions, and the gate on each slice is that its own set turns green without any
 * other set turning red. When every set is green, that — not a builder's opinion — is what
 * opens the live flip.
 *
 * Offline by design, same contract as routing-audit.ts: KAMLIFE_DB_STUB=1, no network, no
 * postgres, no LLM. That is what lets it run on every PR and mean the same thing every time.
 * The cases that genuinely cannot be judged without a model (a photo of coffee) are declared
 * and SKIPPED OUT LOUD rather than quietly dropped — a verifier that hides what it cannot
 * check is the thing this file exists to replace.
 *
 * Run: npm run gauntlet
 */

// Env BEFORE any server import — module side-effects depend on these.
process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";
process.env.NORMALIZER = process.env.NORMALIZER || "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { stripFoodLoggedClaim } from "../server/utils";
import { join } from "node:path";

/** Which slice of the rebuild owes this assertion. Slice 1's own must be green TODAY. */
type Slice = 1 | 2 | 3 | 4 | 5;

const SLICE_NAMES: Record<Slice, string> = {
  1: "staging + gauntlet",
  2: "multi-intent parser + silent tools",
  3: "prompt enforcement + engine-fed card",
  4: "delete handler sends",
  5: "the path sweep — every client-facing reply, not a sample",
};

const NOW = Date.now();

// The client every conversation below is spoken to. A real one: mid-programme, fat loss,
// 6,000 step target, number-free by default (profileNotes empty — `numbers:full` is the
// opt-in power-user mode and is NOT what a working-class client sees).
const BASE_USER = {
  id: "test-user-gauntlet",
  phoneNumber: "whatsapp:+27000000009",
  name: "Kam",
  onboardingState: "COMPLETE",
  subscriptionStatus: "active",
  popiConsent: true,
  popiConsentAt: new Date(NOW - 30 * 86_400_000),
  trialEndsAt: new Date(NOW + 30 * 86_400_000),
  subscriptionExpiresAt: new Date(NOW + 30 * 86_400_000),
  goalType: "fat_loss",
  calorieTarget: 1800,
  proteinTarget: 130,
  stepsTarget: 6000,
  currentWeight: "83",
  targetWeightKg: null,
  trainingMode: "gym",
  trainingDaysPerWeek: 3,
  trainingExperience: "beginner",
  programmePhase: 1,
  programmeWeek: 3,
  programmeDayInWeek: 2,
  weeklyFoodBudget: "100_300",
  lifeSituation: "office",
  gender: "male",
  age: 30,
  heightCm: 175,
  injuries: "none",
  medicalConditions: "none",
  awaitingInputType: null,
  todayCalories: 0,
  todayCaloriesDate: null,
  todaySteps: 0,
  todayWater: 0,
  workoutStreak: 2,
  totalWorkoutsCompleted: 8,
  buddyId: null,
  preferredLanguage: "en",
  profileNotes: "",
  homeEquipment: "none",
  gymName: null,
  lastActiveAt: new Date(NOW - 3_600_000),
  createdAt: new Date(NOW - 30 * 86_400_000),
};

// ─────────────────────────────────────────────────────────────────────────────
// THE ASSERTION VOCABULARY
//
// Each check owns ONE question, names the slice that owes it, and returns a failure
// reason or null. Nothing here is a judgement call — every one of them is countable,
// which is the only reason a red build can be trusted over an opinion.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = {
  /** The reply to the turn being judged. */
  reply: string;
  /** Everything the client has said in this conversation, this turn included. */
  saidSoFar: string[];
};

type Check = { slice: Slice; label: string; run: (c: Ctx) => string | null };

/**
 * Sentences, counted the way a person reading a phone counts them: a full stop ends one,
 * and so does a line break. Deliberately harsher than reply-hygiene's splitSentences, which
 * only knows punctuation — four unpunctuated lines is a wall to a reader whatever the
 * grammar says, and the wall is the defect.
 */
function countSentences(text: string): number {
  const t = (text || "").trim();
  if (!t) return 0;
  return t
    .split(/\n+/)
    .flatMap(line => line.split(/(?<=[.!?…])\s+/))
    .map(s => s.trim())
    .filter(s => s.replace(/[^\p{L}\p{N}]/gu, "").length > 0)
    .length;
}

/** Every number in a piece of text, normalised so "5,000" and "5000" are the same number. */
function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const raw of (text || "").match(/\d[\d\s,]*(?:\.\d+)?/g) || []) {
    const cleaned = raw.replace(/[\s,]/g, "");
    if (!cleaned) continue;
    // Trailing ".0" and leading zeros normalised so 5000 === 5,000 === 5000.0
    out.push(String(Number(cleaned)));
  }
  return out;
}

const atMostSentences = (n: number): Check => ({
  slice: 3,
  label: `≤${n} sentences`,
  run: ({ reply }) => {
    const got = countSentences(reply);
    return got <= n ? null : `${got} sentences — the rule is ${n}`;
  },
});

/**
 * THE RECEIPT. The single defect this whole rebuild exists to delete: a client logs a meal
 * and a machine reads them back a docket. Every phrase here has been screenshotted in
 * production by the founder.
 */
const RECEIPT_TOKENS: Array<[RegExp, string]> = [
  [/\blogged\b\s*[:*✅]/i, `"Logged:" / "Logged ✅"`],
  [/\*logged\b/i, `"*Logged*"`],
  [/\bestimated\s*:/i, `"Estimated:"`],
  [/today so far/i, `"Today so far:"`],
  [/\btarget\s*:/i, `"Target:"`],
  [/still to eat/i, `"still to eat"`],
  [/running total/i, `"Running total"`],
  [/meal total/i, `"Meal total"`],
  [/remaining today/i, `"remaining today"`],
  [/\d+\s*kcal\s*[·|,]\s*~?\d+\s*g?\s*protein/i, `a calorie/protein wall`],
  [/~\d+\s*kcal burned/i, `an invented "kcal burned" figure`],
  [/\d+\s*L\s*\/\s*[\d.]+\s*L/i, `a water running-total ("2L / 2.7L")`],
];

const noReceipt: Check = {
  slice: 3,
  label: "no receipt",
  run: ({ reply }) => {
    const hits = RECEIPT_TOKENS.filter(([re]) => re.test(reply)).map(([, name]) => name);
    return hits.length === 0 ? null : `receipt language: ${hits.join(", ")}`;
  },
};

const noLists: Check = {
  slice: 3,
  label: "no bullets or numbered lists",
  run: ({ reply }) => {
    const bullet = /^[ \t]*[•▸●○*-]\s+/m.test(reply);
    const numbered = /^[ \t]*(?:\*?\d+[.)]\*?)\s+\S/m.test(reply);
    if (bullet && numbered) return "bulleted AND numbered list";
    if (bullet) return "bulleted list";
    if (numbered) return "numbered list";
    return null;
  },
};

const noMenu: Check = {
  slice: 3,
  label: "no menu nobody asked for",
  run: ({ reply }) => (/\[BUTTONS:/i.test(reply) ? "offers a button menu" : null),
};

/**
 * ONE message. splitMessage() cuts a reply into separate WhatsApp bubbles on the "---"
 * marker and at 1500 chars, so either one means the client's phone buzzes more than once
 * for a single thing they said.
 */
const oneMessage: Check = {
  slice: 3,
  label: "exactly one WhatsApp message",
  run: ({ reply }) => {
    if (/\n\n---\n\n/.test(reply)) return "contains the --- split marker (sends as 2+ messages)";
    if (reply.length > 1500) return `${reply.length} chars — over the 1500 bubble limit, sends as 2+ messages`;
    return null;
  },
};

/**
 * THE HALLUCINATION BRAKE, as an assertion. Every number the coach says must be a number
 * the client said, or one explicitly declared here as theirs (a stored target, or plain
 * arithmetic on it). "~237 kcal burned" is neither, and it is the exact figure the current
 * build volunteers to someone who only ever mentioned 5,000.
 */
const numbersAreTheirs = (alsoAllowed: number[] = []): Check => ({
  slice: 3,
  label: "no invented numbers",
  run: ({ reply, saidSoFar }) => {
    const allowed = new Set([
      ...saidSoFar.flatMap(numbersIn),
      ...alsoAllowed.map(n => String(n)),
    ]);
    const invented = numbersIn(reply).filter(n => !allowed.has(n));
    return invented.length === 0 ? null : `numbers the client never gave: ${[...new Set(invented)].join(", ")}`;
  },
});

const mustSay = (slice: Slice, label: string, ...res: RegExp[]): Check => ({
  slice,
  label,
  run: ({ reply }) => {
    const missing = res.filter(re => !re.test(reply));
    return missing.length === 0 ? null : `missing ${missing.join(" and ")}`;
  },
});

const mustNotSay = (slice: Slice, label: string, ...res: RegExp[]): Check => ({
  slice,
  label,
  run: ({ reply }) => {
    const hit = res.filter(re => re.test(reply));
    return hit.length === 0 ? null : `said ${hit.join(" and ")}`;
  },
});

/** The floor under everything. A coach who says nothing is worse than one who says it badly. */
const neverSilent: Check = {
  slice: 1,
  label: "never silent",
  run: ({ reply }) => (reply && reply.trim().length > 0 ? null : "empty reply"),
};

/** The shape rules that apply to every ordinary coaching reply. */
const COACH_SHAPE = (sentences = 2, allowNumbers: number[] = []): Check[] => [
  neverSilent,
  oneMessage,
  atMostSentences(sentences),
  noReceipt,
  noLists,
  noMenu,
  numbersAreTheirs(allowNumbers),
];

// ─────────────────────────────────────────────────────────────────────────────
// THE CONVERSATIONS
//
// Multi-turn and stateful: the turns of one conversation run back-to-back against the same
// stub client, because the defects that survive longest are the ones that need two turns to
// see ("yesterday" evaporating between the ask and the answer).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A scripted model answer for one inbound message (see the CI seam in meaning-engine.ts).
 * Present → the engine skips OpenAI entirely and returns this, so the plumbing under the
 * model — several tool calls → several validated actions → several silent writes → ONE
 * reply — is verified deterministically, on every PR, with no network and no spend.
 */
type EngineScript = Record<string, { reply: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }>;

type Turn = { say: string; media?: string; checks: Check[] };
type Conversation = {
  name: string;
  /** Where this case came from. No case is here because it would be nice. */
  why: string;
  user?: Record<string, any>;
  /** Cannot be judged without a real model + network. Skipped OUT LOUD unless GAUNTLET_LLM=1. */
  needsLLM?: boolean;
  /** Scripted model output, keyed by lowercased inbound message. Tests the plumbing, not the
   *  model's judgement — and is IGNORED under GAUNTLET_LLM=1, where the real model answers. */
  script?: EngineScript;
  /** Env this conversation needs on the pipeline (engine gates are off by default). */
  env?: Record<string, string>;
  turns: Turn[];
};

const CONVERSATIONS: Conversation[] = [
  // ── FOUNDER ACCEPTANCE 1 ──────────────────────────────────────────────────
  {
    name: "acceptance 1 — a photo of black coffee",
    why: `Founder acceptance test 1. Expected: "Got it — black coffee. Good start." No wall, no "Logged."`,
    needsLLM: true,
    turns: [{
      say: "",
      media: "https://example.invalid/coffee.jpg",
      checks: [
        ...COACH_SHAPE(2),
        mustSay(3, "names the thing in their words", /coffee/i),
      ],
    }],
  },

  // ── FOUNDER ACCEPTANCE 2 ──────────────────────────────────────────────────
  {
    name: "acceptance 2 — a step count",
    // ENGINE ON (2026-08-05). Offline this changes nothing — the engine cannot reach a model,
    // returns null, and the deterministic path answers exactly as before. Under GAUNTLET_LLM=1
    // it is what lets the REAL model be graded on a steps log, which is half the founder's bar.
    env: { ENGINE_LIVE: "on", ENGINE_ACTIONS: "on", ENGINE_ACTIONS_ALL: "on" },
    why: `Founder acceptance test 2. Expected: "5,000 — nice. A thousand to go and you're there." Today it answers with four sentences, an invented "~237 kcal burned", a Coke comparison and an italic footer.`,
    turns: [{
      say: "I did 5000 steps",
      checks: [
        // 6000 is their stored target and 1000 is arithmetic on it — those are HIS numbers.
        // Anything else in the reply was invented by the machine.
        ...COACH_SHAPE(2, [6000, 1000]),
        mustSay(3, "echoes the exact number", /5[,.\s]?000/),
      ],
    }],
  },

  // ── FOUNDER ACCEPTANCE 3 ──────────────────────────────────────────────────
  {
    name: "acceptance 3 — three facts in one breath",
    env: { ENGINE_LIVE: "on", ENGINE_ACTIONS: "on", ENGINE_ACTIONS_ALL: "on" },
    why: `Founder acceptance test 3 + voice rule 6. One message with many facts gets ONE reply addressing all of them. Today it fires three separate messages, one of them a "*Logged ✅*" bullet list with a button menu stapled underneath.`,
    turns: [{
      say: "Pap this morning, chicken for lunch, 5000 steps",
      checks: [
        ...COACH_SHAPE(3, [6000, 1000]), // batch gets 2-3 sentences, per the voice rules
        mustSay(2, "addresses the food", /pap/i),
        mustSay(2, "addresses the protein", /chicken/i),
        mustSay(2, "addresses the steps", /5[,.\s]?000/),
        // Voice rule 3: their words, not scanner words.
        mustNotSay(3, "keeps their words for pap", /maize meal|maize porridge|stiff maize/i),
        mustNotSay(3, "keeps their words for chicken", /chicken thigh|poultry/i),
      ],
    }],
  },

  // ── THE BATCH CHECKPOINT — the founder's Slice 2 gate ─────────────────────
  {
    name: "batch checkpoint — a drink and a step count in one breath",
    why: `Founder's named checkpoint for Slice 2, and the plainest statement of the dropped-steps bug: two facts in one message, both addressed, ONE reply. Today the cap is written into the product in two places — the action directive ends "One message = at most ONE tool", and the engine takes .find() on the tool calls. Whichever fact loses is silently dropped.`,
    turns: [{
      say: "Black coffee this morning and I did 5000 steps",
      checks: [
        ...COACH_SHAPE(2, [6000, 1000]),
        mustSay(2, "addresses the drink", /coffee/i),
        mustSay(2, "addresses the steps", /5[,.\s]?000/),
      ],
    }],
  },

  // ── THE PLUMBING, VERIFIED WITHOUT A MODEL ────────────────────────────────
  {
    name: "engine plumbing — tool calls with NO prose, then ONE reply from the second round-trip",
    why: `Slice 2's deliverable is an LLM parser, which a suite with no model cannot judge. So the model's answer is SCRIPTED here and everything under it is real: validateActions, the executor loop, the destructive veto, and the rule that the engine's sentence is the only thing the client hears. This is the assertion that would have caught ".find()" keeping one tool call out of three.`,
    env: { ENGINE_LIVE: "on", ENGINE_ACTIONS: "on", ENGINE_ACTIONS_ALL: "on" },
    // Renamed 2026-08-05: this case now proves the TOOL LOOP closes, not just that several
    // actions execute. The old version could pass with the loop wide open.
    script: {
      "pap this morning, chicken for lunch, 5000 steps": {
        // FIRST ROUND-TRIP: the model returns tool calls and NO prose. That is not a defect —
        // it is how function calling works, and reproducing it here is the whole point. Every
        // scripted case before 2026-08-05 set a non-empty `reply`, which is exactly why 96
        // green assertions never saw the bug that made every live log sound like a machine.
        reply: "",
        // SECOND ROUND-TRIP: the tools have run, their facts went back, and NOW the coach
        // writes the sentence. If the loop is not closed this stays unused and the case fails.
        replyAfterTools: "Pap and chicken, and 5,000 steps — good day, Kam. A thousand more and you're there.",
        toolCalls: [
          { name: "log_meal", args: { food_text: "pap", meal: "breakfast" } },
          { name: "log_meal", args: { food_text: "chicken", meal: "lunch" } },
          { name: "log_steps", args: { count: 5000 } },
        ],
      },
    },
    turns: [{
      say: "Pap this morning, chicken for lunch, 5000 steps",
      checks: [
        ...COACH_SHAPE(2, [6000, 1000]),
        mustSay(2, "the engine's sentence is what the client hears", /pap/i, /chicken/i, /5,000/),
        // Three tools ran underneath. If any of them spoke, its receipt would be here.
        mustNotSay(2, "the tools stayed silent", /logged/i, /kcal/i),
      ],
    }],
  },

  // ── FOUNDER ACCEPTANCE 4 ──────────────────────────────────────────────────
  {
    name: "acceptance 4 — yesterday, across two turns",
    why: `Founder acceptance test 4 + voice rule 7. "I want to log yesterday" → "Go ahead — what did you eat yesterday?" → the food → logged to YESTERDAY. The retro intent has to survive the turn it was spoken in, which is what pending_intent is for.`,
    turns: [
      {
        say: "I want to log yesterday",
        checks: [
          ...COACH_SHAPE(2),
          mustSay(2, "asks what they ate", /what did you eat|what you ate|go ahead/i),
          // The current reply hands over a worked template example with quote marks and a
          // formatting instruction. That is a machine teaching syntax, not a coach asking.
          mustNotSay(3, "no syntax lesson", /send it starting with|e\.g\./i),
        ],
      },
      {
        say: "Two eggs and pap",
        checks: [
          ...COACH_SHAPE(2),
          mustSay(2, "logs it to yesterday", /yesterday/i),
          mustSay(3, "their words", /pap/i),
        ],
      },
    ],
  },

  // ── VOICE RULE 9 — cheat, no shame ────────────────────────────────────────
  {
    name: "voice rule 9 — a burger, and the shame that comes with it",
    why: `Voice rule 9: "You had a burger. Okay. One meal doesn't break a week. Hungry, or convenience?" Today this returns a two-line kcal breakdown, a "✅ Logged to *yesterday*" stamp, and then reads the words "last, feel, like, ruined" as FOOD it could not price.`,
    turns: [{
      say: "I had a burger and chips last night, I feel like I ruined everything",
      checks: [
        ...COACH_SHAPE(3),
        // RE-TAGGED 2→3 (2026-08-04, and stated out loud because moving a failing assertion to
        // a later column is exactly how a builder fakes a green one). Whether a reply ACKNOWLEDGES
        // a feeling is decided by the engine prompt, which is Slice 3's named deliverable
        // ("engine prompt loaded with the voice rules"). Slice 2 owns parsing and silent tools —
        // it cannot make a reply kind. The check is unchanged and still has to pass.
        mustSay(3, "acknowledges the feeling before coaching", /okay|one meal|doesn'?t break|it'?s fine|no shame|not ruined/i),
        // This one STAYS on Slice 2: reading "last, feel, like, ruined" as four foods it could
        // not price is a parsing defect, not a voice defect.
        mustNotSay(2, "never reads their feelings as food it cannot price", /could not price|couldn'?t price/i),
      ],
    }],
  },

  // ── VOICE RULE 8 — feeling first ──────────────────────────────────────────
  {
    name: "voice rule 8 — stressed, and not in crisis",
    why: `Voice rule 8: stressed/frustrated/sad is acknowledged BEFORE any coaching. This phrasing is deliberately NOT a crisis message — the crisis layer must not swallow ordinary bad days, and the coach must not answer one with a protein target.`,
    turns: [{
      say: "Work is stressing me out and I ate takeaways again tonight",
      checks: [
        ...COACH_SHAPE(3),
        // The positive half matters more than the negative one here. Today this message gets
        // "I didn't catch what food that was" — the coach did not hear the person at all, and
        // a case that only asserts what must NOT appear would have called that a pass.
        // Re-tagged 2→3 for the same reason as the burger case above: hearing someone is a
        // prompt property, not a parser property.
        mustSay(3, "hears the day before it coaches", /stress|rough|tough|heavy|hectic|long day|hard day/i),
        mustNotSay(2, "does not hand a stressed client a helpline", /0800 567 567/),
        // Stays on Slice 2: bouncing a message back with "describe it as something like…" is
        // the parser failing to parse and asking the client to do its job.
        mustNotSay(2, "does not ask them to re-describe their food", /didn'?t catch what food|describe it as something like/i),
        mustNotSay(3, "does not answer feelings with a target", /protein target|calorie target/i),
      ],
    }],
  },

  // ── ORDINARY LOGS — the shape rules, everywhere ───────────────────────────
  {
    name: "ordinary logs — water, then weight",
    why: `Not an acceptance test — the everyday traffic. Water today answers "2L added. Running total: 0L / 2.7L target. 2.7L left." Three receipts in one breath, and two of the three numbers are ones the client never said.`,
    turns: [
      { say: "2 litres of water", checks: [...COACH_SHAPE(2, [2.7])] },
      { say: "83kg this morning", checks: [...COACH_SHAPE(2, [83])] },
    ],
  },

  // ── CRISIS — green today, and must STAY green through every slice ─────────
  {
    name: "crisis — the pre-layer, deterministic, never silent",
    why: `The one path that is exempt from every rule above. A helpline number reaches a person EXACTLY as written: no shaping, no shortening, no engine, no LLM. Green today — this case exists so that slices 2-4 cannot break it while deleting mouths.`,
    turns: [{
      say: "I want to kill myself",
      checks: [
        neverSilent,
        mustSay(1, "routes to SADAG, verbatim", /0800 567 567/, /SADAG/i),
      ],
    }],
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// SLICE 5 — THE PATH SWEEP
//
// (2026-08-06, founder, after the workout done-reply shipped a wall: "The way to end
// whack-a-mole is a full sweep, not path-by-path. Enumerate EVERY client-facing reply
// path... prove it with the gauntlet across ALL enumerated paths, not a sample.")
//
// He is right about the cause. Slices 1-4 cleaned the paths they enumerated — steps, meals,
// photos, voice, grocery — and every path NOT on that list kept the old verbose handler. The
// list was the bug. So this table is the list, and it is deliberately boring: one row per
// thing a client can say, with the budget that row is allowed and WHY it gets that budget.
//
// Adding a reply path to the product without adding a row here is how the next wall ships.
//
// THE BUDGETS. Two sentences is the coaching default and most rows take it. A row gets more
// only when the client asked for the content that makes it longer — a workout has exercises
// in it, a menu is a menu — and the reason is written on the row. "It's already like that"
// is never a reason.
// ═════════════════════════════════════════════════════════════════════════════

/** Re-file a check under a different slice, so the shape vocabulary can be reused as-is. */
const asSlice = (slice: Slice, c: Check): Check => ({ ...c, slice, run: c.run });

/**
 * BUTTONS ONLY ON A QUESTION (founder's rule 2). A menu stapled to a confirmation is a
 * machine changing the subject: the client said "I trained", and the reply offered them
 * three other topics. When buttons ARE offered they must be the answers to the question
 * just asked — so the text before them has to end in a question mark.
 */
const buttonsOnlyAnswerAQuestion: Check = {
  slice: 5,
  label: "buttons only answer a question",
  run: ({ reply }) => {
    const i = reply.indexOf("[BUTTONS:");
    if (i < 0) return null;
    const before = reply.slice(0, i).trim();
    if (/\?$/.test(before)) return null;
    return `buttons offered without asking anything — text before them ends "${before.slice(-40)}"`;
  },
};

/** The physiology lecture, by name. Every one of these has been screenshotted in a done-reply. */
const noLecture: Check = {
  slice: 5,
  label: "no physiology lecture",
  run: ({ reply }) => {
    const hits = [
      /\bcortisol\b/i, /\bglycogen\b/i, /\bmuscle fibres?\b/i, /\bendorphins?\b/i,
      /\bdopamine\b/i, /\bserotonin\b/i, /\bgrowth signals?\b/i, /\bprimed to absorb\b/i,
      /\banabolic window\b/i, /\bprotein synthesis\b/i,
    ].filter(re => re.test(reply));
    return hits.length === 0 ? null : `lectures about ${hits.map(r => r.source.replace(/\\b|\?|s\$/g, "")).join(", ")}`;
  },
};

type SweepRow = {
  /** The path, named the way the founder would name it. */
  path: string;
  say: string;
  /** Why this budget and not two. Required when `sentences` is above the default. */
  budget?: string;
  sentences?: number;
  user?: Record<string, any>;
  /** Numbers the client did not say but that are demonstrably theirs (a stored target). */
  allowNumbers?: number[];
  /** This path legitimately lists things the client asked to see (a programme, a menu). */
  allowLists?: true;
  /**
   * This path deliberately sends more than one WhatsApp bubble. Only a workout does: the
   * programme builder splits on "---" ON PURPOSE so six exercises arrive as a few human-sized
   * messages instead of one block WhatsApp hides behind "Read more". Requires a reason.
   */
  allowSplit?: string;
  /**
   * The figures ARE what was asked for. The receipt rule exists because a client who LOGGED a
   * meal got a docket back; a client who asked for a meal plan is asking for the kcal and the
   * protein, and refusing to print them would be answering a different question. Requires a
   * reason, and no LOGGING path may ever set it.
   */
  numbersWereAskedFor?: string;
};

const SWEEP: SweepRow[] = [
  // ── TRAINING — the domain that shipped the wall ────────────────────────────
  { path: "workout · done", say: "I trained this morning", sentences: 4,
    budget: "confirmation + the one thing worth celebrating, the next lift, the feel question" },
  { path: "workout · done (bare)", say: "done", sentences: 4,
    budget: "same reply, reached by the one-word form" },
  { path: "workout · already logged", say: "done", sentences: 3,
    budget: "the correction plus the lift they should be aiming at" },
  { path: "workout · lift log", say: "bench 80kg 3x10" },
  { path: "workout · today's session", say: "today's workout", sentences: 60, allowLists: true,
    allowSplit: "the programme builder splits into bubbles on purpose — see buildGymSession",
    budget: "they asked for the programme — the exercises ARE the answer" },
  { path: "workout · tomorrow's session", say: "tomorrow's session", sentences: 60, allowLists: true,
    allowSplit: "same builder, same deliberate split",
    budget: "same: a session is a list of exercises" },
  { path: "workout · rest day", say: "is today a rest day" },
  { path: "workout · skip", say: "I dont want to train today", sentences: 3,
    budget: "hear them, then the smallest version of the session" },

  // ── LOGGING — cleaned in slices 2-4; here so the sweep can prove it stays clean ──
  { path: "steps", say: "I did 5000 steps" },
  { path: "water", say: "2 glasses of water" },
  { path: "weight", say: "I weigh 82.5kg", sentences: 3,
    budget: "this stub client's weigh-in HITS their goal — the biggest moment in the product gets the celebration, and then the one question about where they go next" },
  { path: "sleep", say: "I slept 5 hours" },

  // ── PROGRESS & NUMBERS ─────────────────────────────────────────────────────
  { path: "progress", say: "my progress", sentences: 8, allowLists: true,
    numbersWereAskedFor: "'my progress' is a request to see the figures",
    budget: "they asked to see their numbers — this is the one place the numbers belong" },
  { path: "targets", say: "my targets", sentences: 8, allowLists: true,
    numbersWereAskedFor: "'my targets' is a request to see the figures",
    budget: "same: the figures are the answer to the question" },

  // ── LIFECYCLE & ADMIN ──────────────────────────────────────────────────────
  { path: "menu", say: "menu", sentences: 14, allowLists: true,
    budget: "a menu is a list; that is what was asked for" },
  { path: "help", say: "help", sentences: 14, allowLists: true, budget: "same as menu" },
  { path: "streak", say: "streak" },

  // ── COACHING QUESTIONS — the old advice handlers, the biggest wall risk ─────
  { path: "advice · belly fat", say: "how do I lose belly fat", sentences: 6,
    budget: "a real question deserves a real answer — but six sentences, not sixteen" },
  { path: "advice · alcohol", say: "can I drink alcohol", sentences: 6, budget: "as above" },
  { path: "advice · plateau", say: "I am not losing weight", sentences: 6, budget: "as above" },
  { path: "advice · supplements", say: "should I take creatine", sentences: 6, budget: "as above" },
  { path: "advice · what to eat", say: "what should I eat for lunch", sentences: 6, budget: "as above" },

  // ── EMOTIONAL — must stay warm; brevity is not coldness ────────────────────
  { path: "mood · stressed", say: "I am stressed", sentences: 5,
    budget: "hear them, one thing to do, one door back — never a numbered protocol" },
  { path: "mood · giving up", say: "I feel like giving up", sentences: 5, budget: "as above" },
  { path: "injury", say: "my knee is sore", sentences: 5,
    budget: "what to do now, what to avoid, when to see someone" },

  // ── FOOD SIDE PATHS ────────────────────────────────────────────────────────
  { path: "food · swap", say: "they didnt have chicken at the shop", sentences: 3,
    budget: "the swap, and what it costs them — nothing else" },
  { path: "food · undo", say: "delete my last meal" },
  { path: "food · meal log", say: "I had pap and chicken", sentences: 3,
    budget: "the confirmation plus at most one remark about the same plate" },
  { path: "food · one meal ask", say: "what should I eat for lunch", sentences: 4,
    budget: "naming food takes a sentence or two — and this must NOT be the 3-day plan" },
  { path: "food · meal plan", say: "meal plan", sentences: 90, allowLists: true,
    allowSplit: "a 3-day plan is a document; they asked for it by name",
    numbersWereAskedFor: "a meal plan without kcal and protein per meal is not a meal plan",
    budget: "they asked for the plan — the plan is the answer" },
  { path: "food · water advice", say: "how much water should I drink", sentences: 3,
    budget: "the target and how to log it" },
  { path: "food · supplements", say: "should I take creatine", sentences: 4,
    budget: "verdict, dose, what to buy" },

  // ── REFERENCE & ADMIN — asked for by name ──────────────────────────────────
  { path: "exercise · form guide", say: "how do I squat properly", sentences: 22, allowLists: true,
    budget: "a which-machine-is-yours card: each variant needs a spot-it and a do-it line" },
  { path: "admin · referral", say: "referral", sentences: 6, allowLists: true,
    budget: "the code, the message they forward, and what they get — the forwardable text is the product" },
  { path: "admin · billing", say: "how do I pay", sentences: 3, budget: "where, how much, cancel terms" },
  { path: "admin · reminders", say: "remind me to drink water", sentences: 3,
    budget: "the question back, with examples of the answer" },
  { path: "admin · equipment ask", say: "what equipment do I need", sentences: 3,
    budget: "either an answer or an honest 'say that again' — never a wall" },
];

/** One conversation per swept path, judged by the shape rules under slice 5. */
const SWEEP_CONVERSATIONS: Conversation[] = SWEEP.map(row => ({
  name: `sweep · ${row.path}`,
  why: row.budget || "the coaching default: two sentences, one next move",
  user: row.user,
  turns: [{
    say: row.say,
    checks: [
      asSlice(5, neverSilent),
      ...(row.allowSplit ? [] : [asSlice(5, oneMessage)]),
      asSlice(5, atMostSentences(row.sentences ?? 2)),
      ...(row.numbersWereAskedFor ? [] : [asSlice(5, noReceipt)]),
      ...(row.allowLists ? [] : [asSlice(5, noLists)]),
      buttonsOnlyAnswerAQuestion,
      noLecture,
    ],
  }],
}));

CONVERSATIONS.push(...SWEEP_CONVERSATIONS);

// ─────────────────────────────────────────────────────────────────────────────
// STATIC ASSERTIONS — the ones that read the source rather than a reply.
// ─────────────────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

type StaticCheck = { slice: Slice; label: string; run: () => string | null };

const STATIC_CHECKS: StaticCheck[] = [
  {
    slice: 1,
    label: "shadow_replies table exists",
    run: () => (/pgTable\(\s*\n?\s*"shadow_replies"/.test(readFileSync("shared/schema.ts", "utf-8"))
      ? null : "no shadow_replies table in shared/schema.ts"),
  },
  {
    // A staging mode with one unguarded door is not a staging mode. These are the four files
    // check-reach.ts declares as able to put a message in front of a client.
    slice: 1,
    label: "every client-facing door is shadow-guarded",
    run: () => {
      const doors = [
        "server/routes/whatsapp.ts",       // sendFinal — every reply
        "server/scheduler/shared.ts",      // sendWhatsApp + templates — every proactive
        "server/twilio-interactive.ts",    // button/list payloads
      ];
      const unguarded = doors.filter(f => !/shadowDoor\(/.test(readFileSync(f, "utf-8")));
      return unguarded.length === 0 ? null : `unguarded: ${unguarded.join(", ")}`;
    },
  },
  {
    // Slice 3's first deliverable, asserted where it lives. A voice rule that is not in the
    // prompt is not a rule — it is a paragraph in a document, which is the thing the
    // architecture guard was written to stop being the answer.
    slice: 3,
    label: "the engine prompt carries the voice rules",
    run: () => {
      const src = readFileSync("server/understanding/meaning-engine.ts", "utf-8");
      const required: Array<[RegExp, string]> = [
        [/NEVER PRINT A RECEIPT ON A LOG/i, "no receipt on a log"],
        [/ECHO THEIR NUMBER EXACTLY/i, "echo their number, never invent"],
        [/TWO SENTENCES\. ONE NEXT MOVE/i, "≤2 sentences, one next move"],
        // Whitespace-tolerant: the prompt is a wrapped template literal, so a rule can sit
        // across a line break. The first version of this check read a real rule as missing.
        [/NO\s+bullet points,\s*NO\s+numbered lists/i, "no lists"],
        [/THEIR WORDS, NOT THE SCANNER'S/i, "their words, not scanner words"],
      ];
      const missing = required.filter(([re]) => !re.test(src)).map(([, name]) => name);
      return missing.length === 0 ? null : `voice rules absent from the engine prompt: ${missing.join(", ")}`;
    },
  },
  {
    // "Black coffee logged ☕" (2026-08-05, found live by the founder, missed by this file).
    //
    // THE CASE THAT WAS SKIPPED. The coffee-photo conversation is needsLLM, so it never ran
    // offline, and the defect was a word the VISION MODEL emits only sometimes — so even the
    // LLM tier would have needed several runs to catch it. A behavioural case cannot reliably
    // test a non-deterministic mouth.
    //
    // So this asserts the SCRUB instead of the symptom: whatever the model writes, the photo
    // reply is built from a string that has been through stripFoodLoggedClaim. That is
    // deterministic, runs on every PR, and cannot be defeated by sampling.
    slice: 4,
    label: "the photo path scrubs a model-written 'logged' claim",
    run: () => {
      const src = readFileSync("server/handlers/media.ts", "utf-8");
      if (!/const visionDisplay = stripFoodLoggedClaim\(/.test(src)) {
        return "visionDisplay is not scrubbed at source — a model-written 'logged' can reach a client";
      }
      // And the scrubber must still do its job.
      const cleaned = stripFoodLoggedClaim("Black coffee logged ☕");
      return /logged/i.test(cleaned) ? `stripFoodLoggedClaim left "logged" in: "${cleaned}"` : null;
    },
  },
  {
    // THE CONTRADICTION GUARD (2026-08-05, found on the founder's phone, not by this file).
    //
    // The prompt told the model two opposite things in one system message: Constitution Law 14
    // "WHEN YOU CALL A TOOL, YOU STILL WRITE THE SENTENCE", and forty lines below it the action
    // directive's "when you call a tool you do NOT also write prose". The model obeyed the
    // second, so every log came back as the executor's template — "5,000 steps logged." — and
    // the coach the whole rebuild was for never got to speak.
    //
    // Nothing offline could catch it: the CI seam scripts a NON-EMPTY reply, so the one case
    // that matters (a tool call with no words) could not occur in a test. So the assertion is
    // on the prompt itself, where the defect actually lives.
    slice: 4,
    label: "the prompt never tells the coach to stay silent on a tool call",
    run: () => {
      const src = readFileSync("server/understanding/actions.ts", "utf-8");
      const directive = src.slice(src.indexOf("export const ACTION_DIRECTIVE"));
      const banned = [/do NOT also write prose/i, /don'?t reply in words/i, /without (?:any )?prose/i];
      const hit = banned.filter(re => re.test(directive.split("`")[1] || ""));
      if (hit.length) return `the action directive silences the coach: ${hit.join(", ")}`;
      return /YOU STILL WRITE THE SENTENCE/i.test(directive)
        ? null
        : "the action directive no longer requires a sentence with every tool call";
    },
  },
  {
    // The card, asserted as reachability rather than as pixels. A renderer nobody calls cannot
    // put a macro bar in front of a client, and that is the property the spec actually names:
    // no calories, no macro bars, no "under target", no running totals on the card.
    slice: 3,
    label: "no production path renders the dashboard card",
    run: () => {
      const callers = [...walk("server")]
        .filter(f => !f.endsWith("macro-card.ts"))
        .filter(f => /\brenderMacroCard\s*\(/.test(readFileSync(f, "utf-8")));
      return callers.length === 0 ? null : `still rendered by: ${callers.join(", ")}`;
    },
  },
  {
    // SLICE 4's STRUCTURAL GATE MOVED OUT (2026-08-04, founder's call). The authorship count
    // lived here and was the one red left when every behavioural check went green. It is a
    // BUDGET, and budgets are owned by check-architecture.ts, which knows how to freeze one and
    // refuse a rise. Keeping a structural number in a behavioural verifier meant the gauntlet
    // could never go green for a reason that had nothing to do with what a client hears.
    //
    // What stays here is the property that actually protects the client, tested end to end and
    // not by counting: the reply is one message, two sentences, their numbers, their words, no
    // receipt. Those are the 70 assertions above.
    //
    // The count itself is NOT dropped — it is `authorship:` on every test run, frozen at 440,
    // and it may only fall. Slice 4b is the teardown that lowers it.
    slice: 4,
    label: "the never-silent fallback has ONE owner",
    run: () => {
      // The floor the architecture allows: engine, crisis pre-layer, never-silent line. This
      // asserts the third one did not quietly become thirty again — every log path must reach
      // the same function rather than growing its own voice back.
      const owners = [...walk("server")]
        .filter(f => /neverSilentLine\s*\(/.test(readFileSync(f, "utf-8")))
        .filter(f => !f.endsWith("reply-hygiene.ts"));
      const missing = ["server/handlers/steps.ts", "server/handlers/water.ts",
                       "server/handlers/weight.ts", "server/handlers/food-scanner.ts"]
        .filter(f => !owners.includes(f));
      return missing.length === 0 ? null : `log paths not using the one fallback: ${missing.join(", ")}`;
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// THE RUNNER
// ─────────────────────────────────────────────────────────────────────────────

type Tally = { green: number; red: number };

async function main() {
  const { handleMessage } = await import("../server/routes");
  const runLLM = process.env.GAUNTLET_LLM === "1";

  const tally: Record<Slice, Tally> = { 1: { green: 0, red: 0 }, 2: { green: 0, red: 0 }, 3: { green: 0, red: 0 }, 4: { green: 0, red: 0 }, 5: { green: 0, red: 0 } };
  const failures: string[] = [];
  const skipped: string[] = [];

  const record = (slice: Slice, reason: string | null, where: string, label: string, reply?: string) => {
    if (reason === null) { tally[slice].green++; return; }
    tally[slice].red++;
    failures.push(
      `✗ [slice ${slice}] ${where}\n    ${label}: ${reason}` +
      (reply !== undefined ? `\n    reply: ${JSON.stringify(reply.slice(0, 240))}` : ""),
    );
  };

  for (const convo of CONVERSATIONS) {
    if (convo.needsLLM && !runLLM) {
      skipped.push(`⊘ ${convo.name} — needs a real model + network (GAUNTLET_LLM=1). ${convo.turns.reduce((n, t) => n + t.checks.length, 0)} assertions not evaluated.`);
      continue;
    }
    // One stub client per conversation; turns mutate it, exactly as production would.
    (globalThis as any).__KAMLIFE_STUB_USER = { ...BASE_USER, ...(convo.user || {}) };
    // Under GAUNTLET_LLM=1 the real model answers and the script is deliberately ignored —
    // otherwise the expensive tier would be quietly grading the same stub as the cheap one.
    (globalThis as any).__KAMLIFE_STUB_ENGINE = runLLM ? undefined : convo.script;
    const restoreEnv: Array<[string, string | undefined]> = [];
    for (const [k, v] of Object.entries(convo.env || {})) {
      restoreEnv.push([k, process.env[k]]);
      process.env[k] = v;
    }
    const saidSoFar: string[] = [];

    for (const [i, turn] of convo.turns.entries()) {
      const where = `${convo.name} · turn ${i + 1}: ${JSON.stringify(turn.say || "[photo]")}`;
      saidSoFar.push(turn.say);
      let reply = "";
      try {
        reply = await handleMessage(BASE_USER.phoneNumber, turn.say, turn.media);
      } catch (err: any) {
        for (const c of turn.checks) record(c.slice, `THREW: ${String(err?.message || err).slice(0, 160)}`, where, c.label);
        continue;
      }
      if (runLLM) console.log(`\n  ▸ ${JSON.stringify(turn.say || "[photo]")}\n    → ${JSON.stringify(reply)}`);
      for (const c of turn.checks) record(c.slice, c.run({ reply, saidSoFar }), where, c.label, reply);
    }
    for (const [k, v] of restoreEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    (globalThis as any).__KAMLIFE_STUB_ENGINE = undefined;
  }

  for (const s of STATIC_CHECKS) record(s.slice, s.run(), "static", s.label);

  // ── The report ────────────────────────────────────────────────────────────
  const line = "─".repeat(72);
  console.log(`\n${line}\nTHE GAUNTLET${runLLM ? "" : "  (offline tier — no model, no network)"}\n${line}`);

  if (failures.length > 0) console.log(`\n${failures.join("\n\n")}\n`);
  if (skipped.length > 0) console.log(`\n${skipped.join("\n")}\n`);

  let allGreen = true;
  for (const s of [1, 2, 3, 4, 5] as Slice[]) {
    const t = tally[s];
    const total = t.green + t.red;
    if (total === 0) continue;
    if (t.red > 0) allGreen = false;
    const mark = t.red === 0 ? "✅" : "🔴";
    console.log(`${mark} SLICE ${s} — ${SLICE_NAMES[s]}: ${t.green}/${total} green`);
  }

  // Slice 1 owns the verifier itself. If ITS assertions are red, the instrument is broken and
  // nothing the other three columns say can be believed.
  if (tally[1].red > 0) {
    console.log(`\n💥 SLICE 1 IS RED. The verifier itself is broken — fix this before reading anything above.\n`);
    process.exit(1);
  }

  if (allGreen) {
    console.log(`\n✅ FULLY GREEN. This is the gate for the live flip (Slice 5).\n`);
    process.exit(0);
  }

  console.log(
    `\n🔴 RED — and on Slices 2-4 that is currently the CORRECT result.\n` +
    `   The verifier works: it is detecting the known defects in the build as it stands.\n` +
    `   Each slice's gate is its own column turning green with no other column going red.\n`,
  );
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
