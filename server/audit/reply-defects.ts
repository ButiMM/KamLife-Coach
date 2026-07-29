/**
 * REPLY DEFECT SCANNER — the thing that should have found today's bugs, not the founder.
 *
 * (2026-07-27.) Six defects reached production in two threads and were caught by a human
 * reading WhatsApp screenshots on a Monday evening: a reply that renamed his food, a reply
 * that offered him dinner in the message confirming his dinner, a reply that said "that's
 * the protein box ticked" and "16g more to go" in one breath, and "Teach me" answered with
 * a fruit swap list. Each one is mechanically detectable from the reply text alone.
 *
 * The existing replay harness (server/eval/replay.ts) can't find these: it asks an LLM judge
 * whether the new engine beats production on CONVERSATIONAL turns, and its SKIP_INTENT list
 * deliberately excludes FOOD_LOG, WORKOUT, STEP_ and WATER_ — which is exactly where all six
 * lived. This is the complement: no model, no cost, no judgement calls. Just "does this reply
 * contradict itself, invent something, or answer a question nobody asked".
 *
 * Every detector below is tied to a failure that actually shipped. Adding a detector is how a
 * defect gets closed for good rather than closed at one call site — which was the real
 * pattern behind all of today's bugs.
 *
 * Pure — no DB, no clock, no model. Unit-tested. Run over history: npm run audit:replies
 */

import { isBareReaction, readsAsTherapySpeak } from "../reaction-guard";
import { hasDeadPromise } from "../reply-hygiene";
import { inventedQualifiers } from "../food-naming";

export interface ReplyDefect {
  code: string;
  detail: string;
}

export interface AuditTurn {
  messageIn: string;
  messageOut: string;
  intent?: string | null;
}

/** Completion phrases that describe a FINISHED day, not a good meal. */
const PROTEIN_DONE_RE = /\b(protein (?:sorted|locked in|done)|protein box ticked|protein target (?:hit|met|reached))\b/i;
/** …paired with an explicit "still owing" statement in the same reply. */
const PROTEIN_OWING_RE = /\b(\d{1,3})\s*g\s+(?:protein\s+)?(?:more to go|still (?:needed|to go)|left to hit|short|to go)\b/i;

/** Offers of a meal the client has just been told they logged. */
const OFFERS_MEAL_RE = /\b(room for a full dinner|one more solid meal|one high-protein meal|finish it with a protein-heavy dinner|one protein meal left|last meal|strip dinner down|make dinner strict)\b/i;
const LOGGED_DINNER_RE = /\*\s*(?:dinner|supper)\s*:\s*~?\d/i;

/** The help/onboarding block. Legitimate for a greeting or a help ask; nothing else. */
const MENU_DUMP_RE = /what you can send me:/i;
const HELP_ASK_RE = /^\s*(menu|help|hi|hello|hey|start|options|commands|what can you do|sawubona|molo|dumela)\b/i;

