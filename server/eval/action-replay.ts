/**
 * ACTION-CORRECTNESS REPLAY — increment 5, the gate that decides ENGINE_ACTIONS=on.
 *
 * The existing replay (replay.ts) scores CONVERSATION quality and skips transactions.
 * This one is the mirror: it replays real historical messages through the engine WITH
 * action emission (dry-run — nothing is written) and scores whether Coach K chose the
 * RIGHT action, using what production actually did (the logged intent) as ground truth.
 *
 * It measures the three things every reviewer demanded, action-correctness not tone:
 *   - match rate     — emitted the expected action.
 *   - MISSED actions — expected an action, emitted JUST_REPLY. This is the reviewers'
 *                      core fear: JUST_REPLY becoming the new template pile.
 *   - FALSE actions  — expected conversation, emitted a state-write. The dangerous one.
 *
 * The pure scorer + intent map live in action-score.ts (unit-tested, dependency-free);
 * this file is the live tool (a coach WhatsApp command). WIN = the frozen spec's bar;
 * 5 consecutive winning days flips the flag.
 */

import type OpenAI from "openai";
import { desc, and, isNotNull, eq } from "drizzle-orm";
import { db } from "../db";
import { chatHistory, users, schedulerState } from "../../shared/schema";
import { buildClientSnapshot } from "../brain/client-snapshot";
import { seedUnderstanding } from "../understanding/seed";
import { runMeaningEngine } from "../understanding/meaning-engine";
import { type CoachActionType } from "../understanding/actions";
import {
  expectedActionForIntent,
  scoreActionReplay,
  type ActionReplayPair,
  type ActionScore,
} from "./action-score";
import { recordRun, evaluateGate, type DayResult, type GateVerdict } from "./winning-days";
import { ACTION_GOLD } from "./action-gold";

export {
  expectedActionForIntent,
  scoreActionReplay,
  type ExpectedAction,
  type ActionReplayPair,
  type ActionScore,
} from "./action-score";

// The SAST day-log of replay verdicts, persisted in the existing scheduler_state KV store
// (no migration). The winning-days gate reads this to decide ENGINE_ACTIONS=on.
const DAY_LOG_KEY = "action_replay_days";

async function loadDayLog(): Promise<DayResult[]> {
  try {
    const [row] = await db.select().from(schedulerState).where(eq(schedulerState.key, DAY_LOG_KEY)).limit(1);
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed as DayResult[] : [];
  } catch { return []; }
}

async function saveDayLog(days: DayResult[]): Promise<void> {
  const value = JSON.stringify(days);
  try {
    await db.insert(schedulerState).values({ key: DAY_LOG_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: schedulerState.key, set: { value, updatedAt: new Date() } });
  } catch (e) { console.warn("[ACTION_REPLAY] day-log save failed:", (e as any)?.message || e); }
}

/** Read the gate WITHOUT running a replay — for a "gate" status command. */
export async function actionGateStatus(): Promise<GateVerdict> {
  return evaluateGate(await loadDayLog());
}

export interface ActionReplayReport extends ActionScore { whatsappText: string }

export async function runActionReplay(openai: OpenAI, limit = 120): Promise<ActionReplayReport> {
  const rows = await db
    .select({ userId: chatHistory.userId, messageIn: chatHistory.messageIn, intent: chatHistory.intent })
    .from(chatHistory)
    .where(and(isNotNull(chatHistory.messageIn), isNotNull(chatHistory.userId)))
    .orderBy(desc(chatHistory.createdAt))
    .limit(limit * 3);

  const pairs: ActionReplayPair[] = [];
  const userCache = new Map<string, any>();
  for (const r of rows) {
    if (pairs.length >= limit) break;
    const msg = (r.messageIn || "").trim();
    if (!msg || msg.startsWith("[")) continue;
    const expected = expectedActionForIntent(r.intent);
    if (expected === null) continue; // ambiguous → skip
    try {
      let user = userCache.get(r.userId!);
      if (!user) {
        [user] = await db.select().from(users).where(eq(users.id, r.userId!)).limit(1).catch(() => [] as any[]);
        if (user) userCache.set(r.userId!, user);
      }
      if (!user) continue;
      const snapshot = await buildClientSnapshot(user).catch(() => undefined);
      const prior = seedUnderstanding(user, snapshot);
      const res = await runMeaningEngine({ openai, user, message: msg, prior, snapshot, emitActions: true });
      const emitted: CoachActionType = res?.action?.type || "JUST_REPLY";
      pairs.push({ expected, emitted, message: msg });
    } catch { /* skip a bad turn */ }
  }

  const score = scoreActionReplay(pairs);

  // Record this run into the SAST day-log (best-run-per-day) and read the gate.
  const days = recordRun(await loadDayLog(), score, new Date());
  await saveDayLog(days);
  const gate = evaluateGate(days);

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const whatsappText =
    `🎯 *Action-Correctness Replay* (${score.n} real messages)\n\n` +
    `${score.passed ? "✅ WINNING DAY" : "⚠️ Not yet"} — match *${pct(score.matchRate)}*\n` +
    `Missed (should've acted): ${score.missedActions} (${pct(score.missRate)})\n` +
    `False writes (dangerous): ${score.falseActions} (${pct(score.falseRate)})\n` +
    `Wrong action: ${score.wrongActions}\n\n` +
    `${gate.open ? "🟢" : "⏳"} *Gate:* ${gate.reason}\n\n` +
    `_Bar: ≥90% match, ≤2% false writes, ≤10% missed. 5 winning days → flip ENGINE_ACTIONS=on._` +
    (score.samples.length ? `\n\nTop misses:\n${score.samples.slice(0, 5).map(s => `• ${s}`).join("\n")}` : `\n\nNo mismatches — clean.`);

  return { ...score, whatsappText };
}

