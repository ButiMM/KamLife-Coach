/**
 * OUTBOUND AUTHORITY — the floor both doors stand on (2026-08-25, P0-4).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The behavioural-authority work of the last weeks lives in reconcileTurnReply, which runs
 * inside `inTurn` — so it governs REACTIVE replies and nothing else. Measured on main@0950344d:
 * 69 proactive sends across 14 files, of which 3 consult the decision owner. The proactive door
 * (scheduler/shared.sendWhatsApp) applies provenance, hygiene and a template-leak gate, and none
 * of the truth checks.
 *
 * So the product can still be one Coach in conversation and a different one at 06:00, on Monday,
 * and in the weekly review. This is the shared floor that ends that — deliberately a FLOOR, not
 * a copy of the reactive boundary.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS AND IS NOT PORTABLE
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * verifyBrainReply is NOT called here, and that is a deliberate refusal rather than an oversight.
 * Its step-attribution rule blocks a step figure that has no evidence on the turn — correct for a
 * reply, wrong for a cron: the morning brief's "👟 8,500 steps" is a TARGET carrying no target
 * marker, so applying that rule wholesale would silence the single most important message in the
 * product. A boundary that has to be exempted everywhere teaches people to route around it.
 *
 * What ports cleanly is what needs no turn: a claim about durable state, checked against durable
 * state, and a repeat of something just sent.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHY A BLOCK, NOT A REWRITE
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A reactive turn has someone waiting, so silence is the worst outcome and the reply is repaired.
 * Nobody is waiting for a nudge. A false claim about a client's own training is worse than a
 * missed message, so a proactive send that fails this floor is dropped and recorded.
 */

import { isDuplicateOutbound } from "./reply-hygiene";
import { readHeldConstraints, asksForFoodToday, asksForTrainingToday } from "./held-constraints";
import { adjudicableSessionCounts } from "./brain/reply-verifier";

export interface OutboundVerdict {
  /** May this leave the building? */
  ok: boolean;
  /** Machine-readable cause, for the counters. */
  reason?: "session_count_contradicts_record" | "duplicate" | "contradicts_held_constraint";
  detail?: string;
}

/** The window every weekly surface already uses; getProgressTruth's default. */
const SESSION_WINDOW_DAYS = 7;

/**
 * The floor. `userId` may be null when the recipient cannot be resolved — the state checks then
 * cannot run and only the turn-free ones apply, which is the honest degradation.
 */
export async function enforceOutboundTruth(
  userId: string | null,
  recipientKey: string,
  text: string,
  /** The recipient's row, when the door already holds it — carries the durable illness state. */
  recipientUser?: { profileNotes?: string | null } | null,
): Promise<OutboundVerdict> {
  const body = String(text || "");
  if (!body.trim()) return { ok: true };

  // 1. A TRAINING COUNT MUST MATCH THE RECORD. The reactive path has refused to confirm a session
  //    history the log denies since 2026-08-22; a weekly or programme message asserting the same
  //    number was never checked at all. Opt-in: this only reads the ledger when the text actually
  //    asserts a count, so the common send pays nothing.
  // ONLY WHAT THIS RULE CAN ACTUALLY JUDGE (2026-08-25). This called sessionCountsIn — a pure
  // extractor answering "what session numbers appear here", which is NOT "what does this message
  // claim about completed sessions in the window we hold". The difference blocked the weekly
  // Report Card for every client whose sessions did not exactly equal their target, because
  // "Training: 2/4 sessions" reads as a claim of both 2 AND 4. See adjudicableSessionCounts.
  const claimed = adjudicableSessionCounts(body);
  if (claimed.length > 0 && userId) {
    try {
      const { sessionsSince } = await import("./day-ledger");
      const held = await sessionsSince(userId, SESSION_WINDOW_DAYS);
      const wrong = claimed.find(n => n !== held);
      if (wrong !== undefined) {
        return {
          ok: false,
          reason: "session_count_contradicts_record",
          // THE NUMBER THAT ACTUALLY FAILED. This printed claimed[0], so a body claiming [2, 4]
          // against a record of 2 was refused with "said 2, record holds 2" — a log line that
          // reads as the floor malfunctioning at random and hides which claim was the problem.
          detail: `said ${wrong}, record holds ${held} in ${SESSION_WINDOW_DAYS} days`,
        };
      }
    } catch (e: any) {
      // The read failed. Do not assert an unverified count at a client who did not ask.
      return { ok: false, reason: "session_count_contradicts_record", detail: `count unverifiable: ${e?.message || e}` };
    }
  }

  // 2. A MESSAGE MAY NOT CONTRADICT WHAT THE CLIENT ALREADY SETTLED TODAY (2026-08-25, P0-4b).
  //
  //    This is the rule that makes the migration hold. Eleven of fourteen proactive senders ran
  //    their own action ladder — "if sessions < target then say train", "if protein short then say
  //    get to 120g" — computed from the LEDGER, which records what a client did and knows nothing
  //    about what they SAID. So "I'm not training today" at 08:00 and "training day and the
  //    session is still not done" at 19:00 were both correct by their own inputs.
  //
  //    Migrating a sender to chooseAction fixes that sender. This fixes the door, which is the
  //    only place the property can be true for senders nobody has migrated yet and for the next
  //    one somebody writes. The migration below it exists so that senders pass this rule by
  //    construction rather than by being blocked.
  //
  //    Opt-in, like rule 1: the constraint read only happens when the text is actually ASKING for
  //    food or training today. Recognition ("you trained 3 times this week") costs nothing.
  const asksFood = asksForFoodToday(body);
  const asksTraining = asksForTrainingToday(body);
  if (asksFood || asksTraining) {
    // The lookup key is the phone, which is what recipientKey is on this door.
    const held = await readHeldConstraints(recipientKey, recipientUser ?? null);
    if (asksFood && held.foodDayClosed) {
      return { ok: false, reason: "contradicts_held_constraint", detail: `food day closed; text asks for food: ${body.slice(0, 60)}` };
    }
    if (asksTraining && (held.trainingDeclined || held.sick)) {
      const which = held.sick ? "sick" : "training declined";
      return { ok: false, reason: "contradicts_held_constraint", detail: `${which}; text asks for training: ${body.slice(0, 60)}` };
    }
  }

  // 3. THE SAME MESSAGE TWICE IS NEVER RIGHT. The reactive door has said so since 2026-08-21; two
  //    crons covering the same ground on the same morning had nothing stopping them.
  if (isDuplicateOutbound(`proactive:${recipientKey}`, body)) {
    return { ok: false, reason: "duplicate", detail: body.slice(0, 60) };
  }

  return { ok: true };
}
