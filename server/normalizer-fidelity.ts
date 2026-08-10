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

export interface Fidelity {
  /** May the canonical replace the client's message? */
  ok: boolean;
  /** Why not — logged verbatim, so a dropped rewrite is never a mystery. */
  reason: string;
}

// "Did they tell us how they feel?" and "is this a question?" both already have owners —
// carriesFeelingClause (shared with the unlogged-food notice) and looksLikeQuestion. This file
// asks them rather than keeping a second copy of either, so a miss is fixed in one place. The
// first draft of this gate carried its own two patterns; that was two ways to be wrong.

// Words a canonical is MADE of. Everything else it says is a claim about what the client ate,
// did, or wants — and every one of those has to be traceable to their own words.
const STRUCTURE = new Set([
  "i", "im", "i'm", "id", "i'd", "ill", "i'll", "had", "have", "has", "ate", "eat", "eating",
  "did", "do", "done", "was", "were", "is", "are", "am", "for", "and", "or", "a", "an", "the",
  "some", "of", "with", "my", "me", "to", "it", "that", "this", "at", "on", "in", "plus", "as",
  "gonna", "going", "will", "be", "get", "got", "just", "then", "also", "too", "about",
  "breakfast", "lunch", "dinner", "supper", "snack", "meal", "today", "yesterday", "morning",
  "afternoon", "evening", "night", "tonight", "steps", "step", "kg", "kgs", "workout", "session",
  "training", "gym", "change", "goal", "muscle", "gain", "fat", "loss", "recomposition",
  "calories", "calorie", "protein", "same", "repeat", "copy", "again", "s",
]);

// Canonicalisation the classifier is explicitly asked to do (see the prompt in gpt.ts). These are
// translations, not inventions, so a mapped word traces to the original it came from.
const TRANSLATIONS: Record<string, string[]> = {
  pap: ["ipapa", "papa", "phutu", "putu"],
  meat: ["nyama", "nama"],
  bread: ["isonka", "brood"],
  eggs: ["amaqanda", "mazai", "eier"],
  chicken: ["inkukhu", "kgoho", "hoender"],
};

const words = (s: string): string[] =>
  (s || "").toLowerCase()
    .replace(/'s\b/g, "")            // a possessive is not a claim: "today's calories" adds nothing
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/).filter(Boolean);

/** Does this canonical word trace back to something the client actually wrote? */
function traces(word: string, originalLower: string): boolean {
  if (word.length < 3) return true;                          // too short to be a claim on its own
  if (originalLower.includes(word)) return true;
  const stem = word.replace(/(?:es|s)$/, "");                // veggies/veggie, eggs/egg
  if (stem.length >= 3 && originalLower.includes(stem)) return true;
  for (const src of TRANSLATIONS[word] || []) if (originalLower.includes(src)) return true;
  return false;
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

  // 4. NOTHING INVENTED. Every claim in the canonical must trace to the client's own words.
  for (const w of words(canonLower)) {
    if (STRUCTURE.has(w) || /^\d+$/.test(w)) continue;        // numbers have their own brake
    if (!traces(w, origLower)) return { ok: false, reason: `canonical invents "${w}"` };
  }

  return { ok: true, reason: "faithful" };
}
