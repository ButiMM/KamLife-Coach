/**
 * P2-C MEASUREMENT — read out the coach we actually have, against the founder's standard.
 *
 * (2026-08-11. Authorized scope: measurement only. No coaching-code changes.)
 *
 * TWO LAYERS, AND THE REASON THEY ARE SEPARATE
 *
 * P2-B's cluster frequencies were quoted out of the 25-turn calibration sheet. That sheet was
 * selected for SPREAD — it deliberately over-samples rare strata so the anchors reach the edges.
 * Frequencies taken from it are therefore biased BY CONSTRUCTION and are not a population
 * estimate. Quoting them as "11 of 19 turns hand the work back" reads like a rate. It is not one.
 *
 * So this file measures twice:
 *
 *   POPULATION  — every coach turn in the corpus, deterministic checks only. Unbiased, because
 *                 nothing was selected. This is where a RATE may honestly be quoted.
 *   SAMPLE      — the 19 coaching turns of the calibration sheet, human-scored against the
 *                 anchors. Rich, and NOT representative. Distributions only, never rates.
 *
 * WHY THE SCORING IS BY HAND
 *
 * Automated scoring would need a model call. The instrument currently makes none, which is what
 * makes the Phase 2 answer to "is client data ever sent to a third party?" a structural no rather
 * than a promise (docs/p2/README.md). That property may only die by explicit decision. So P2-C
 * scores are recorded as data in docs/p2/scores.json, each with a reason, each auditable against
 * the anchor it was judged by.
 *
 * WHO SCORED THEM
 *
 * The anchors are founder-scored. These per-turn scores are NOT: they are Claude applying the
 * founder's written standard, and every row says so. They are a proposed measurement the founder
 * can overturn turn by turn — not ground truth. The distinction is load-bearing and is printed.
 *
 * Run: npx tsx script/p2-measure.ts
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { endsWithHandback } from "../server/reply-hygiene";
import { loadConversationFile, scoreableTurns, type Conversation } from "./p2-corpus";
import { loadAnchors, anchorCoverage, DIMENSIONS, CONVERSATION_DIMENSION, type ScoreTarget } from "./p2-anchors";

const CORPUS_DIR = "p2-work/corpus";
const SCORES_PATH = "docs/p2/scores.json";

type Score = number | "UNRESOLVED";
interface TurnScore { sheetId: number; conversationId: string; excluded?: string; scores: Record<string, Score>; notes?: string }
interface ConvScore { conversationId: string; coaching_value: Score; reason: string }
interface Scores { scoredBy: string; scoredAt: string; turns: TurnScore[]; conversations: ConvScore[] }

// ─────────────────────────────────────────────────────────────────────────────
// POPULATION LAYER — deterministic, every coach turn, no selection
// ─────────────────────────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Truncation, conservatively. Only the dangling-terminator class is machine-detectable: a reply
 * whose last visible character opens something it never delivers. The mid-sentence splice
 * ("You're doing great on tracking! specific. 👌") is real but not reliably detectable, so it is
 * counted by hand and reported separately rather than folded into this number.
 */
