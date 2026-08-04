/**
 * THE EXECUTOR — increment 2 of the inversion (2026-07-19).
 *
 * A validated CoachAction comes in; a deterministic side-effect goes out. This is the
 * "hands" for Coach K — but it holds no new logic: it REUSES the existing, proven log
 * handlers (weight, water, steps, food, sick, meal-management). It only decides
 * whether/whether-not to run, never how.
 *
 * It answers the three questions every reviewer raised:
 *  1. FIELD MAPPING — each action maps to one proven handler (see `perform`). Nothing is
 *     rewritten; LOG_MEAL hands the food TEXT to the deterministic scanner, which owns
 *     the numbers, so the LLM never invents a calorie.
 *  2. PARTIAL VALIDITY — food resolution stays with the scanner. Coach K never pre-parses
 *     "2 resolved + 1 unresolved"; it hands the text, the scanner logs what it recognises
 *     exactly as it does today. There is no half-parsed action to reconcile.
 *  3. RETRY SEMANTICS — the idempotency fingerprint is recorded ONLY on success. A failed
 *     execution is NOT fingerprinted, so it stays retryable; a succeeded one is skipped on
 *     replay/retry. Failure returns a clear, honest error the client can act on.
 *
 * SHADOW-SAFE: `dryRun` decides + reports but never writes — so replay can score the
 * executor against real history without touching a single client's data. Import-light
 * (handlers are lazy-loaded) so the safety core is unit-testable without the DB chain.
 */

import { type CoachAction, type ToolOutcome, actionFingerprint, shouldAutoExecute, writesState, describeAction, actionNumberIsClientReported } from "./actions";

export interface ExecuteContext {
  user: any;
  phone: string;
  /** idempotency key — the inbound WhatsApp message id (stable across retries). */
  sourceMessageId: string;
  /** Coach K's certainty for this action, 0..1. */
  confidence: number;
  /** replay/shadow: decide + report, NEVER write. */
  dryRun?: boolean;
  /** The client's own words. A numeric write must trace its number back to these. */
  clientMessage?: string;
  /** The sentence the ENGINE wrote for this turn. Guard #8: converted tools return facts
   *  only, so this is what the client hears. The deterministic formatter is a never-silent
   *  fallback, logged when it fires, not the normal path. */
  engineReply?: string;
  /** Resuming a parked action after an explicit "yes". The number was already checked
   *  against the message that proposed it, and "yes" carries no digits of its own. */
  preConfirmed?: boolean;
}

export interface ExecuteResult {
  performed: boolean;   // did we actually write state?
  confirmed: boolean;   // did we ask for confirmation instead of writing?
  skipped: boolean;     // idempotency: this exact action already ran (a retry)
  reply: string;        // what Coach K relays to the client
  fingerprint: string;
  error?: string;       // set if the handler threw — the action stays retryable
}

// Fingerprints of SUCCESSFULLY-performed state writes. A retry with the same key is
// skipped; a FAILED action is never recorded, so it stays retryable. The webhook layer
// already dedups raw message redelivery — this is the second belt, and it also protects
// replay from double-writing. In-memory TTL (a retry window, not permanent state).
const _done = new Map<string, number>();
const DONE_TTL_MS = 15 * 60_000;
function markDone(fp: string): void { _done.set(fp, Date.now()); if (_done.size > 5000) _done.clear(); }
function alreadyDone(fp: string): boolean {
  const t = _done.get(fp);
  if (t === undefined) return false;
  if (Date.now() - t < DONE_TTL_MS) return true;
  _done.delete(fp);
  return false;
}
/** Test/ops hook — clear the dedup memory. */
export function _resetExecutorDedup(): void { _done.clear(); }

// PENDING CONFIRMATIONS — when confidence is low the executor ASKS ("reply yes to log it")
// instead of writing. Until now the offered action was parked NOWHERE, so the client's "yes"
// landed on an amnesiac engine and looped (2026-07-23 live: "Reply yes" → "Yes" → "nothing
// removed, recounted"). Park it here, keyed by user, short TTL — the confirm is a live
// back-and-forth, not durable state. Lost on restart → the "yes" simply flows to normal
// understanding, never a wrong write.
const _pending = new Map<string, { action: CoachAction; at: number }>();
const PENDING_TTL_MS = 15 * 60_000;
export function setPendingConfirm(userId: string, action: CoachAction): void {
  _pending.set(userId, { action, at: Date.now() });
  if (_pending.size > 5000) _pending.clear();
}
/** Remove and return the parked action, or null if none / expired. */
export function takePendingConfirm(userId: string): CoachAction | null {
  const p = _pending.get(userId);
  _pending.delete(userId);
  if (!p || Date.now() - p.at > PENDING_TTL_MS) return null;
  return p.action;
}
export function _resetPendingConfirm(): void { _pending.clear(); }

