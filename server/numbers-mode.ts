/**
 * NUMBERS MODE — the adaptive delivery dial (2026-07-14, Kam: "the bot should be
 * adapting anyway... each client should be different").
 *
 * One product, but each client sees the amount of number they can handle. Most of
 * this market can't read a calorie; a minority (the Cal-AI crowd) love the figures.
 * We don't ask and we don't split into two products — the bot LEARNS:
 *
 *   - a client who signals they don't get numbers (the calorie-confusion handler)
 *     is set to "low": food replies drop the kcal/protein figures entirely and
 *     speak purely in food + plain language.
 *   - the default is "normal": plain verdict leads, numbers ride along as support
 *     (already serves the numbers-lovers — the figures are right there).
 *   - a "low" client who later asks to see the numbers flips back to normal.
 *
 * Stored as a profileNotes token (numbers:low) — same durable, migration-free
 * pattern as sick_until / diet: / walk:. Absence = normal.
 */

export type NumbersMode = "low" | "normal";

export function getNumbersMode(user: any): NumbersMode {
  return /\bnumbers:low\b/i.test(user?.profileNotes || "") ? "low" : "normal";
}

// Strip the "~470 kcal, 10g protein" / "~470 kcal | 10g protein" figures from a
// food-line block, leaving the food name and its plain description intact:
//   "• Pap: ~470 kcal, 10g protein (1 cup)"  →  "• Pap (1 cup)"
//   "• Chicken: ~250 kcal | 30g protein"      →  "• Chicken"
export function stripFoodLineNumbers(foodLines: string): string {
  return (foodLines || "")
    .replace(/:?\s*~?\d[\d,]*\s*kcal\s*[|,]\s*~?\d+\s*g\s*protein/gi, "")
    .replace(/~?\d[\d,]*\s*kcal/gi, "")
    .replace(/~?\d+\s*g\s*protein/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\(/g, " (")
    .replace(/[ \t]+$/gm, "")
    .replace(/:\s*$/gm, "")
    .trim();
}

// Belt-and-braces net for low-numeracy PHOTO replies: the vision prompt already
// tells the model to omit figures, but if a number slips through (model prose, a
// deterministic total line), scrub it so a numbers:low client never sees a figure.
// Deliberately conservative — only touches explicit kcal/calorie/gram-protein/portion
// tokens, and tidies the small dangling artefacts that leaves ("roughly ,").
export function stripNumbersFromProse(text: string): string {
  return (text || "")
    // figure tokens first
    .replace(/~?\s*\d[\d,]*\s*kcal\s*[|,/]?\s*(?:and\s*)?~?\s*\d+\s*g\s*(?:of\s*)?protein/gi, "")
    .replace(/~?\s*\d[\d,]*\s*(?:kcal|calories|cals?)\b/gi, "")
    .replace(/~?\s*\d+\s*g\s*(?:of\s*)?protein/gi, "")
    .replace(/\(\s*~?\s*\d[\d,]*\s*(?:g|ml|grams?)\s*\)/gi, "")
    // clean the connective debris the removals leave behind
    .replace(/:\s*(?:and|is|with|of|at)\b\s*(?=[.,!?;:])/gi, "") // "breast: and." → "breast."
    .replace(/\b(?:roughly|about|approximately|around|is|at|and|with|of)\s*(?=[.,!?;:])/gi, "")
    .replace(/\s+([.,!?;:])/g, "$1")   // pull punctuation back to the word
    .replace(/[,:;]+(?=[.!?])/g, "")   // "slice,." → "slice."
    .replace(/([!?])\.+/g, "$1")        // "spread!." → "spread!"
    .replace(/\.{2,}/g, ".")            // ".." → "."
    .replace(/:\s*(?=$|\n)/gm, "")      // dangling colon at line end
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Words-only protein nudge for low-numeracy clients — never a gram figure.
export function plainProteinNudge(opts: { proteinRemaining: number; isMuscleGain: boolean; hasGoodProteins: boolean }): string {
  const { proteinRemaining, isMuscleGain, hasGoodProteins } = opts;
  if (hasGoodProteins && proteinRemaining <= 0) return "Great protein today — that's the muscle looked after. 💪";
  if (hasGoodProteins) return "Good protein in that one. 👍";
  if (proteinRemaining > 0) {
    return isMuscleGain
      ? "Try to get more protein in your next meal — eggs, chicken, fish, or a shake. That's what builds."
      : "Add a bit more protein to your next meal — eggs, chicken, or fish. It keeps you full and protects your muscle.";
  }
  return "Nicely done. 👍";
}
