/**
 * ENGINE LIVE (blueprint Days 31-40 — the rollout).
 *
 * Routes GENUINE CONVERSATION to the Meaning Engine live, while everything on the
 * deterministic rails (safety: sick/injury/pain; transactions: logging/payment; commands:
 * workout + programme delivery) has ALREADY been handled by the handlers that run before
 * this point. So the engine only ever sees the conversation it proved (in the replay
 * scorecard) that it wins.
 *
 * Flag-gated (ENGINE_LIVE=on, off by default) and FAIL-OPEN: any miss returns null and the
 * existing brain/gpt-block path runs, so turning this on can only add the engine, never
 * remove the fallback. Instantly reversible: set ENGINE_LIVE=off.
 *
 * The engine's raw reply still passes through the SAME guards production uses: the safety
 * gate (injury/medical conflicts), sanitize, and number-free delivery for numbers:low
 * clients. The understanding it builds is persisted so the coach's memory of the client
 * keeps growing.
 */

import { eq, desc } from "drizzle-orm";
import { db } from "../db";
import { chatHistory } from "../../shared/schema";
import { buildClientSnapshot } from "../brain/client-snapshot";
import { seedUnderstanding } from "./seed";
import { loadUnderstanding, saveUnderstanding } from "./store";
import { runMeaningEngine } from "./meaning-engine";
import { classifyDomain } from "./domain-guard";
import { getNumbersMode, stripNumbersFromProse } from "../numbers-mode";
import { sanitizeCoachReply } from "../handlers/food-scanner";
import { safetyGate } from "../verifiers/response-gate";
import { logChat } from "../handlers/chat-log";
import { executeAction } from "./executor";
import { describeAction } from "./actions";

export function engineLive(): boolean {
  return process.env.ENGINE_LIVE === "on";
}

// THE INVERSION rollout dial (increment 4) — SEPARATE from ENGINE_LIVE so the action
// emitter can be exercised without touching the conversational engine's rollout.
//   off    — default. Coach K never emits actions; behaviour is byte-identical.
//   shadow — emit + DRY-RUN execute + log the decision, but the client still gets the
//            normal path. This is how we gather replay evidence in production, safely.
//   on     — emit + REALLY execute; the deterministic executor's reply wins.
export type ActionMode = "off" | "shadow" | "on";
export function engineActionMode(): ActionMode {
  const v = (process.env.ENGINE_ACTIONS || "off").toLowerCase();
  return v === "on" ? "on" : v === "shadow" ? "shadow" : "off";
}

// COHORT GATE for the `on` rollout. Even with ENGINE_ACTIONS=on, real execution is limited
// to the coach + beta testers (people who opted into testing) UNLESS ENGINE_ACTIONS_ALL=on
// widens it to everyone. So "flip it on now" is safe: a wrong action on unseen live phrasing
// can only ever touch a tester, never a real client, until you deliberately open the gate.
// A non-cohort client in `on` mode runs the action DRY (byte-identical to today) — we still
// log the would-be decision so `shadow` review shows the whole base, not just testers.
export function engineActionsAll(): boolean {
  return (process.env.ENGINE_ACTIONS_ALL || "").toLowerCase() === "on";
}

// Idempotency source id. The inbound WhatsApp MessageSid is now threaded from the webhook
// (ctx.sourceMessageId) and is the stable key we prefer — the SAME identifier Twilio uses,
// and the one our webhook-level dedup already trusts. This derived hash is only the
// fallback for entrypoints without a SID (admin test-webhook, internal recursion): a
// literal retry of the same text within the dedup window still collapses correctly.
function deriveSourceId(userId: string, message: string): string {
  let h = 0;
  const s = `${userId}:${message}`;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return `d${(h >>> 0).toString(36)}`;
}

// SHADOW REVIEW — the confirmation lap in WhatsApp. In shadow mode every emitted action is
// logged (dry-run, nothing written) as ENGINE_ACTION_SHADOW: messageIn = the real message,
// messageOut = "<action> → <status>". This pulls the recent ones so the coach can scan for a
// wrong decision before flipping ENGINE_ACTIONS=on — no Railway logs needed.
export async function recentShadowDecisions(limit = 15): Promise<string> {
  try {
    const rows = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut })
      .from(chatHistory)
      .where(eq(chatHistory.intent, "ENGINE_ACTION_SHADOW"))
      .orderBy(desc(chatHistory.createdAt))
      .limit(Math.max(5, Math.min(40, limit)));
    if (!rows.length) {
      return "🕶️ *Shadow* — no action-decisions logged yet.\n\nSet *ENGINE_ACTIONS=shadow* in Railway; once real messages come in, Coach K's would-be actions show here (dry-run — nothing is written).";
    }
    const lines = rows.map(r => {
      const msg = (r.messageIn || "").replace(/\s+/g, " ").slice(0, 42);
      const decision = (r.messageOut || "").replace(/\s*→\s*\w+(\(dup\))?\s*$/i, "").trim() || "(reply)";
      return `• "${msg}" → *${decision}*`;
    });
    return `🕶️ *Shadow — last ${rows.length} action-decisions* (dry-run, nothing written)\n\n${lines.join("\n")}\n\n_These are the actions Coach K WOULD take on real messages. Scan for a wrong write; if it's clean, flip ENGINE_ACTIONS=on._`;
  } catch (e) {
    return `Shadow read hit a snag: ${(e as any)?.message || e}`;
  }
}

