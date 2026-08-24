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

import { sessionCountsIn } from "./utils";
import { isDuplicateOutbound } from "./reply-hygiene";

export interface OutboundVerdict {
  /** May this leave the building? */
  ok: boolean;
  /** Machine-readable cause, for the counters. */
  reason?: "session_count_contradicts_record" | "duplicate";
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
): Promise<OutboundVerdict> {
  const body = String(text || "");
  if (!body.trim()) return { ok: true };

  // 1. A TRAINING COUNT MUST MATCH THE RECORD. The reactive path has refused to confirm a session
  //    history the log denies since 2026-08-22; a weekly or programme message asserting the same
  //    number was never checked at all. Opt-in: this only reads the ledger when the text actually
  //    asserts a count, so the common send pays nothing.
  const claimed = sessionCountsIn(body);
  if (claimed.length > 0 && userId) {
    try {
      const { sessionsSince } = await import("./day-ledger");
      const held = await sessionsSince(userId, SESSION_WINDOW_DAYS);
      if (!claimed.every(n => n === held)) {
        return {
          ok: false,
          reason: "session_count_contradicts_record",
          detail: `said ${claimed[0]}, record holds ${held} in ${SESSION_WINDOW_DAYS} days`,
        };
      }
    } catch (e: any) {
      // The read failed. Do not assert an unverified count at a client who did not ask.
      return { ok: false, reason: "session_count_contradicts_record", detail: `count unverifiable: ${e?.message || e}` };
    }
  }

  // 2. THE SAME MESSAGE TWICE IS NEVER RIGHT. The reactive door has said so since 2026-08-21; two
  //    crons covering the same ground on the same morning had nothing stopping them.
  if (isDuplicateOutbound(`proactive:${recipientKey}`, body)) {
    return { ok: false, reason: "duplicate", detail: body.slice(0, 60) };
  }

  return { ok: true };
}
