/**
 * P2 TURN SELECTION — choose ~25 turns from ten conversations, for SPREAD not volume.
 *
 * (2026-08-11, founder, P2-B: "We're calibrating turns, not trying to make you spend your entire
 * day grading WhatsApp.")
 *
 * WHAT SELECTION IS ALLOWED TO CLAIM
 *
 * The founder asked for a sample that deliberately includes obvious good responses, obvious bad
 * ones, ambiguous ones, technically-correct-but-cold ones, ones that use context and ones that
 * ignore it. Read that list again: almost none of it is machine-detectable. "Obviously good" is
 * precisely the judgement he is about to make — if this file could find it, P2 would not need him.
 *
 * So selection does the honest half. It spans the axes that ARE facts:
 *
 *   hand-back        — the shipped predicate. A reply that ends by handing the work back.
 *   repeat           — the coach said substantially this earlier in the same conversation.
 *   long reply       — length in words. A lecture is long; so is a thorough answer. Length is
 *                      a fact, "lecture" is a judgement, and only the fact is used here.
 *   terse reply      — very short. Could be crisp, could be dismissive. Same distinction.
 *   hard input       — the MEMBER's message is long or carries several clauses. These are the
 *                      turns where a coach has to think, whatever the reply turned out to be.
 *   ordinary         — everything else. The bulk of the product, and it must not be crowded out
 *                      by the interesting-looking minority.
 *
 * A stratum is NOT a verdict. A long reply is not thereby bad; a hand-back is not automatically
 * a 1. The strata exist so the sheet cannot accidentally be twenty-five ordinary logs, which is
 * what "take the first 25" would produce and what would make the anchors useless at the edges.
 *
 * FAIRNESS ACROSS CONVERSATIONS
 * Every conversation contributes one turn before any contributes a second. Without that rule the
 * longest chat dominates the sheet and the ten types stop being ten types.
 *
 * REPRODUCIBLE
 * No randomness. Same corpus in, same sheet out — an instrument whose sample shifts between runs
 * cannot be argued with, and P2-B exists to be argued with.
 */

import type { Conversation, Turn } from "./p2-corpus";
import { scoreableTurns, precedingMemberTurn } from "./p2-corpus";
import { endsWithHandback } from "../server/reply-hygiene";

/**
 * Order is PRIORITY, most diagnostic first — a turn belongs to the rarest property it has, so a
 * verbatim repeat that also ends in a hand-back is filed as a repeat. Getting this backwards
 * starves the rare strata: the first draft put hand-back first and the smoke corpus reported
 * zero repeats and zero long replies, because the common property swallowed both.
 */
export const STRATA = ["repeat", "long-reply", "hand-back", "hard-input", "terse-reply", "ordinary"] as const;
export type Stratum = typeof STRATA[number];

export interface Candidate {
  conversation: Conversation;
  turn: Turn;
  memberMessage: string;
  stratum: Stratum;
  /** Printed in the sheet and the run log, so the sample can be audited rather than trusted. */
  why: string;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Thresholds are stated as constants so a disagreement is about a number, not a mystery. */
const LONG_REPLY_WORDS = 60;
const TERSE_REPLY_WORDS = 8;
const HARD_INPUT_WORDS = 25;

function classify(conv: Conversation, turn: Turn): { stratum: Stratum; why: string } {
  const member = precedingMemberTurn(conv, turn);
  const memberWords = member ? words(member.message) : 0;
  const replyWords = words(turn.message);

  const repeated = conv.turns.find(t =>
    t.speaker === "coach" && t.index < turn.index &&
    normalise(t.message) === normalise(turn.message) && normalise(turn.message).length > 25);

  // Order matters: the most diagnostic property wins, so a long hand-back is filed as a
  // hand-back. Ordinary is the floor, never a positive claim about the turn.
  if (repeated) return { stratum: "repeat", why: `repeats the reply at turn ${repeated.index} verbatim` };
  if (replyWords >= LONG_REPLY_WORDS) return { stratum: "long-reply", why: `reply is ${replyWords} words` };
  if (endsWithHandback(turn.message)) return { stratum: "hand-back", why: "ends by handing the work back (shipped HANDBACK_QUESTION predicate)" };
  if (memberWords >= HARD_INPUT_WORDS) return { stratum: "hard-input", why: `member message is ${memberWords} words — several things at once` };
  if (replyWords <= TERSE_REPLY_WORDS) return { stratum: "terse-reply", why: `reply is ${replyWords} words` };
  return { stratum: "ordinary", why: "no distinguishing signal — the everyday turn" };
}

export interface Selection {
  chosen: Candidate[];
  /** Every candidate, so the sheet can report what was left out and why the sample looks as it does. */
  strataCounts: Record<Stratum, number>;
  perConversation: Array<{ conversationId: string; available: number; chosen: number }>;
}

export function selectTurns(convs: Conversation[], quota: number): Selection {
  const all: Candidate[] = [];
  for (const conv of convs) {
    for (const turn of scoreableTurns(conv)) {
      const { stratum, why } = classify(conv, turn);
      all.push({ conversation: conv, turn, memberMessage: precedingMemberTurn(conv, turn)?.message ?? "", stratum, why });
    }
  }

  const strataCounts = Object.fromEntries(STRATA.map(s => [s, all.filter(c => c.stratum === s).length])) as Record<Stratum, number>;

  // Round 1 — one turn per conversation, taking its most distinguishing turn so a short
  // conversation still contributes something worth scoring.
  const rank = (s: Stratum) => STRATA.indexOf(s);
  const chosen: Candidate[] = [];
  const taken = new Set<Candidate>();
  for (const conv of convs) {
    const mine = all.filter(c => c.conversation === conv).sort((a, b) => rank(a.stratum) - rank(b.stratum) || a.turn.index - b.turn.index);
    if (mine.length) { chosen.push(mine[0]); taken.add(mine[0]); }
  }

  // Round 2 — always take from the stratum currently HOLDING THE FEWEST SEATS, not from a fixed
  // rotation. A fixed rotation lets the biggest pool win every pass: the first draft filled 14 of
  // 25 seats with hand-backs, which is a sheet about one defect rather than a sheet about coaching.
  // Within the chosen stratum, prefer a conversation that is under-represented so far.
  let guard = 0;
  while (chosen.length < quota && taken.size < all.length && guard++ < 10_000) {
    const seats = (s: Stratum) => chosen.filter(c => c.stratum === s).length;
    const open = STRATA.filter(s => all.some(c => c.stratum === s && !taken.has(c)));
    if (!open.length) break;
    const target = open.reduce((best, s) => (seats(s) < seats(best) ? s : best), open[0]);
    const countFor = (c: Candidate) => chosen.filter(x => x.conversation === c.conversation).length;
    const pool = all.filter(c => c.stratum === target && !taken.has(c))
      .sort((a, b) => countFor(a) - countFor(b) || a.turn.index - b.turn.index);
    chosen.push(pool[0]); taken.add(pool[0]);
  }

  chosen.sort((a, b) =>
    convs.indexOf(a.conversation) - convs.indexOf(b.conversation) || a.turn.index - b.turn.index);

  return {
    chosen,
    strataCounts,
    perConversation: convs.map(c => ({
      conversationId: c.conversationId,
      available: all.filter(x => x.conversation === c).length,
      chosen: chosen.filter(x => x.conversation === c).length,
    })),
  };
}