// A short confirmation when confidence is below the bar — we ask, we don't silently write.
function confirmQuestion(action: CoachAction, user: any): string {
  const name = (user?.name || "").split(" ")[0];
  const hi = name ? `${name}, ` : "";
  switch (action.type) {
    case "LOG_MEAL": return `${hi}just so I log it right — "${action.foodText}"? Reply *yes* to log it, or tell me the amount.`;
    case "LOG_STEPS": return `${hi}log *${action.count.toLocaleString()} steps* for today? Reply *yes*.`;
    case "LOG_WATER": return `${hi}log *${action.litres}L* of water? Reply *yes*.`;
    case "LOG_WEIGHT": return `${hi}log your weight as *${action.kg}kg*? Reply *yes*.`;
    case "SET_SICK": return `${hi}rest you up and pause everything for now? Reply *yes* and I'll hold it all.`;
    case "SET_REMINDER": return `${hi}set a reminder to ${action.body}${action.when ? ` ${action.when}` : ""}? Reply *yes*.`;
    default: return `${hi}reply *yes* and I'll sort it.`;
  }
}

export async function executeAction(action: CoachAction, ctx: ExecuteContext): Promise<ExecuteResult> {
  // NUMBER BRAKE — a step count, weight or water volume the client never said is not a log,
  // it is the model filling in a schema from context. Refuse it and let the pipeline run:
  // the deterministic loggers are still behind us and they read the real message.
  if (!ctx.preConfirmed && !actionNumberIsClientReported(action, ctx.clientMessage || "")) {
    console.warn(`[ENGINE_ACTION] REFUSED ${action.type} — its number is not in the client's message: "${(ctx.clientMessage || "").slice(0, 80)}"`);
    return { performed: false, confirmed: false, skipped: true, reply: "", fingerprint: actionFingerprint(action, ctx.user?.id || "?", ctx.sourceMessageId) };
  }
  const fingerprint = actionFingerprint(action, ctx.user?.id || "?", ctx.sourceMessageId);
  const base = { confirmed: false, skipped: false, performed: false, fingerprint };

  // Pure conversation — nothing to execute.
  if (action.type === "JUST_REPLY") return { ...base, reply: "" };

  // 1. CONFIDENCE GATE — an uncertain state-write is confirmed, not written.
  if (!shouldAutoExecute(action, ctx.confidence)) {
    return { ...base, confirmed: true, reply: confirmQuestion(action, ctx.user) };
  }

  // 2. IDEMPOTENCY — this exact action from this message already succeeded → skip silently.
  if (writesState(action.type) && alreadyDone(fingerprint)) {
    return { ...base, skipped: true, reply: "" };
  }

  // 3. DRY RUN (replay/shadow) — decide + report, never write.
  if (ctx.dryRun) {
    return { ...base, reply: `[dry-run] would ${describeAction(action)}` };
  }

  // 4. PERFORM — delegate to the proven handler. Fingerprint on SUCCESS only.
  try {
    const reply = await perform(action, ctx);
    if (writesState(action.type)) markDone(fingerprint);
    return { ...base, performed: writesState(action.type), reply: reply || "" };
  } catch (e) {
    console.error(`[EXECUTOR] ${action.type} failed:`, (e as Error)?.message || e);
    return { ...base, reply: "Something went wrong on my side — send that again and I'll get it.", error: String((e as Error)?.message || e) };
  }
}

/**
 * A SILENT TOOL. Note the return type: ToolOutcome admits numbers and booleans and nothing
 * else, so this function CANNOT hand a sentence back to the client even by accident. That
 * is Guard #8 — silence by construction, not by keyword search.
 */
async function stepsTool(count: number, ctx: ExecuteContext): Promise<ToolOutcome> {
  const { logStepsForUser, getStepStreak } = await import("../handlers/steps");
  const logged = await logStepsForUser(ctx.user.id, count);
  const streak = await getStepStreak(ctx.user.id).catch(() => 0);
  const target = ctx.user.stepsTarget || 8500;
  const weightKg = parseFloat(String(ctx.user.currentWeight)) || 75;
  return {
    performed: true,
    facts: { steps: logged, target, streak, hitTarget: logged >= target, burnKcal: Math.round(logged * 0.0005 * weightKg) },
  };
}

