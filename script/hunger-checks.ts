/**
 * Test-only predicates for the hunger gauntlet. Pure, no imports, no side effects — which is the
 * point: the gauntlet itself sets env and imports the server at module scope, so its checks could
 * never be unit-tested in place. A mechanical checker that nothing checks is how a gate silently
 * stops gating, and the A4 gate had already sprung 13 holes before anyone looked.
 */

/**
 * Protein framed as something to DO — the A4 failure condition, for a client already at target.
 *
 * The first cut was `/(more|increase|up your|raise your|add more|boost)[^.!?]{0,30}protein/i`,
 * which only caught the verb-then-noun word order. Probed against twenty natural coaching
 * phrasings it caught seven. "let's get your protein up", "try a protein shake", "prioritise
 * protein at lunch" and "have some protein with your snack" all walked through — every one of
 * them the exact failure A4 exists to detect.
 *
 * What must still PASS is the reply we actually want: naming the number and ruling protein OUT.
 * "your protein is 118g against 120g, so that is not what is driving this" quotes protein twice
 * and is the correct answer. So this matches PRESCRIPTIVE shapes only, and a prescription inside
 * a negation ("more food, not more protein") is exempted rather than scored as a failure.
 */
const PRESCRIPTION = new RegExp([
  // A. an intensifier or verb pointing AT protein
  String.raw`\b(more|extra|increase|raise|boost|bump|push|lift|top ?up|up your|prioriti[sz]e|focus on|add|include|aim for|try|grab|swap in|work in|squeeze in|pack in)\b[^.!?;]{0,35}\bprotein\b`,
  // B. protein pointed upward
  String.raw`\bprotein\b[^.!?;]{0,25}\b(up|higher|a bit more|a little more|to \d{2,4} ?g)\b`,
  // C. protein as a thing to consume
  String.raw`\bprotein\s+(shake|source|powder|bar|snack|serving|portion|hit)\b`,
  // D. the soft prescription, which reads as advice without a single verb from A
  String.raw`\bsome protein\b`,
  String.raw`\bprotein\b[^.!?;]{0,20}\b(in|with|at) (every|each) meal\b`,
  // E. protein named, then raised via a PRONOUN. This is the shape the live failure actually
  // took — "Your protein is almost on target, but let's boost it a bit" — and it escaped both
  // the original gate and the first fix, because the noun and the verb never touch. Clause
  // punctuation bounds the window, so the referent cannot be some other sentence's subject.
  String.raw`\bprotein\b[^.!?;]{0,70}\b(boost|bump|push|raise|increase|lift|nudge|get|bring|take|top)\s+(it|that|this|them)\b`,
].join("|"), "i");

/**
 * Negation in the run-up to the word "protein" — "more food, not more protein", "rather than
 * protein". Anchored on the noun rather than on the start of the match, because the match can
 * begin at an intensifier that sits BEFORE the negation ("More food, not more protein" matches
 * from the first "More"), which would put the negation inside the match and hide it.
 */
const NEGATION = /\b(not|isn'?t|is not|aren'?t|rather than|instead of|no need for|won'?t be|nothing to do with)\b/i;

/**
 * Returns the offending phrase, or null if the reply never prescribes protein.
 * Every match is checked for a negation just before the noun, so ruling protein out cannot be
 * scored as recommending it.
 */
export function prescribesProtein(reply: string): string | null {
  const re = new RegExp(PRESCRIPTION.source, "gi");
  for (const m of reply.matchAll(re)) {
    const nounAt = m.index + Math.max(0, m[0].toLowerCase().indexOf("protein"));
    if (NEGATION.test(reply.slice(Math.max(0, nounAt - 30), nounAt))) continue;
    return m[0];
  }
  return null;
}