// A representative eval client so the engine has a real user shape to reason against. The
// gold set judges ACTION CHOICE, which does not depend on any one person's history; the
// snapshot fails open to undefined for this synthetic id (no DB row), which is fine.
const GOLD_EVAL_USER = {
  id: "gold-eval", name: "Sipho", goal: "fat_loss", numbersMode: "low",
  stepsTarget: 8500, currentWeight: 82, isSick: false,
};

/** Resolve to `fallback` if the promise hasn't settled in `ms` — so one stuck AI call can
 *  never hang the whole replay silently (the failure mode that made it "not respond"). */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>(res => setTimeout(() => res(fallback), ms))]);
}

/**
 * THE GOLD REPLAY — score the engine against the HAND-VERIFIED truth set, not production's
 * noisy intent labels. This is the ruler the gate should trust. Because the gold set is
 * fixed, a decisive pass IS the gate — there is no calendar to wait out (that only applies
 * to live shadow over new traffic). Reuses the same pure scorer as the history replay.
 *
 * ROBUSTNESS (2026-07-18: the command went silent): every per-case AI call has a hard
 * timeout, and cases run in bounded-concurrency batches — so it finishes in ~7 rounds, not
 * 36 sequential waits, and a single slow/stuck call degrades to JUST_REPLY instead of
 * freezing the whole run with no reply.
 */
export async function runGoldReplay(openai: OpenAI): Promise<ActionReplayReport> {
  const snapshot = await buildClientSnapshot(GOLD_EVAL_USER as any).catch(() => undefined);
  const prior = seedUnderstanding(GOLD_EVAL_USER as any, snapshot);

  const scoreOne = async (c: { message: string; expected: any }): Promise<ActionReplayPair> => {
    try {
      const res = await withTimeout(
        runMeaningEngine({ openai, user: GOLD_EVAL_USER as any, message: c.message, prior, snapshot, emitActions: true }),
        15_000, null,
      );
      return { expected: c.expected, emitted: (res?.action?.type as CoachActionType) || "JUST_REPLY", message: c.message };
    } catch {
      return { expected: c.expected, emitted: "JUST_REPLY", message: c.message };
    }
  };

  const pairs: ActionReplayPair[] = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < ACTION_GOLD.length; i += CONCURRENCY) {
    pairs.push(...await Promise.all(ACTION_GOLD.slice(i, i + CONCURRENCY).map(scoreOne)));
  }

  const score = scoreActionReplay(pairs);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const whatsappText =
    `🎯 *Action Gate — TRUTH SET* (${score.n} hand-verified cases)\n\n` +
    `${score.passed ? "🟢 *GATE OPEN* — safe to flip ENGINE_ACTIONS=on" : "⚠️ Not yet"} — match *${pct(score.matchRate)}*\n` +
    `Missed (should've acted): ${score.missedActions} (${pct(score.missRate)})\n` +
    `False writes (dangerous): ${score.falseActions} (${pct(score.falseRate)})\n` +
    `Wrong action: ${score.wrongActions}\n\n` +
    `_This is the straight ruler: real answers, not the production classifier. Bar: ≥90% match, ≤2% false writes, ≤10% missed. A decisive pass here IS the gate — no calendar wait._` +
    (score.samples.length ? `\n\nStill failing:\n${score.samples.slice(0, 6).map(s => `• ${s}`).join("\n")}` : `\n\nEvery case correct — clean.`);

  return { ...score, whatsappText };
}