// Last few real turns of THIS conversation, so the engine has short-term memory and
// stops answering each message in a vacuum ("it doesn't listen / forgets what I said").
// Best-effort: an empty list never blocks a reply. Skips internal markers.
async function recentTurns(userId: string): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  try {
    const rows = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut })
      .from(chatHistory).where(eq(chatHistory.userId, userId))
      .orderBy(desc(chatHistory.createdAt)).limit(5);
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const r of rows.reverse()) {
      const inMsg = (r.messageIn || "").trim();
      const outMsg = (r.messageOut || "").trim();
      if (inMsg && !inMsg.startsWith("[")) turns.push({ role: "user", content: inMsg.slice(0, 400) });
      if (outMsg && !outMsg.startsWith("[")) turns.push({ role: "assistant", content: outMsg.slice(0, 500) });
    }
    return turns.slice(-8);
  } catch { return []; }
}

export async function runMeaningEngineLive(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
  openai: any;
  /** The inbound WhatsApp MessageSid, when the caller has it (webhook path). Used as the
   *  idempotency key so a Twilio retry can never double-write. Absent for admin/test and
   *  internal recursion, where we fall back to a user+message hash. */
  sourceMessageId?: string;
  /** May this user's actions REALLY execute in `on` mode? True for coach + beta testers.
   *  Non-cohort users run dry (until ENGINE_ACTIONS_ALL=on), so `on` is safe to flip today. */
  actionsLive?: boolean;
}): Promise<string | null> {
  const { message, user, openai } = ctx;
  try {
    const snapshot = await buildClientSnapshot(user).catch(() => undefined);
    const prior = user?.id
      ? await loadUnderstanding(user.id, seedUnderstanding(user, snapshot))
      : seedUnderstanding(user, snapshot);

    // DOMAIN BOUNDARY GATE (Law 11) — keep Coach K a coaching platform, not a general
    // assistant. Out-of-domain gets a warm redirect (never runs the engine); a partial
    // (life stuff a coach can bridge) passes a note so the engine steers back to the journey.
    const domain = await classifyDomain(openai, message);
    if (domain.classification === "out-of-domain" && domain.redirectMessage) {
      await logChat(user.id, message, domain.redirectMessage, "DOMAIN_REDIRECT").catch(() => {});
      return domain.redirectMessage;
    }
    const bridgeNote = domain.classification === "partially-related"
      ? { role: "assistant" as const, content: "[COACH NOTE: this is a life topic — acknowledge it warmly, then gently connect it back to their health journey. Do not refuse it.]" }
      : null;

    const history = user?.id ? await recentTurns(user.id) : [];
    const actionMode = engineActionMode();
    const result = await runMeaningEngine({ openai, user, message, prior, snapshot, history: bridgeNote ? [...history, bridgeNote] : history, emitActions: actionMode !== "off" });
    if (!result) return null; // fail-open → existing pipeline runs

    // Grow the client's durable memory (fail-open — a save miss never blocks the reply).
    if (user?.id) saveUnderstanding(user.id, result.state).catch(() => {});

    // THE INVERSION — Coach K decided on an action. Validate happened in the engine;
    // here we execute it (dry-run in shadow) and, in `on` mode, let the deterministic
    // executor's reply win. Fail-open: any miss falls back to the conversational reply.
    if (actionMode !== "off" && result.action && result.action.type !== "JUST_REPLY") {
      try {
        // Cohort gate: execute for real only in `on` mode AND when this user is allowed
        // (coach/beta-tester, or ENGINE_ACTIONS_ALL). Everyone else runs DRY — so flipping
        // ENGINE_ACTIONS=on can only touch a tester until the gate is deliberately opened.
        const cohortLive = ctx.actionsLive === true || engineActionsAll();
        const runDry = actionMode === "shadow" || !cohortLive;
        const exec = await executeAction(result.action, {
          user, phone: ctx.phone,
          sourceMessageId: ctx.sourceMessageId || deriveSourceId(user.id, message),
          confidence: 0.9, // placeholder until replay calibrates the distribution
          dryRun: runDry,
        });
        await logChat(user.id, message,
          `${describeAction(result.action)} → ${exec.performed ? "performed" : exec.confirmed ? "confirm" : exec.skipped ? "skip(dup)" : exec.error ? "error" : "noop"}`,
          runDry ? "ENGINE_ACTION_SHADOW" : "ENGINE_ACTION").catch(() => {});
        if (!runDry && (exec.performed || exec.confirmed) && exec.reply.trim()) {
          return exec.reply; // the deterministic side-effect + its reply
        }
      } catch (e) {
        console.warn("[ENGINE_ACTION] execute failed (deferring):", (e as any)?.message || e);
      }
    }

    if (!result.reply.trim()) return null; // no conversational reply → existing pipeline runs

    // Same guards production already trusts: safety gate → sanitize → number-free.
    const gate = await safetyGate(result.reply, user, message);
    let reply = sanitizeCoachReply(gate.response, message, user.weeklyFoodBudget, user.injuries);
    if (getNumbersMode(user) === "low") reply = stripNumbersFromProse(reply);
    if (!reply.trim()) return null;

    await logChat(user.id, message, reply, "ENGINE_LIVE").catch(() => {});
    return reply;
  } catch (e) {
    console.warn("[ENGINE_LIVE] failed (deferring to pipeline):", (e as any)?.message || e);
    return null; // fail-open
  }
}