/** The engine's sentence wins. The fallback exists so a client is never met with silence. */
function authored(ctx: ExecuteContext, outcome: ToolOutcome, fallback: () => string): string {
  void outcome;
  const engine = (ctx.engineReply || "").trim();
  return engine || fallback();
}

// FIELD MAPPING: action → the existing, proven handler. Canonical messages reuse the
// handlers that parse text; structured calls reuse the ones that take values. No rewrites.
async function perform(action: CoachAction, ctx: ExecuteContext): Promise<string> {
  const { user, phone } = ctx;
  switch (action.type) {
    case "LOG_WEIGHT": {
      const { handleWeightLog } = await import("../handlers/weight");
      return handleWeightLog(phone, user, action.kg);
    }
    case "LOG_STEPS": {
      // CONVERTED TO A SILENT TOOL (2026-08-04, Guard #8). It used to end with
      // getStepResponse(...) — the steps handler writing "you smashed the target. Lekker.
      // That's a Coke and a half burned off" in its own voice, to every client, forever.
      // It now writes the row and reports what happened. The sentence is the engine's.
      const outcome = await stepsTool(action.count, ctx);
      return authored(ctx, outcome, () => {
        // NEVER-SILENT FALLBACK ONLY. If the engine wrote nothing this turn, the client
        // still hears something true. Logged loudly, because every time this fires it is
        // authorship leaking back out of the engine.
        console.warn("[GUARD8] engine wrote no sentence for LOG_STEPS — deterministic fallback used");
        const s = Number(outcome.facts.steps || 0), t = Number(outcome.facts.target || 8500);
        return s >= t ? `${s.toLocaleString()} steps — past your ${t.toLocaleString()}. 👏` : `${s.toLocaleString()} steps logged.`;
      });
    }
    case "LOG_WATER": {
      const { tryLogWater } = await import("../handlers/water");
      const msg = `${action.litres} litres of water`;
      return (await tryLogWater({ phone, message: msg, m: msg, user })) || "Water logged. 💧";
    }
    case "LOG_MEAL": {
      const { handleFoodContext } = await import("../handlers/food-context");
      const text = `${action.foodText}${action.meal ? ` for ${action.meal}` : ""}${action.retro ? ` ${action.retro}` : ""}`;
      // forceLog: this is an EXPLICIT log action — never let an advisory branch (the
      // restaurant ordering guide) answer it. The rewritten text carries no past-tense
      // marker, so "breakfast from McDonald's…" returned a menu pick instead of logging
      // (2026-07-27 live: three identical guides while the coach promised to log).
      const reply = await handleFoodContext({ phone, message: text, m: text.toLowerCase(), user, stepReplyPart: "", handleMessage: async () => "", forceLog: true });
      return reply || "";
    }
    case "REMOVE_LAST_MEAL": {
      const { handleFoodLogMgmt } = await import("../handlers/food-log-mgmt");
      return (await handleFoodLogMgmt(user, "remove last meal")) || "Removed your last meal. ✅";
    }
    case "SHOW_MEALS": {
      const { handleFoodLogMgmt } = await import("../handlers/food-log-mgmt");
      return (await handleFoodLogMgmt(user, "my meals")) || "No food logged yet today.";
    }
    case "SET_SICK": {
      const { handleSickFlow } = await import("../handlers/sick-flow");
      const msg = `I'm sick for ${action.days} days`;
      const name = (user?.name || "").split(" ")[0] || "";
      return (await handleSickFlow({ message: msg, m: msg.toLowerCase(), user, capName: name })) || "Rest up — I've got everything paused for you.";
    }
    case "END_SICK": {
      const { handleSickFlow } = await import("../handlers/sick-flow");
      const name = (user?.name || "").split(" ")[0] || "";
      return (await handleSickFlow({ message: "I'm back", m: "i'm back", user, capName: name })) || "Welcome back. 💪";
    }
    case "SHOW_WORKOUT": {
      const { handleEarlyCommands } = await import("../handlers/early-commands");
      return (await handleEarlyCommands({ phone, message: "workout", m: "workout", user, hasMedia: false })) || "";
    }
    case "SET_REMINDER": {
      // Reuse the deterministic reminder command (parse + persist + two-step follow-ups).
      const { handleReminderCommand } = await import("../handlers/reminders-handler");
      const synth = `remind me to ${action.body} ${action.when}`.replace(/\s+/g, " ").trim();
      return (await handleReminderCommand({ phone, message: synth, m: synth.toLowerCase(), user })) || "";
    }
    default:
      return "";
  }
}
