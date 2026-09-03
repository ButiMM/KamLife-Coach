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

/**
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * ONE PREPARATION CONTRACT FOR EVERY CUSTOMER-FACING MESSAGE (Cut B, 2026-08-31)
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE PROVEN PROBLEM. Two outbound customer authorities:
 *
 *   proactive  scheduler/shared.sendWhatsApp -> enforceOutboundTruth -> provenance -> hygiene
 *   reactive   routes/whatsapp.sendFinal     ->                         provenance -> hygiene
 *
 * The truth floor reached the 68 scheduler jobs and nothing a client said hello to. That is the
 * same shape as the 2026-07-30 finding recorded in whatsapp.ts — provenance and hygiene were
 * wired into sendWhatsApp and claimed to cover everything, and a wall of text reached the founder
 * 27 minutes later because the reply path was not on it. The gates moved; the floor did not.
 *
 * So preparation lives here, in one function both doors call, and the ONLY thing that differs
 * between them is what happens when the floor refuses:
 *
 *   proactive   BLOCK. Nobody is waiting. A message we cannot stand behind is not worth sending,
 *               and the block is recorded so the counter sees it.
 *   reactive    NEVER SILENT. A client is holding their phone. Refusing to answer is its own
 *               failure, so the caller is handed a safe repair to send instead of the draft.
 *
 * NO TWILIO I/O HERE. This module decides what may be said; delivery stays with its owner.
 */
export interface OutboundPrepared {
  /** What to send. On a reactive refusal this is the repair, never the rejected draft. */
  text: string;
  /** True when the floor refused. Proactive callers must not send; reactive callers send `text`. */
  blocked: boolean;
  reason?: OutboundVerdict["reason"];
  detail?: string;
}

/**
 * THE TEMPLATE-LEAK CHECK, folded in from verifiers/proactive-gate.ts (Cut B2, 2026-09-01).
 *
 * It lived in its own module named for the only door that called it, and that name was the bug:
 * its header claimed "every outbound message" while its single caller was sendOneWhatsApp, so
 * "You ate undefined kcal" was blocked at 06:00 and delivered mid-conversation. It is a "may this
 * be said" question, this file owns that question for both doors, and a question with one owner
 * does not need a module of its own to be asked from.
 *
 * Pure, never throws, fails OPEN: a broken checker must not become a broken product.
 */
interface OutboundCheck { safe: boolean; reason: string }

// Unambiguous template-leak markers. None of these legitimately appear in a
// South African fitness coaching message, so matching one means a bug rendered
// a broken value into the text.
const LEAK_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bundefined\b/i, label: "literal 'undefined'" },
  { re: /\bNaN\b/, label: "literal 'NaN'" },
  { re: /\[object Object\]/i, label: "'[object Object]'" },
  { re: /\$\{[^}]*\}/, label: "unrendered ${...} template" },
  { re: /\bnull\b\s*(kcal|g protein|kg|steps|kj|sessions?|days?)/i, label: "'null' before a unit" },
  { re: /(kcal|protein|kg|steps|sessions?|days?)\s*:?\s*\bnull\b/i, label: "unit followed by 'null'" },
  { re: /\bNaN\s*(kcal|g|kg|steps|%)/i, label: "'NaN' before a unit" },
];

/**
 * Check an outbound message body for emptiness and template leaks.
 * Returns { safe: true } for any normal message.
 */
function checkOutboundMessage(body: string | null | undefined): OutboundCheck {
  try {
    if (body == null || typeof body !== "string") {
      return { safe: false, reason: "body is null/undefined or not a string" };
    }
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      return { safe: false, reason: "empty body" };
    }
    for (const { re, label } of LEAK_PATTERNS) {
      if (re.test(body)) {
        return { safe: false, reason: `template leak: ${label}` };
      }
    }
    return { safe: true, reason: "" };
  } catch {
    // Never block a send because the checker itself errored — fail-open.
    return { safe: true, reason: "" };
  }
}

/** What a client hears when the floor refuses a reactive draft. Never an apology, never silence. */
export const REACTIVE_OUTBOUND_REPAIR = "Let me check that properly before I answer — give me one sec and ask me again.";

/**
 * A reactive preparation attempt is never allowed to fail open to its draft. Keeping this
 * exception policy beside the canonical repair prevents either delivery door from inventing
 * its own fallback. The callback shape also makes the throw path directly testable without I/O.
 */
