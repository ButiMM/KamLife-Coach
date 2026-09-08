/**
 * NORMALIZER FIDELITY — may this rewrite speak for the client? (2026-08-10, Work Order 1.)
 *
 * The normalizer rewrites messy phrasing into the canonical forms the deterministic handlers
 * were built for. That is the right idea and it is why a bare "Lunch / Tin fish / Rice" logs
 * correctly. But a rewrite REPLACES the client's words before any handler sees them, so a bad
 * rewrite is not a bad guess — it is the client's message being destroyed in transit.
 *
 * The Reality Test found both halves of that on one run:
 *
 *   J5  "Actually no, that was yesterday. And it wasn't rice, it was pap. And I had spinach too."
 *       → "i had tin fish, pap, spinach and mixed veggies for lunch yesterday"
 *       Tin fish and mixed veggies were INVENTED. The correction framing was destroyed, so the
 *       mutation engine never saw it and the turn was logged as a fresh retro meal. The chicken
 *       was dropped because a fresh log has nothing to retain.
 *
 *   J4  "…I'm feeling a bit useless honestly, and tonight there's a family thing with lots of
 *        food. What do I do about tonight?"
 *       → "i had pap and beef stew for supper yesterday"
 *       The question and the emotion were discarded pre-routing. Nothing downstream could answer
 *       a question it never received.
 *
 * So this is the gate: the rewrite must be a FAITHFUL restatement or it does not run at all.
 * Failing closed costs a rewrite; failing open costs the client's words. There is no version of
 * this product where the second trade is correct.
 *
 * Pure — no DB, no model, no routing. Every rule here is unit-tested, because the canonical
 * application had NO offline coverage before today, which is exactly how both defects shipped.
 *
 * ONE OWNER, on purpose. routes.ts already carries six inline brakes, each added the day a
 * specific rewrite hurt someone (invented numbers, invented goals, retro dates, repeats,
 * historical weights, reasoning-vocabulary totals). They work, and they are not moved in this
 * work order because that is refactoring beyond the order. The payback is named in the raise:
 * they belong here, and this file is where the seventh one must not go.
 */

import { planCorrection, isMealDateMove } from "./food-identity-correction";
import { isRetroactiveMeal, looksLikeQuestion } from "./utils";
import { carriesFeelingClause } from "./unlogged-notice";
import { parseMessyIntake } from "./understanding/messy-intake";

export interface Fidelity {
  /** May the canonical replace the client's message? */
  ok: boolean;
  /** Why not — logged verbatim, so a dropped rewrite is never a mystery. */
  reason: string;
}

/** The production front-door dial. Unset is live; only the explicit killswitch disables it. */
export function normalizerLive(): boolean {
  return process.env.NORMALIZER !== "off";
}

// "Did they tell us how they feel?" and "is this a question?" both already have owners —
// carriesFeelingClause (shared with the unlogged-food notice) and looksLikeQuestion. This file
// asks them rather than keeping a second copy of either, so a miss is fixed in one place. The
// first draft of this gate carried its own two patterns; that was two ways to be wrong.