const REMOVAL_WORDS_RE = /\b(remove|delete|undo|scrap|erase|unlog|take (?:it|that|them|this) out|take out|get rid of|don'?t log|cancel)\b/i;
const CLAIMS_NOTHING_REMOVED_RE = /\bnothing removed\b/i;

const CAPABILITY_LIE_RE = /\bi\s*(?:'?m|am)?\s*(?:really |just |sorry,? |afraid )?(?:can'?t|cannot|unable to)\s+(?:\w+\s+){0,2}?(?:view|see|look at|process|analy[sz]e|open|read)\s+(?:\w+\s+){0,3}?(?:pictures?|images?|photos?|pics?|videos?|screenshots?)\b/i;

/** Told to train when the client's own message reports a session already done today. */
const TELLS_TO_TRAIN_RE = /\b(training day|reply \*?workout\*?|let'?s get it done|time to train|your session'?s ready)\b/i;
const REPORTS_TRAINED_TODAY_RE = /\b(?:trained|worked out|went to the gym|hit the gym|first (?:day|session) back|did my (?:workout|session))\b/i;
const FUTURE_OR_NEGATED_RE = /\b(will|going to|want to|plan to|tomorrow|didn'?t|couldn'?t|missed|skip)\b/i;

/**
 * A food the coach could not price. This is the ONLY honest measure of whether the food
 * database is too small (2026-07-27: the founder challenged the "add more foods" plan against
 * a reviewer note — "deeper, not wider" and "invest in recognition ACCURACY". He was right, and
 * this makes the question answerable instead of arguable. Note it is not a defect in the reply:
 * naming what it could not price is CORRECT behaviour — it is a coverage counter.)
 */
const UNPRICED_RE = /could not price \*([^*]+)\*/i;

/** A food name in the reply that carries detail the client's message never contained. */
const LOGGED_LINE_RE = /(?:^|\n)\s*✅?\s*\*?Logged:?\*?\s*([^\n]+)/i;

/**
 * Scan one production turn for defects that are decidable from the text.
 * Conservative by design: a detector that fires on healthy replies is worse than useless,
 * because it trains everyone to ignore the report.
 */
export function scanReply(turn: AuditTurn): ReplyDefect[] {
  const inMsg = turn.messageIn || "";
  const out = turn.messageOut || "";
  const found: ReplyDefect[] = [];
  if (!out.trim()) return found;

  // 1. "That's the protein box ticked. 16g more to go today."
  const owing = PROTEIN_OWING_RE.exec(out);
  if (PROTEIN_DONE_RE.test(out) && owing && Number(owing[1]) > 0) {
    found.push({ code: "protein-contradiction", detail: `claims protein done, then says ${owing[1]}g still to go` });
  }

  // 2. "Still room for a full dinner" — inside the reply that logged dinner.
  if (LOGGED_DINNER_RE.test(out) && OFFERS_MEAL_RE.test(out)) {
    found.push({ code: "meal-offered-after-logging", detail: "offers another meal in the reply confirming that meal" });
  }

  // 3. Food the client never named ("Rice" → "Brown rice", "Tin fish" → "Pilchards in…").
  const loggedLine = LOGGED_LINE_RE.exec(out);
  if (loggedLine) {
    const names = loggedLine[1].split(/[,—|]/).map(s => s.replace(/[*_~]/g, "").trim()).filter(Boolean);
    for (const name of names) {
      if (/\d/.test(name)) continue;                       // "~719 kcal" is not a food name
      const invented = inventedQualifiers(inMsg, name);
      if (invented.length > 0) {
        found.push({ code: "invented-food", detail: `logged "${name}" — client never said "${invented.join('", "')}"` });
      }
    }
  }

  // 4. A bare reaction answered with a feelings diagnosis.
  if (isBareReaction(inMsg) && readsAsTherapySpeak(out)) {
    found.push({ code: "therapy-speak-to-reaction", detail: `"${inMsg.trim()}" answered with emotion-labelling` });
  }

  // 5. The help block sent to someone who did not ask for help.
  if (MENU_DUMP_RE.test(out) && inMsg.trim() && !HELP_ASK_RE.test(inMsg.trim())) {
    found.push({ code: "menu-dump", detail: `full help menu returned to "${inMsg.trim().slice(0, 40)}"` });
  }

  // 6. "Nothing removed" to someone who never asked to remove anything.
  if (CLAIMS_NOTHING_REMOVED_RE.test(out) && !REMOVAL_WORDS_RE.test(inMsg)) {
    found.push({ code: "removal-nonsequitur", detail: "answers a removal request the client never made" });
  }

  // 7. Claiming it cannot read photos — the product runs on photos.
  if (CAPABILITY_LIE_RE.test(out)) {
    found.push({ code: "capability-lie", detail: "claims it cannot read images" });
  }

  // 8. Told to train after reporting a session done today.
  if (REPORTS_TRAINED_TODAY_RE.test(inMsg) && !FUTURE_OR_NEGATED_RE.test(inMsg) && TELLS_TO_TRAIN_RE.test(out)) {
    found.push({ code: "train-after-session", detail: "tells them to train when they just reported training" });
  }

  // 9. A promise nothing will keep ("I'll check in later", "I'll remind you").
  if (hasDeadPromise(out)) {
    found.push({ code: "dead-promise", detail: "promises a follow-up nothing will deliver" });
  }

  // 10. Coverage counter — the coach behaved correctly, but a food was missing from the DB.
  const unpriced = UNPRICED_RE.exec(out);
  if (unpriced) {
    found.push({ code: "food-not-in-database", detail: `could not price "${unpriced[1].trim()}"` });
  }

  // 11. The same claim printed twice — reads as a glitch.
  const hitCount = (out.match(/protein target (?:hit|met|reached)/gi) || []).length;
  if (hitCount > 1) {
    found.push({ code: "duplicate-claim", detail: `"protein target hit" printed ${hitCount} times` });
  }

  // 12. THE SAME INSTRUCTION, TWICE, IN DIFFERENT WORDS.
  //
  // (2026-07-29.) This is the defect that kept coming back all night — "eat a protein meal" said
  // by the text head, the day assessment, the nudge, the card band and the card footer, none of
  // which knew the others existed. It was fixed three times, each time at the one call site in
  // front of us, because detector 11 above only ever looked for the literal string "protein
  // target hit". That is an instance detector wearing a class detector's name.
  //
  // This one is about SHAPE, not vocabulary: two imperative sentences that share their meaningful
  // words are the same order in a different hat, whichever component emitted them.
  const dup = repeatedInstruction(out);
  if (dup) found.push({ code: "repeated-instruction", detail: dup });

  return found;
}

// Verb-first, or carrying one of the action verbs this coach actually uses.
const INSTRUCTION_RE = /^(?:add|eat|get|make|keep|log|walk|drink|grill|have|go|send|stand|tell|finish|hit|push|swap|rest|do)\b|\b(?:add|eat|get|make|keep|log|walk|drink|grill) (?:a|an|one|your|some|it|more|today)\b/i;

// Words that carry no instruction meaning — two sentences sharing only these are not duplicates.
const FILLER = new Set(["today","your","that","this","with","from","have","just","some","them","then","take","into","next","more","much","only","also","what","when","will","been","they","their","about","after","before","every","still","room","thing","things","need","needs","make","makes","doing","done"]);

/** The shape of an instruction: its meaningful words, lowercased and deduplicated. */
function instructionShape(sentence: string): Set<string> {
  const words = sentence.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 3 && !FILLER.has(w));
  return new Set(words);
}

