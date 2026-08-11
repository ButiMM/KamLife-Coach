/**
 * P2 ANCHOR STORE — the human ground truth, and the lock that stops the machine inventing it.
 *
 * (2026-08-11, P2 measurement brief §10, §11, §12.)
 *
 * THIS FILE EXISTS TO SAY NO.
 *
 * The brief's §12 names the failure mode precisely: "the system that generates Coach K's
 * responses must not be treated as the unquestioned authority on whether those responses are
 * good." The obvious way to build a scoring instrument — have the model score a batch, then ask
 * the founder to check a few — recreates exactly that circularity with a table around it. The
 * model's taste becomes the baseline and the human becomes a rubber stamp on it.
 *
 * So the dependency runs the other way and it is enforced in code, not in a paragraph:
 *
 *   NO DIMENSION MAY BE SCORED UNTIL A HUMAN HAS ANCHORED IT.
 *
 * assertScoreable() throws. It is not a warning that can be read past at 1am, and there is
 * deliberately no override flag — a flag would be used, once, "just to see the shape", and that
 * run would become the baseline everyone quotes.
 *
 * THERE IS NO SEED FUNCTION AND THERE MUST NEVER BE ONE.
 * The founder's instruction was explicit: "Do not generate synthetic calibration examples. The
 * anchor store should initially be empty." An example written by the thing being measured is not
 * evidence of anything. If this file ever grows a `generateExampleAnchors()`, the instrument has
 * been quietly turned back into a mirror.
 *
 * §11: when a later conversation exposes a genuine scoring ambiguity, ADD the case here. Do not
 * edit the rule to make the disagreement disappear — that is how a rubric drifts into whatever
 * is convenient, one reasonable-looking edit at a time.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const ANCHOR_PATH = "docs/p2/anchors.json";

/** The five per-turn dimensions of brief §4–§8, plus the conversation-level judgement of §9. */
export const DIMENSIONS = ["understanding", "continuity", "actionability", "humanity", "accountability"] as const;
export type Dimension = typeof DIMENSIONS[number];

export const CONVERSATION_DIMENSION = "coaching_value" as const;
export type ScoreTarget = Dimension | typeof CONVERSATION_DIMENSION;

/** §4–§9 define 1, 3 and 5. 2 and 4 are usable when scoring; only 1/3/5 need anchors. */
export type Level = 1 | 2 | 3 | 4 | 5;
export const ANCHOR_LEVELS: Level[] = [1, 3, 5];

export interface Anchor {
  target: ScoreTarget;
  level: Level;
  /** Traceability back to the corpus. A finding nobody can locate is not evidence. */
  conversationId: string;
  /** Absent for conversation-level anchors, which describe the whole exchange. */
  turnIndex?: number;
  memberMessage?: string;
  coachReply: string;
  /** §10.4 — why this is a 1 or a 5. The reason is the rubric; the score alone teaches nothing. */
  reason: string;
  scoredBy: string;
  scoredAt: string;
}

export interface AnchorStore {
  version: 1;
  /** Anchors are the rubric. They are tracked in git on purpose — an untracked rubric is folklore. */
  anchors: Anchor[];
  /**
   * §11 — cases where scoring was genuinely ambiguous. Recorded rather than resolved by fiat,
   * so a future disagreement can be checked against a past one instead of relitigated.
   */
  ambiguities: Array<{ conversationId: string; turnIndex?: number; target: ScoreTarget; note: string; raisedAt: string }>;
}

const EMPTY: AnchorStore = { version: 1, anchors: [], ambiguities: [] };

export function loadAnchors(path = ANCHOR_PATH): AnchorStore {
  if (!existsSync(path)) return { ...EMPTY, anchors: [], ambiguities: [] };
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as AnchorStore;
  if (parsed.version !== 1) throw new Error(`anchor store version ${parsed.version} is not readable by this instrument`);
  return { version: 1, anchors: parsed.anchors || [], ambiguities: parsed.ambiguities || [] };
}

export function saveAnchors(store: AnchorStore, path = ANCHOR_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
}

export interface Coverage {
  target: ScoreTarget;
  have: Level[];
  missing: Level[];
  complete: boolean;
}

/** Which of 1/3/5 each target has a real human example for. */
export function anchorCoverage(store: AnchorStore): Coverage[] {
  const targets: ScoreTarget[] = [...DIMENSIONS, CONVERSATION_DIMENSION];
  return targets.map(target => {
    const have = ANCHOR_LEVELS.filter(l => store.anchors.some(a => a.target === target && a.level === l));
    const missing = ANCHOR_LEVELS.filter(l => !have.includes(l));
    return { target, have, missing, complete: missing.length === 0 };
  });
}

/**
 * The lock. Called before anything produces a score for `target`.
 *
 * Deliberately throws rather than returning false: a boolean gets ignored by a caller in a
 * hurry, and the whole point is that this cannot be hurried past.
 */
export function assertScoreable(target: ScoreTarget, store: AnchorStore = loadAnchors()): void {
  const cov = anchorCoverage(store).find(c => c.target === target)!;
  if (cov.complete) return;
  throw new Error(
    `P2: refusing to score "${target}" — it has no human anchor for level(s) ${cov.missing.join(", ")}.\n` +
    `  The founder anchors a dimension before the instrument scores it (brief §10, §12).\n` +
    `  Run:  npx tsx script/p2-instrument.ts --calibrate\n` +
    `  This is not a bug and there is no flag to skip it.`
  );
}

export function addAnchor(store: AnchorStore, anchor: Anchor): AnchorStore {
  return { ...store, anchors: [...store.anchors, anchor] };
}

export function addAmbiguity(store: AnchorStore, a: AnchorStore["ambiguities"][number]): AnchorStore {
  return { ...store, ambiguities: [...store.ambiguities, a] };
}