function looksTruncated(conv: Conversation, turn: { index: number; message: string }): boolean {
  const t = turn.message.trim().replace(/[*_`]+$/, "").trim();
  if (!/[:—-]$/.test(t) || t.length <= 12) return false;
  // A dangling colon is NOT a truncation when the thing it introduces is the next message —
  // "*Today's food log (4 meals):*" followed by the meal-card image is working as designed.
  // Checking the successor turned 9 apparent truncations into 3 real ones; a detector that
  // stops at the terminator is measuring punctuation, not delivery.
  const next = conv.turns[turn.index + 1];
  if (next && next.speaker === "coach" && /omitted/i.test(next.message)) return false;
  return true;
}

/** Placeholders and transport errors that reached the member as if they were a reply. */
const INFRA = [
  { name: "listening placeholder", re: /^🎤/ },
  { name: "build artifact", re: /^🚀/ },
  { name: "twilio transport error", re: /Twilio Sandbox|not connected to a Sandbox/i },
];

function population(convs: Conversation[]) {
  const turns = convs.flatMap(c => scoreableTurns(c).map(t => ({ c, t })));
  const infra = turns.filter(({ t }) => INFRA.some(i => i.re.test(t.message.trim())));
  const infraSet = new Set(infra.map(x => x.t));
  const coaching = turns.filter(({ t }) => !infraSet.has(t));

  const handback = coaching.filter(({ t }) => endsWithHandback(t.message));
  const truncated = turns.filter(({ c, t }) => looksTruncated(c, t));
  const repeats = coaching.filter(({ c, t }) =>
    c.turns.some(p => p.speaker === "coach" && p.index < t.index && norm(p.message) === norm(t.message) && norm(t.message).length > 25));

  return { total: turns.length, infra, infraSet, coaching, handback, truncated, repeats };
}

// ─────────────────────────────────────────────────────────────────────────────

const convs: Conversation[] = existsSync(CORPUS_DIR)
  ? readdirSync(CORPUS_DIR).filter(f => /\.txt$/.test(f)).sort()
      .map(f => loadConversationFile(join(CORPUS_DIR, f), { coachSender: process.env.P2_COACH_SENDER || "Kamlife Coach" }))
  : [];

if (!convs.length) { console.error(`P2-C: no corpus in ${CORPUS_DIR}. Nothing to measure.`); process.exit(2); }
if (!existsSync(SCORES_PATH)) { console.error(`P2-C: no scores at ${SCORES_PATH}.`); process.exit(2); }

const scores: Scores = JSON.parse(readFileSync(SCORES_PATH, "utf-8"));
const store = loadAnchors();
const cov = anchorCoverage(store);
const pop = population(convs);

console.log("\n" + "=".repeat(78));
console.log("P2-C MEASUREMENT — Coach K against the founder's P2-B standard");
console.log("=".repeat(78));

console.log(`\ncorpus: ${convs.length} conversations, ${pop.total} coach turns (2026-08-05 → 08-11)`);
console.log(`scored by: ${scores.scoredBy}`);
console.log(`             ^ NOT founder-scored. A proposed measurement, auditable per turn.`);

// ---- 1. POPULATION -----------------------------------------------------------
console.log("\n── 1. POPULATION LAYER — every coach turn, deterministic, unbiased ──\n");
const pct = (n: number, d: number) => `${n}/${d} (${Math.round(100 * n / d)}%)`;
console.log(`  infrastructure artifacts sent as replies   ${pct(pop.infra.length, pop.total)}`);
for (const i of INFRA) {
  const n = pop.infra.filter(x => i.re.test(x.t.message.trim())).length;
  if (n) console.log(`      ${i.name.padEnd(28)} ${n}`);
}
console.log(`  coaching turns (population denominator)    ${pop.coaching.length}`);
console.log(`  C1  ends by handing the work back          ${pct(pop.handback.length, pop.coaching.length)}`);
console.log(`  C3  verbatim repeat of an earlier reply    ${pct(pop.repeats.length, pop.coaching.length)}`);
console.log(`  --  truncated (dangling terminator only)   ${pct(pop.truncated.length, pop.total)}`);
console.log(`\n  These are RATES. Nothing was selected, so they estimate the product's behaviour.`);
console.log(`  C2, C4, C5, C6 are not machine-detectable and appear in the sample layer only.`);

// ---- 2. SAMPLE ---------------------------------------------------------------
console.log("\n── 2. SAMPLE LAYER — 19 coaching turns, human-scored against the anchors ──\n");
console.log("  DISTRIBUTIONS ONLY. The sheet was selected for spread and over-samples rare");
console.log("  strata by design, so these are NOT rates and must not be quoted as percentages.\n");

const scored = scores.turns.filter(t => !t.excluded);
const excluded = scores.turns.filter(t => t.excluded);
console.log(`  scored ${scored.length} turns · excluded ${excluded.length} as infrastructure (principle 18)\n`);

const head = "  dimension        1    2    3    4    5   UNRES   mean(scored)";
console.log(head);
console.log("  " + "-".repeat(head.length - 2));
for (const d of DIMENSIONS) {
  const vals = scored.map(t => t.scores[d]).filter(v => v !== undefined);
  const num = vals.filter(v => typeof v === "number") as number[];
  const unres = vals.filter(v => v === "UNRESOLVED").length;
  const bucket = (n: number) => String(num.filter(v => v === n).length).padStart(3);
  const mean = num.length ? (num.reduce((a, b) => a + b, 0) / num.length).toFixed(2) : "—";
  console.log(`  ${d.padEnd(15)}${bucket(1)}  ${bucket(2)}  ${bucket(3)}  ${bucket(4)}  ${bucket(5)}   ${String(unres).padStart(3)}     ${mean}`);
}

// ---- 3. CONVERSATION LEVEL ---------------------------------------------------
console.log("\n── 3. CONVERSATION-LEVEL COACHING VALUE ──\n");
const cvLocked = !cov.find(c => c.target === CONVERSATION_DIMENSION)!.complete;
if (cvLocked) {
  console.log("  coaching_value is LOCKED at level 5 (no anchor). Scores are therefore CAPPED at 3:");
  console.log("  1 and 3 are anchored and can be judged; nothing may be certified above the highest");
  console.log("  anchored level. A conversation that might exceed 3 is UNRESOLVED, not a 4.\n");
}
for (const c of scores.conversations) {
  const v = typeof c.coaching_value === "number" ? String(c.coaching_value) : "UNRES";
  console.log(`  ${c.conversationId}  ${v.padStart(5)}   ${c.reason}`);
}
const cvNums = scores.conversations.map(c => c.coaching_value).filter(v => typeof v === "number") as number[];
const cvUnres = scores.conversations.filter(c => c.coaching_value === "UNRESOLVED").length;
console.log(`\n  scored ${cvNums.length}/${scores.conversations.length}  ·  UNRESOLVED ${cvUnres}  ·  none above 3  ·  highest observed ${Math.max(...cvNums)}`);

// ---- 4. ANCHOR COVERAGE ------------------------------------------------------
console.log("\n── 4. ANCHOR COVERAGE ──\n");
for (const c of cov) {
  const obs = store.anchors.filter(a => a.target === c.target && a.provenance === "observed").length;
  const spec = store.anchors.filter(a => a.target === c.target && a.provenance === "specified").length;
  console.log(`  ${(c.complete ? "UNLOCKED" : "LOCKED  ")} ${String(c.target).padEnd(15)} observed=${obs} specified=${spec}` +
    (c.complete ? "" : `  missing level ${c.missing.join(", ")}`));
}
console.log(`\n  continuity provenance: UNAVAILABLE corpus-wide — a transcript carries no Turn Ledger.`);
console.log(`  Continuity was scored ONLY where the transcript itself carries the evidence;`);
console.log(`  otherwise UNRESOLVED. It was never inferred from what the reply sounded like.`);

// ---- 5. AMBIGUITIES ----------------------------------------------------------
console.log("\n── 5. CONTRADICTIONS AND AMBIGUITIES ──\n");
for (const a of store.ambiguities) console.log(`  [${a.target}] ${a.conversationId}${a.turnIndex !== undefined ? ` t${a.turnIndex}` : ""}\n      ${a.note}\n`);

// ---- 6. INFRASTRUCTURE CAUSING COACHING FAILURE ------------------------------
console.log("── 6. INFRASTRUCTURE THAT CAUSED A DOWNSTREAM COACHING FAILURE ──\n");
for (const t of scores.turns.filter(t => t.notes?.includes("INFRA-CAUSED"))) {
  console.log(`  sheet #${t.sheetId} (${t.conversationId}): ${t.notes}`);
}
console.log("");
