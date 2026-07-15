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

import { buildClientSnapshot } from "../brain/client-snapshot";
import { seedUnderstanding } from "./seed";
import { loadUnderstanding, saveUnderstanding } from "./store";
import { runMeaningEngine } from "./meaning-engine";
import { getNumbersMode, stripNumbersFromProse } from "../numbers-mode";
import { sanitizeCoachReply } from "../handlers/food-scanner";
import { safetyGate } from "../verifiers/response-gate";
import { logChat } from "../handlers/chat-log";

export function engineLive(): boolean {
  return process.env.ENGINE_LIVE === "on";
}

export async function runMeaningEngineLive(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
  openai: any;
}): Promise<string | null> {
  const { message, user, openai } = ctx;
  try {
    const snapshot = await buildClientSnapshot(user).catch(() => undefined);
    const prior = user?.id
      ? await loadUnderstanding(user.id, seedUnderstanding(user, snapshot))
      : seedUnderstanding(user, snapshot);

    const result = await runMeaningEngine({ openai, user, message, prior, snapshot });
    if (!result || !result.reply.trim()) return null; // fail-open → existing pipeline runs

    // Grow the client's durable memory (fail-open — a save miss never blocks the reply).
    if (user?.id) saveUnderstanding(user.id, result.state).catch(() => {});

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