/**
 * Two instructions in one reply that mean the same thing. Returns a description, or "".
 * Deliberately conservative — a detector that fires on healthy replies trains everyone to
 * ignore the report, which is how detector 11 ended up useless.
 */
export function repeatedInstruction(reply: string): string {
  const sentences = (reply || "")
    .replace(/\[(?:MEDIA|BUTTONS):[^\]]*\]/g, " ")   // markers are not sentences
    .split(/(?:\n+|(?<=[.!?])\s+)/)
    .map(x => x.replace(/[*_~`]/g, "").trim())
    .filter(x => x.length > 12 && INSTRUCTION_RE.test(x));

  for (let i = 0; i < sentences.length; i++) {
    for (let j = i + 1; j < sentences.length; j++) {
      const a = instructionShape(sentences[i]), b = instructionShape(sentences[j]);
      if (a.size < 2 || b.size < 2) continue;
      const shared = [...a].filter(w => b.has(w));
      if (shared.length >= 2) {
        return `"${sentences[i].slice(0, 48)}" and "${sentences[j].slice(0, 48)}" are the same instruction`;
      }
    }
  }
  return "";
}

/** Roll a batch of turns into counts per defect code, worst first. */
export function summarise(turns: AuditTurn[]): {
  scanned: number; clean: number; defects: number;
  byCode: Array<{ code: string; count: number; examples: Array<{ in: string; out: string; detail: string }> }>;
} {
  const byCode = new Map<string, { count: number; examples: Array<{ in: string; out: string; detail: string }> }>();
  let defects = 0, clean = 0;

  for (const t of turns) {
    const hits = scanReply(t);
    if (hits.length === 0) { clean++; continue; }
    defects++;
    for (const h of hits) {
      const row = byCode.get(h.code) || { count: 0, examples: [] };
      row.count++;
      if (row.examples.length < 3) {
        row.examples.push({ in: (t.messageIn || "").slice(0, 90), out: (t.messageOut || "").slice(0, 140), detail: h.detail });
      }
      byCode.set(h.code, row);
    }
  }

  return {
    scanned: turns.length, clean, defects,
    byCode: [...byCode.entries()].map(([code, v]) => ({ code, ...v })).sort((a, b) => b.count - a.count),
  };
}
