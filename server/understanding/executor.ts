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

import { type CoachAction, type ToolOutcome, refsAreLabels, actionFingerprint, shouldAutoExecute, writesState, describeAction, actionNumberIsClientReported } from "./actions";
import { neverSilentLine } from "../reply-hygiene";
import { sastHour } from "../sast";

export interface ExecuteContext {
  user: any;
  phone: string;
  /** idempotency key — the inbound WhatsApp MessageSid when available (stable across retries). */
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
   * against the message that proposed it, and "yes" carries no digits of its own. */
  preConfirmed?: boolean;
}

export interface ExecuteResult {
  performed: boolean;
  confirmed: boolean;
  skipped: boolean;
  reply: string;
  fingerprint: string;
  error?: string;
}

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
export function _resetExecutorDedup(): void { _done.clear(); }

const _pending = new Map<string, { action: CoachAction; at: number }>();
const PENDING_TTL_MS = 15 * 60_000;
export function setPendingConfirm(userId: string, action: CoachAction): void {
  _pending.set(userId, { action, at: Date.now() });
  if (_pending.size > 5000) _pending.clear();
}
export function takePendingConfirm(userId: string): CoachAction | null {
  const p = _pending.get(userId);
  _pending.delete(userId);
  if (!p || Date.now() - p.at > PENDING_TTL_MS) return null;
  return p.action;
}
export function _resetPendingConfirm(): void { _pending.clear(); }

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
  if (!ctx.preConfirmed && !actionNumberIsClientReported(action, ctx.clientMessage || "")) {
    console.warn(`[ENGINE_ACTION] REFUSED ${action.type} — its number is not in the client's message: "${(ctx.clientMessage || "").slice(0, 80)}"`);
    return { performed: false, confirmed: false, skipped: true, reply: "", fingerprint: actionFingerprint(action, ctx.user?.id || "?", ctx.sourceMessageId) };
  }
  const fingerprint = actionFingerprint(action, ctx.user?.id || "?", ctx.sourceMessageId);
  const base = { confirmed: false, skipped: false, performed: false, fingerprint };

  if (action.type === "JUST_REPLY") return { ...base, reply: "" };
  if (!shouldAutoExecute(action, ctx.confidence)) {
    return { ...base, confirmed: true, reply: confirmQuestion(action, ctx.user) };
  }
  if (writesState(action.type) && alreadyDone(fingerprint)) {
    return { ...base, skipped: true, reply: "" };
  }
  if (ctx.dryRun) {
    return { ...base, reply: `[dry-run] would ${describeAction(action)}` };
  }

  try {
    const reply = await perform(action, ctx);
    if (writesState(action.type)) markDone(fingerprint);
    return { ...base, performed: writesState(action.type), reply: reply || "" };
  } catch (e) {
    console.error(`[EXECUTOR] ${action.type} failed:`, (e as Error)?.message || e);
    return { ...base, reply: "Something went wrong on my side — send that again and I'll get it.", error: String((e as Error)?.message || e) };
  }
}

async function stepsTool(count: number, ctx: ExecuteContext, retro?: string): Promise<ToolOutcome> {
  const { logStepsForUser, getStepStreak } = await import("../handlers/steps");
  const { parseMealDate } = await import("../utils");
  const at = retro ? parseMealDate(retro) : undefined;
  const logged = await logStepsForUser(ctx.user.id, count, at ? { at, correction: true } : undefined);
  const streak = await getStepStreak(ctx.user.id).catch(() => 0);
  const target = ctx.user.stepsTarget || 8500;
  const weightKg = parseFloat(String(ctx.user.currentWeight)) || 75;
  return {
    performed: true,
    facts: { steps: logged, target, streak, hitTarget: logged >= target, burnKcal: Math.round((logged / 1250) * 0.5 * weightKg) },
    refs: retro ? { dayLabel: String(retro).slice(0, 20) } : undefined,
  };
}

async function weightTool(kg: number, ctx: ExecuteContext): Promise<ToolOutcome> {
  const { handleWeightLog } = await import("../handlers/weight");
  await handleWeightLog(ctx.phone, ctx.user, kg);
  const prev = parseFloat(String(ctx.user.currentWeight)) || 0;
  return { performed: true, facts: { kg, previousKg: prev || null, changeKg: prev ? Math.round((kg - prev) * 10) / 10 : null } };
}

async function waterTool(litres: number, ctx: ExecuteContext): Promise<ToolOutcome> {
  const { tryLogWater } = await import("../handlers/water");
  const msg = `${litres} litres of water`;
  await tryLogWater({ phone: ctx.phone, message: msg, m: msg, user: ctx.user });
  return { performed: true, facts: { litres } };
}