export async function prepareReactiveOutbound(
  recipientKey: string,
  prepare: () => Promise<OutboundPrepared>,
): Promise<OutboundPrepared> {
  try {
    return await prepare();
  } catch (e: any) {
    console.error(`[OUTBOUND_AUTHORITY] BLOCKED reactive send to ${recipientKey.slice(-8)} — preparation failed: ${e?.message || e}`);
    const failure: OutboundPrepared = {
      text: REACTIVE_OUTBOUND_REPAIR,
      blocked: true,
      detail: "preparation failed",
    };
    return failure;
  }
}

export async function prepareOutbound(
  mode: "reactive" | "proactive",
  userId: string | null,
  recipientKey: string,
  text: string,
  recipientUser?: { profileNotes?: string | null } | null,
): Promise<OutboundPrepared> {
  const { provenanceGate } = await import("./verifiers/response-gate");
  const { humanizeReply } = await import("./reply-hygiene");

  const verdict = await enforceOutboundTruth(userId, recipientKey, text, recipientUser);
  if (!verdict.ok) {
    if (mode === "proactive") {
      // THE OPERATOR SIGNAL IS PART OF THE CONTRACT. production-parity drives sendWhatsApp and
      // reads this exact line to prove the door consulted the floor rather than merely importing
      // it — the assertion exists because an earlier source-string version stayed green when the
      // door was changed to ignore the verdict. Renaming it in a refactor broke the observable
      // while the behaviour was fine, which is the same defect one layer out. It keeps its name.
      console.error(`[OUTBOUND_AUTHORITY] BLOCKED proactive send to ${recipientKey.slice(-8)} — ${verdict.reason}: ${verdict.detail}`);
      return { text: "", blocked: true, reason: verdict.reason, detail: verdict.detail };
    }
    console.error(`[OUTBOUND_AUTHORITY] BLOCKED reactive draft to ${recipientKey.slice(-8)} — ${verdict.reason}: ${verdict.detail}`);
    // Reactive: the client is waiting, so they get a safe sentence rather than nothing.
    return { text: REACTIVE_OUTBOUND_REPAIR, blocked: true, reason: verdict.reason, detail: verdict.detail };
  }

  // Shaping stays in this order: a claim spanning a bubble split has to be checked before the
  // split, and reports quote real replies back, so they are left alone.
  //
  // A PREPARATION FAILURE IS NOT A LICENCE TO SEND THE DRAFT. The verifiers are the reason this
  // function exists; treating their failure as "send raw anyway" would make the floor optional
  // exactly when it is least safe. Proactive refuses — nobody is waiting. Reactive still may not
  // go silent, so it gets the same safe sentence a floor refusal produces.
  try {
    let out = await provenanceGate(recipientKey, text);
    if (!out.includes('_"')) out = humanizeReply(out);
    // THE TEMPLATE-LEAK GATE REACHED THE SCHEDULER AND NOTHING A CLIENT SAID HELLO TO
    // (Cut B2, 2026-09-01). proactive-gate.ts opens with "Last-line sanity check for every
    // outbound message" and had exactly ONE caller: sendOneWhatsApp. So "You ate undefined kcal"
    // was blocked at 06:00 and delivered mid-conversation — the identical shape to the finding
    // Cut B1 exists for, one layer down, and found by asking which callers a floor actually has
    // rather than what its header claims.
    //
    // It belongs HERE and not in the transport. It is a "may this be said" question, and that
    // question already has an owner and an established failure policy: proactive refuses,
    // reactive may not go silent. Putting it at the Twilio call would have forced a leaking reply
    // to become NO reply, breaking the never-silent rule to fix a rendering bug — and it would
    // have run per bubble, after the split, where a marker straddling two parts is invisible.
    const leak = checkOutboundMessage(out);
    if (!leak.safe) {
      console.error(`[OUTBOUND_AUTHORITY] BLOCKED ${mode === "proactive" ? "proactive send" : "reactive draft"} `
        + `to ${recipientKey.slice(-8)} — ${leak.reason}`);
      return mode === "proactive"
        ? { text: "", blocked: true, detail: leak.reason }
        : { text: REACTIVE_OUTBOUND_REPAIR, blocked: true, detail: leak.reason };
    }
    return { text: out, blocked: false };
  } catch (e: any) {
    console.error(`[OUTBOUND_AUTHORITY] BLOCKED ${mode} send to ${recipientKey.slice(-8)} — preparation failed: ${e?.message || e}`);
    return mode === "proactive"
      ? { text: "", blocked: true, detail: "preparation failed" }
      : { text: REACTIVE_OUTBOUND_REPAIR, blocked: true, detail: "preparation failed" };
  }
}