// Words a canonical is MADE of. Everything else it says is a claim about what the client ate,
// did, or wants — and every one of those has to be traceable to their own words.
//
// THIS SET USED TO CARRY MEANING, AND THAT WAS THE HOLE (#234).
//
// It also held `breakfast lunch dinner supper snack meal`, `today yesterday morning afternoon
// evening night tonight`, `steps step workout session training gym`, `change goal muscle gain fat
// loss recomposition`, `kg kgs calories calorie protein`, `same repeat copy again` and
// `did do done`. Exempting a word from the invention check says it carries no claim. Every one of
// those carries a claim, so the check waved through exactly the rewrites that matter most:
//
//     "I had a pear"              -> "i had a pear for breakfast"      a meal slot, invented
//     "I trained"                 -> "i trained yesterday"             a day, invented
//     "had eggs"                  -> "i had eggs in the morning"       a time, invented
//     "I was busy"                -> "i did my workout"                a session that never happened
//     "I want to build a bit"     -> "change my goal to muscle gain"   a goal change never asked for
//     "I didn't train"            -> "i did my workout"                the client's NO, reversed
//
// All six were ALLOWED before this cut and all six are measured in the acceptance. What remains
// here is syntax: pronouns, auxiliaries, articles, prepositions, conjunctions. A word that could
// finish the sentence "the client told us ___" does not belong in this set.
const STRUCTURE = new Set([
  "i", "im", "i'm", "id", "i'd", "ill", "i'll", "had", "have", "has", "ate", "eat", "eating",
  "was", "were", "is", "are", "am", "for", "and", "or", "a", "an", "the",
  "some", "of", "with", "my", "me", "to", "it", "that", "this", "at", "on", "in", "plus", "as",
  "gonna", "going", "will", "be", "get", "got", "just", "then", "also", "too", "about", "s",
]);

/**
 * WHEN-WORDS, kept as a named class rather than an exemption.
 *
 * They must trace like anything else, with ONE authorisation: a raw message the retro-meal owner
 * already reads as historical may be restated with a day word it does not literally contain —
 * "I had pap last night" → "…yesterday" is that owner's translation of the client's own timing,
 * not the normalizer inventing a day. `isRetroactiveMeal` is that owner and is asked here rather
 * than re-implemented.
 */