let lastCardMarker = "";

/** The explicit meal slot from the client is authoritative. The server clock is only a fallback
 * when the action did not contain a slot. This is deliberately enforced at the executor boundary
 * because the action model can otherwise supply a plausible-but-wrong slot and silently corrupt
 * the member's meal history. */
function resolveMealSlot(actionMeal: string | null | undefined): string | undefined {
  const value = String(actionMeal || "").trim();
  return value || undefined;
}

export function explicitMealSlotWins(actionMeal: string | null | undefined): string | undefined {
  return resolveMealSlot(actionMeal);
}

async function mealTool(action: Extract<CoachAction, { type: "LOG_MEAL" }>, ctx: ExecuteContext): Promise<ToolOutcome> {
  const { handleFoodContext } = await import("../handlers/food-context");
  const slot = resolveMealSlot(action.meal);
  const text = `${action.foodText}${slot ? ` for ${slot}` : ""}${action.retro ? ` ${action.retro}` : ""}`;
  const discarded = await handleFoodContext({ phone: ctx.phone, message: text, m: text.toLowerCase(), user: ctx.user, stepReplyPart: "", handleMessage: async () => "", forceLog: true });
  lastCardMarker = (String(discarded || "").match(/\[MEDIA:[^\]]+\]/) || [""])[0];
  const refs: Record<string, string> = { mealName: String(action.foodText || "").slice(0, 60) };
  if (slot) refs.slot = String(slot).slice(0, 20);
  if (action.retro) refs.dayLabel = String(action.retro).slice(0, 20);
  return { performed: true, facts: {}, refs };
}

let lastFacts: Record<string, unknown> = {};
export function takeLastToolFacts(): Record<string, unknown> { const f = lastFacts; lastFacts = {}; return f; }

function authored(ctx: ExecuteContext, outcome: ToolOutcome, fallback: () => string): string {
  lastFacts = { ...(outcome.facts || {}), ...(outcome.refs || {}) };
  if (!refsAreLabels(outcome.refs)) {
    console.warn(`[GUARD8] a tool returned prose in refs, not a label: ${JSON.stringify(outcome.refs).slice(0, 120)}`);
    outcome.refs = undefined;
  }
  const engine = (ctx.engineReply || "").trim();
  return engine || fallback();
}

async function perform(action: CoachAction, ctx: ExecuteContext): Promise<string> {
  const { user, phone } = ctx;
  switch (action.type) {
    case "LOG_WEIGHT": {
      const outcome = await weightTool(action.kg, ctx);
      return authored(ctx, outcome, () => {
        console.warn("[GUARD8] engine wrote no sentence for LOG_WEIGHT — deterministic fallback used");
        return neverSilentLine("weight", { amount: `${action.kg}kg` });
      });
    }
    case "LOG_STEPS": {
      const outcome = await stepsTool(action.count, ctx, action.retro);
      return authored(ctx, outcome, () => {
        console.warn("[GUARD8] engine wrote no sentence for LOG_STEPS — deterministic fallback used");
        const s = Number(outcome.facts.steps || 0), t = Number(outcome.facts.target || 8500);
        return neverSilentLine("steps", { amount: s.toLocaleString("en-ZA") });
      });
    }
    case "LOG_WATER": {
      const outcome = await waterTool(action.litres, ctx);
      return authored(ctx, outcome, () => {
        console.warn("[GUARD8] engine wrote no sentence for LOG_WATER — deterministic fallback used");
        return neverSilentLine("water", { amount: `${action.litres}L` });
      });
    }
    case "LOG_MEAL": {
      lastCardMarker = "";
      const outcome = await mealTool(action, ctx);
      const card = lastCardMarker; lastCardMarker = "";
      return card + authored(ctx, outcome, () => {
        console.warn("[GUARD8] engine wrote no sentence for LOG_MEAL — deterministic fallback used");
        const name = outcome.refs?.mealName;
        return neverSilentLine("meal", { label: name });
      });
    }
    case "REMOVE_LAST_MEAL": {
      const { handleFoodLogMgmt } = await import("../handlers/food-log-mgmt");
      const said = (ctx.clientMessage || "").trim();
      const targeted = said ? await handleFoodLogMgmt(user, said.toLowerCase()) : null;
      if (targeted) return targeted;
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
      const { handleReminderCommand } = await import("../handlers/reminders-handler");
      const synth = `remind me to ${action.body} ${action.when}`.replace(/\s+/g, " ").trim();
      return (await handleReminderCommand({ phone, message: synth, m: synth.toLowerCase(), user })) || "";
    }
    default:
      return "";
  }
}
