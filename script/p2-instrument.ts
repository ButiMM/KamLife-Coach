/**
 * P2 INSTRUMENT — coaching quality measurement. P2-A: the mechanism, and nothing else.
 *
 * (2026-08-11, P2 measurement brief. Authorized scope: P2-A only.)
 *
 * WHAT THIS DOES NOT DO, ON PURPOSE
 *   It does not score Coach K. It cannot, yet, and that is the design. Brief §10 puts human
 *   calibration BEFORE automated scoring, and §12 forbids the system that writes the replies
 *   from being the authority on whether they are good. So this ships in a state where every
 *   judgement dimension is locked, and the lock only opens when a human has anchored it.
 *
 *   It also changes nothing about Coach K. §Rule: "No coaching-code changes are authorized by
 *   this document." Nothing in P2-A imports a handler, drives the pipeline, or writes a row.
 *
 * WHAT IT DOES
 *   --status      (default) what is measurable, what is blocked, and what is missing.
 *   --calibrate   emit the founder's calibration sheet from the corpus.
 *   --baseline    run the baseline. Refuses, loudly, until the anchors exist.
 *
 * THE TWO HALVES, AND WHY THE SPLIT MATTERS
 *   Deterministic: facts about a reply that need no opinion — reuses the shipped predicate
 *   rather than re-deciding, per §6 ("should not duplicate machine checks unnecessarily").
 *   Judgement: Understanding, Humanity, Accountability, and coaching value. Human, anchored.
 *
 *   Continuity sits across the line. §5 wants it checked against stored state and provenance
 *   rather than reviewer preference — which requires the Turn Ledger, which a WhatsApp export
 *   does not carry. P2-A reports that honestly as UNAVAILABLE instead of quietly substituting
 *   a heuristic and calling it provenance. A guess dressed as a machine check is worse than no
 *   machine check, because it looks like evidence.
 *
 * Run: npx tsx script/p2-instrument.ts [--status|--calibrate|--baseline] [--corpus <dir>]
 */

import { readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { endsWithHandback } from "../server/reply-hygiene";
import {
  loadConversationFile, scoreableTurns, precedingMemberTurn, loadManifest,
  CONVERSATION_TYPES, TYPE_NOTES, MANIFEST_PATH,
  type Conversation, type Turn, type ConversationType,
} from "./p2-corpus";
import { selectTurns, STRATA } from "./p2-select";
import {
  loadAnchors, anchorCoverage, assertScoreable, DIMENSIONS, CONVERSATION_DIMENSION,
  ANCHOR_PATH, type ScoreTarget,
} from "./p2-anchors";

const CORPUS_DIR = argValue("--corpus") || "p2-work/corpus";
const OUT_DIR = "p2-work";

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC OBSERVATIONS — facts, not scores
// ─────────────────────────────────────────────────────────────────────────────

export type Availability = "OK" | "UNAVAILABLE";

export interface TurnObservation {
  conversationId: string;
  turnIndex: number;
  memberMessage: string;
  coachReply: string;
  /** §6 — reuses the shipped HANDBACK_QUESTION predicate. A hand-back is an Actionability floor. */
  endsWithHandback: boolean;
  /**
   * The coach said substantially this before, in this conversation. Deterministic (normalised
   * string equality), and it maps to a failure cluster the brief names by hand: "repeated advice
   * instead of adaptation". Evidence for a human score, never a score itself.
   */
  repeatsEarlierReply: number | null;
  /**
   * §5's provenance check. UNAVAILABLE for every export-sourced corpus, with the reason stated
   * rather than left for someone to infer from a blank column.
   */
  continuityProvenance: { status: Availability; reason: string };
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export function observe(conv: Conversation, turn: Turn): TurnObservation {
  const member = precedingMemberTurn(conv, turn);
  const earlier = conv.turns
    .filter(t => t.speaker === "coach" && t.index < turn.index)
    .find(t => normalise(t.message) === normalise(turn.message) && normalise(turn.message).length > 25);
  return {
    conversationId: conv.conversationId,
    turnIndex: turn.index,
    memberMessage: member?.message ?? "",
    coachReply: turn.message,
    endsWithHandback: endsWithHandback(turn.message),
    repeatsEarlierReply: earlier ? earlier.index : null,
    continuityProvenance: {
      status: "UNAVAILABLE",
      reason: `corpus adapter "${conv.source.adapter}" carries no Turn Ledger — state read and mutations are not recoverable from a transcript`,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CORPUS
// ─────────────────────────────────────────────────────────────────────────────

function loadCorpus(dir: string): Conversation[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /\.(txt|md|log)$/i.test(f))
    .map(f => loadConversationFile(join(dir, f), { coachSender: process.env.P2_COACH_SENDER || "" }));
}

// ─────────────────────────────────────────────────────────────────────────────
// MODES
// ─────────────────────────────────────────────────────────────────────────────

function status(convs: Conversation[]): void {
  const store = loadAnchors();
  const cov = anchorCoverage(store);
  const turns = convs.flatMap(c => scoreableTurns(c).map(t => observe(c, t)));

  console.log("\nP2 INSTRUMENT — STATUS\n");
  console.log(`corpus:        ${convs.length} conversation(s), ${turns.length} scoreable coach turn(s)`);
  console.log(`corpus dir:    ${CORPUS_DIR}${existsSync(CORPUS_DIR) ? "" : "  (does not exist yet)"}`);
  console.log(`anchor store:  ${ANCHOR_PATH} — ${store.anchors.length} anchor(s), ${store.ambiguities.length} recorded ambiguity/ies`);

  console.log("\nDETERMINISTIC (runs today, no anchors needed):");
  if (turns.length) {
    const hb = turns.filter(t => t.endsWithHandback).length;
    const rp = turns.filter(t => t.repeatsEarlierReply !== null).length;
    console.log(`  actionability floor — replies ending in a hand-back: ${hb}/${turns.length}`);
    console.log(`  verbatim repeats of an earlier reply:                ${rp}/${turns.length}`);
  } else {
    console.log("  (no corpus loaded — nothing to observe)");
  }
  console.log(`  continuity provenance:  UNAVAILABLE for every transcript corpus`);
  console.log(`    reason: a WhatsApp export carries no Turn Ledger. §5's provenance check needs`);
  console.log(`    state_read / mutations, which only exist in the database. Reported as unavailable`);
  console.log(`    rather than replaced by a heuristic. Continuity is human-scored for this baseline.`);

  console.log("\nJUDGEMENT (locked until anchored — brief §10, §12):");
  for (const c of cov) {
    const mark = c.complete ? "UNLOCKED" : "LOCKED  ";
    const detail = c.complete ? `anchored at ${c.have.join(", ")}` : `missing anchor(s) for level ${c.missing.join(", ")}`;
    console.log(`  ${mark} ${String(c.target).padEnd(14)} ${detail}`);
  }

  const blocked = cov.filter(c => !c.complete);
  console.log("");
  if (blocked.length) {
    console.log("WAITING FOR FOUNDER CALIBRATION.");
    console.log(`${blocked.length} of ${cov.length} targets have no human anchors. The instrument will not`);
    console.log("score them, and there is no flag to make it. Next step:");
    console.log("");
    console.log("  1. put conversations in " + CORPUS_DIR + "  (WhatsApp export or pasted transcript)");
    console.log("  2. npx tsx script/p2-instrument.ts --calibrate");
    console.log("  3. score the sheet by hand, together");
    console.log("  4. the agreed examples become " + ANCHOR_PATH);
    console.log("");
  } else {
    console.log("All targets anchored. --baseline is available.");
  }
}

function calibrate(convs: Conversation[]): void {
  if (!convs.length) {
    console.error(`P2: no conversations found in ${CORPUS_DIR}.`);
    console.error(`  Drop a WhatsApp export (.txt) or a pasted transcript there and run again.`);
    console.error(`  For a WhatsApp export, set P2_COACH_SENDER to the exact sender name Coach K posts under —`);
    console.error(`  the adapter refuses to guess which side is the coach.`);
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, "calibration-sheet.md");
  const quota = Number(argValue("--turns") || 25);
  const manifest = loadManifest();
  const typeOf = new Map<string, ConversationType>();
  for (const e of manifest?.conversations || []) {
    const match = convs.find(c => c.conversationId.endsWith(e.file));
    if (match) typeOf.set(match.conversationId, e.type);
  }
  const sel = selectTurns(convs, quota);
  const rows: string[] = [];

  rows.push("# P2 CALIBRATION SHEET");
  rows.push("");
  rows.push(`${sel.chosen.length} turns from ${convs.length} conversations. The instrument has scored nothing —`);
  rows.push("this sheet is the ground truth, not a draft to correct.");
  rows.push("");
  rows.push("## How to score");
  rows.push("");
  rows.push("Looking at a Coach K reply, the question is **not** \"is this a good AI response?\" It is:");
  rows.push("");
  rows.push("> If I were the member paying R199/month, did this interaction make me feel understood");
  rows.push("> and give me something useful to do next?");
  rows.push("");
  rows.push("and, separately, at the end of each conversation:");
  rows.push("");
  rows.push("> Would I want this coach available to me tomorrow?");
  rows.push("");
  rows.push("The member does not care that the classifier was 95%, the mutation was correct, or the");
  rows.push("reply passed a regex. Those make the product reliable. They are not what is being scored here.");
  rows.push("");
  rows.push("**Do not try to make the scores look balanced.** If a reply is a 2, give it a 2. If everything");
  rows.push("you score lands on 4-5, that is a finding about the standard, not a problem with the sheet.");
  rows.push("");
  rows.push("**If you are genuinely torn — 3 or 4 — do not force it.** Put `?` in the score column and say why.");
  rows.push("A recorded ambiguity is worth more than an invented number, and those cases are exactly what");
  rows.push("has to be resolved before anything is automated (brief §11).");
  rows.push("");
  rows.push("A reason is required for every 1 and every 5. Those become the anchors, so write them as an");
  rows.push("explanation of the standard to someone who has never seen it — which is precisely their job.");
  rows.push("");
  rows.push("## How these turns were chosen");
  rows.push("");
  rows.push("Selection spans the axes a machine can actually see — hand-backs, verbatim repeats, long and");
  rows.push("terse replies, and turns answering a long member message. It does **not** know which replies");
  rows.push("are good, cold, or context-aware; that is the judgement you are about to make, and if the");
  rows.push("selector could make it there would be no need for this sheet. Every conversation contributes");
  rows.push("a turn before any contributes a second, so the longest chat cannot take over.");
  rows.push("");
  rows.push("| stratum | in corpus | note |");
  rows.push("|---|---|---|");
  for (const s of STRATA) rows.push(`| ${s} | ${sel.strataCounts[s]} | |`);
  rows.push("");

  let n = 0;
  for (const conv of convs) {
    const mine = sel.chosen.filter(c => c.conversation === conv);
    if (!mine.length) continue;
    const t = typeOf.get(conv.conversationId);
    rows.push(`---`);
    rows.push("");
    rows.push(`## ${t ? `[${t}] ` : ""}${conv.conversationId}`);
    rows.push("");
    rows.push(`_${mine.length} of ${scoreableTurns(conv).length} coach turns selected. Participant: ${conv.participant}._`);
    if (!t) rows.push(`_No type declared in ${MANIFEST_PATH}._`);
    rows.push("");
    for (const c of mine) {
      const o = observe(conv, c.turn);
      n++;
      rows.push(`### ${n}. turn ${c.turn.index}  —  _${c.stratum}_`);
      rows.push("");
      rows.push(`**Member:** ${o.memberMessage.replace(/\n/g, "  \n") || "_(none)_"}`);
      rows.push("");
      rows.push(`**Coach K:** ${o.coachReply.replace(/\n/g, "  \n")}`);
      rows.push("");
      rows.push(`_Facts, not scores: ${c.why}; continuity provenance UNAVAILABLE (transcript corpus, no Turn Ledger)._`);
      rows.push("");
      rows.push("| dimension | 1-5 or ? | reason (required for 1 and 5) |");
      rows.push("|---|---|---|");
      for (const d of DIMENSIONS) rows.push(`| ${d} | | |`);
      rows.push("");
    }
    rows.push(`#### conversation-level — ${CONVERSATION_DIMENSION}`);
    rows.push("");
    rows.push("Would you want this coach available to you tomorrow? Coaching value, not a retention prediction.");
    rows.push("");
    rows.push("| target | 1-5 or ? | reason |");
    rows.push("|---|---|---|");
    rows.push(`| ${CONVERSATION_DIMENSION} | | |`);
    rows.push("");
  }

  writeFileSync(out, rows.join("\n"));

  console.log(`\nP2: calibration sheet written to ${out}`);
  console.log(`  ${sel.chosen.length} turns selected from ${convs.reduce((a, c) => a + scoreableTurns(c).length, 0)} available, across ${convs.length} conversation(s).`);
  console.log("");
  console.log("  spread:");
  for (const s of STRATA) {
    const got = sel.chosen.filter(c => c.stratum === s).length;
    if (sel.strataCounts[s]) console.log(`    ${s.padEnd(12)} ${String(got).padStart(3)} chosen of ${sel.strataCounts[s]} in corpus`);
  }
  const thin = sel.perConversation.filter(p => p.chosen === 0);
  if (thin.length) console.log(`\n  NOT REPRESENTED: ${thin.map(p => p.conversationId).join(", ")}`);

  reportTypeCoverage(manifest, convs, typeOf);

  console.log(`  Nothing has been scored. ${OUT_DIR}/ is gitignored — it holds real conversations.`);
  console.log("");
  console.log("WAITING FOR FOUNDER CALIBRATION.");
  console.log("");
}

/**
 * The ten types are the point of P2-B — a calibration set that only covers ordinary logs will
 * produce anchors that only hold for ordinary logs. Missing types are named, loudly, but do not
 * block: the founder may not have a clean example of every situation to hand, and a sheet for
 * eight types beats no sheet while the other two are found.
 */
function reportTypeCoverage(manifest: ReturnType<typeof loadManifest>, convs: Conversation[], typeOf: Map<string, ConversationType>): void {
  console.log("");
  if (!manifest) {
    console.log(`  NO MANIFEST at ${MANIFEST_PATH} — conversations are unlabelled.`);
    console.log(`  The ten situation types are declared by you, never guessed: a classifier deciding`);
    console.log(`  what a conversation is about would be the instrument choosing its own exam.`);
    console.log("");
    for (const t of CONVERSATION_TYPES) console.log(`    ${t.padEnd(20)} ${TYPE_NOTES[t]}`);
    console.log("");
    return;
  }
  const covered = new Set(typeOf.values());
  const missing = CONVERSATION_TYPES.filter(t => !covered.has(t));
  console.log(`  type coverage: ${covered.size}/${CONVERSATION_TYPES.length}`);
  if (missing.length) {
    console.log(`  MISSING:`);
    for (const t of missing) console.log(`    ${t.padEnd(20)} ${TYPE_NOTES[t]}`);
  }
  const unmatched = (manifest.conversations || []).filter(e => !convs.some(c => c.conversationId.endsWith(e.file)));
  if (unmatched.length) console.log(`  manifest names files not in the corpus: ${unmatched.map(u => u.file).join(", ")}`);
  console.log("");
}

function baseline(convs: Conversation[]): void {
  const store = loadAnchors();
  const targets: ScoreTarget[] = [...DIMENSIONS, CONVERSATION_DIMENSION];
  const missing = anchorCoverage(store).filter(c => !c.complete);

  if (missing.length) {
    console.error("\nP2: BASELINE REFUSED.\n");
    console.error(`${missing.length} of ${targets.length} targets have no human anchors:`);
    for (const m of missing) console.error(`  ${String(m.target).padEnd(14)} missing level ${m.missing.join(", ")}`);
    console.error("");
    console.error("Brief §10: the founder hand-scores a calibration set BEFORE the instrument produces");
    console.error("a larger baseline. §12: the system that writes the replies is not the authority on");
    console.error("whether they are good. A baseline built on anchors this instrument invented would be");
    console.error("the circularity P2 exists to eliminate, with a table around it.");
    console.error("");
    console.error("  npx tsx script/p2-instrument.ts --calibrate");
    console.error("");
    process.exit(3);
  }

  // Unreachable until anchors exist. Left as an explicit stop rather than a half-built scorer:
  // P2-C is a separate step in the brief's sequence and its design depends on what calibration
  // actually reveals. Guessing at it now would be building against an imagined rubric.
  for (const t of targets) assertScoreable(t, store);
  console.log("\nP2: anchors present for every target. Scoring is P2-C and is not built yet —");
  console.log("by design: how to score follows from what calibration reveals, not the other way round.\n");
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const convs = (() => {
  try {
    return loadCorpus(CORPUS_DIR);
  } catch (e) {
    console.error(`\nP2: could not load the corpus — ${(e as Error).message}\n`);
    process.exit(2);
  }
})();

const mode = process.argv.find(a => ["--status", "--calibrate", "--baseline"].includes(a)) || "--status";
if (mode === "--calibrate") calibrate(convs);
else if (mode === "--baseline") baseline(convs);
else status(convs);