const WHEN = new Set([
  "today", "yesterday", "tomorrow", "morning", "afternoon", "evening", "night", "tonight",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/**
 * The signs of a client saying something did NOT happen.
 *
 * A closed token set rather than a pattern, for the same reason the food constraint owner uses one:
 * a set is read against `words()`, which already strips the apostrophe — so "didn't" arrives as
 * "didn" and is listed as such rather than needing a pattern to anticipate every spelling of it.
 * It also keeps this file's regex count where it was; the budget is not raised for a brake.
 *
 * `workout.ts` holds NEGATED_SESSION for a NARROWER question — did the client negate a training
 * session — and is deliberately not merged with this. That one decides whether to log; this one
 * decides whether a rewrite may speak. Folding them would give one owner two jobs.
 */
const NEGATORS = new Set([
  "no", "not", "never", "none", "without", "skipped", "missed", "failed", "forgot", "couldnt",
  "didn", "dont", "doesnt", "havent", "hasnt", "hadnt", "wasnt", "werent", "isnt", "arent",
  "wont", "cant", "couldn", "shouldnt", "wouldnt", "nothing", "neither", "nor",
]);
/**
 * A negation the CLIENT is making about their own action.
 *
 * "you missed the black coffee yesterday" negates the COACH's logging, not the client's eating —
 * they are correcting our record and the food really was eaten. Reading that as "the client says
 * it did not happen" rejected an honest rewrite, which the recorded corpus caught immediately. So
 * a negator directly after "you" is the client talking about us, and is not their No.
 */
const negates = (s: string): boolean => {
  const ws = words(s);
  return ws.some((w, i) => NEGATORS.has(w) && !["you", "u", "your", "youre", "ur"].includes(ws[i - 1] || ""));
};

/**
 * What a LOOKUP names. A message that is only a question discards nothing by becoming a canonical
 * command — "how many calories do I have left?" → "today's calories" is routing, not testimony,
 * and rule 2 already says so. These words may therefore appear in such a canonical without
 * tracing, because they name what is being ASKED FOR rather than claiming what the client did.
 * Deliberately narrow, and only ever reachable when the canonical reports nothing itself, so
 * "what should I eat?" → "i had pap for lunch" stays blocked.
 */
const LOOKUP = new Set([
  "today", "calories", "calorie", "protein", "steps", "step", "weight", "kg", "kgs",
  "left", "total", "totals", "remaining",
]);

// Canonicalisation the classifier is explicitly asked to do (see the prompt in gpt.ts). These are
// translations, not inventions, so a mapped word traces to the original it came from.
const TRANSLATIONS: Record<string, string[]> = {
  pap: ["ipapa", "papa", "phutu", "putu"],
  meat: ["nyama", "nama"],
  bread: ["isonka", "brood"],
  eggs: ["amaqanda", "mazai", "eier"],
  chicken: ["inkukhu", "kgoho", "hoender"],
  // A MEAL SLOT NAMED IN ANOTHER LANGUAGE IS STILL THE CLIENT NAMING IT (#234).
  // "Nditye isonka namaqanda kusasa" states the slot; only the language differs.
  breakfast: ["kusasa", "ekuseni", "ontbyt"],
};

const words = (s: string): string[] =>
  (s || "").toLowerCase()
    .replace(/'s\b/g, "")            // a possessive is not a claim: "today's calories" adds nothing
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/).filter(Boolean);

/**
 * Irregular forms of one verb. Morphology, not meaning: a client who wrote "done" and a canonical
 * that says "did" are making the same claim, and the stemmer below cannot see that.
 */
const FORMS: Record<string, string[]> = {
  did: ["do", "done", "doing"],
  done: ["do", "did", "doing"],
  doing: ["do", "did", "done"],
  ate: ["eat", "eaten", "eating"],
  had: ["have", "has", "having"],
};

/** Does this canonical word trace back to something the client actually wrote? */
function traces(word: string, originalLower: string): boolean {
  if (word.length < 3) return true;                          // too short to be a claim on its own
  if (originalLower.includes(word)) return true;
  // veggies/veggie, eggs/egg, trained/train, training/train — the same claim in another form is
  // not a new claim. Widened from `s|es` only, so that tightening STRUCTURE does not start
  // blocking honest paraphrase along with the inventions.
  for (const stem of [word.replace(/(?:es|s)$/, ""), word.replace(/(?:ed|ing)$/, "")]) {
    if (stem.length >= 3 && originalLower.includes(stem)) return true;
  }
  for (const src of FORMS[word] || []) if (originalLower.includes(src)) return true;
  for (const src of TRANSLATIONS[word] || []) if (originalLower.includes(src)) return true;
  // A TYPO IS STILL THE CLIENT'S WORD (#234). "Luch / Tin fish / Rice" → "…for lunch" is the
  // flagship case this gate was built to ALLOW: they wrote the meal slot, they misspelled it.
  // Tightening STRUCTURE made that a strict-trace question for the first time, so one edit of
  // slack is the difference between reading a typo and inventing a meal. Bounded deliberately:
  // distance 1, words of four letters or more, so it can forgive a slip and not a different word.
  if (word.length >= 4) {
    for (const raw of originalLower.split(/[^a-z]+/)) {
      if (raw.length >= 4 && withinOneEdit(word, raw)) return true;
    }
  }
  return false;
}

/** True when one insertion, deletion or substitution turns `a` into `b`. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0, j = 0, edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (short.length === long.length) { i++; j++; } else { j++; }
  }
  return edits + (long.length - j) + (short.length - i) <= 1;
}

/**
 * The gate. `ok: false` means the ORIGINAL message proceeds untouched — never a partial rewrite,
 * because half a rewrite is the same defect with a smaller blast radius.
 */
export function normalizerFidelity(original: string, canonical: string): Fidelity {
  const orig = String(original || "");
  const canon = String(canonical || "").trim();
  if (!canon) return { ok: false, reason: "no canonical" };

  const origLower = orig.toLowerCase();
  const canonLower = canon.toLowerCase();

  // 1. A CORRECTION IS NOT A LOG. Detected on the RAW text, before any rewrite can hide the
  //    framing, so "actually no, that was yesterday…" reaches the mutation engine that owns it.
  const plan = planCorrection(orig, isMealDateMove(orig, isRetroactiveMeal(orig)));
  if (plan.isCorrection) return { ok: false, reason: "raw text is a CORRECTION — the mutation engine owns this turn" };

  // 2. A QUESTION RIDING WITH FACTS. A message that is ONLY a question may normalise into a
  //    lookup ("how many calories left" → "today's calories") — nothing is discarded there. But
  //    when the client reports things AND asks something, a canonical that keeps only the report
  //    has thrown the question away, and no handler downstream can answer what it never got.
  const carriesFacts = orig.split(/[.!?]|\band\b/i).filter(c => c.trim().length > 12).length > 1;
  if (looksLikeQuestion(orig) && carriesFacts && !looksLikeQuestion(canon)) {
    return { ok: false, reason: "original asks a question alongside facts; canonical drops the question" };
  }

  // 3. EMOTION IS CONTENT. If they told us how they feel, a bare log is not a restatement of
  //    what they said.
  if (carriesFeelingClause(orig) && !carriesFeelingClause(canon)) {
    return { ok: false, reason: "original carries emotion; canonical drops it" };
  }

  // 4. NOTHING DROPPED FROM A MIXED NOTE (live 16:02 / 16:21). Classifier picks STEPS or
  //    FOOD_LOG, rewrites to that one fact, and the other half never reaches a handler.
  //    "walked 8000 and had pap" becoming "i walked 8000 steps" is a faithful-looking rewrite
  //    that still destroys the meal. Invention check below cannot see a deletion.
  const origIntents = parseMessyIntake(orig);
  const canonIntents = parseMessyIntake(canon);
  if (origIntents.hasFoodReport && !canonIntents.hasFoodReport) {
    return { ok: false, reason: "original reports food; canonical drops the meal" };
  }
  if ((origIntents.hasStepsReport || origIntents.stepCount != null)
      && !(canonIntents.hasStepsReport || canonIntents.stepCount != null)) {
    return { ok: false, reason: "original reports steps; canonical drops the walk" };
  }

  // 5. THE CLIENT'S "NO" SURVIVES (#234). A rewrite that drops the negation reverses what
  //    happened: "I didn't train" → "i did my workout" logged a session they had just told us
  //    they did not do. Every word in that canonical traced — "did" to "didn't", "train" to
  //    "train" — so the invention check could never have caught it. Negation is not a word, it is
  //    the sign of the claim.
  if (negates(orig) && !negates(canon)) {
    return { ok: false, reason: "original negates; canonical asserts it happened" };
  }

  // 6. A STATEMENT IS NOT A QUESTION (#234). Rule 2 stops a question being flattened into a log.
  //    This is the other direction: a canonical that ASKS something the client did not ask puts
  //    words in their mouth and sends the coach off answering itself.
  if (looksLikeQuestion(canon) && !looksLikeQuestion(orig)) {
    return { ok: false, reason: "canonical asks a question the client did not ask" };
  }

  // 7. NOTHING INVENTED. Every claim in the canonical must trace to the client's own words.
  //
  //    The ONE authorised addition is a day word on a message the retro-meal owner already reads
  //    as historical: "I had pap last night" → "…yesterday" is that owner restating the client's
  //    own timing. Everything else — a meal slot, a time of day, a day on a message with no
  //    timing in it at all — has to come from the client.
  const retroAuthorised = isRetroactiveMeal(orig);
  // Only when the client ASKED and the canonical claims nothing of its own.
  const canonReports = canonIntents.hasFoodReport || canonIntents.hasStepsReport
    || canonIntents.stepCount != null;
  const lookupAuthorised = looksLikeQuestion(orig) && !carriesFacts && !canonReports;
  for (const w of words(canonLower)) {
    if (STRUCTURE.has(w) || /^\d+$/.test(w)) continue;        // numbers have their own brake
    if (traces(w, origLower)) continue;
    if (WHEN.has(w) && retroAuthorised) continue;
    if (LOOKUP.has(w) && lookupAuthorised) continue;
    return { ok: false, reason: `canonical invents "${w}"` };
  }

  return { ok: true, reason: "faithful" };
}
