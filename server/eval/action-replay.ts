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
import { chatHistory, users } from "../../shared/schema";
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

export {
  expectedActionForIntent,
  scoreActionReplay,
  type ExpectedAction,
  type ActionReplayPair,
  type ActionScore,
} from "./action-score";

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
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const whatsappText =
    `🎯 *Action-Correctness Replay* (${score.n} real messages)\n\n` +
    `${score.passed ? "✅ WINNING DAY" : "⚠️ Not yet"} — match *${pct(score.matchRate)}*\n` +
    `Missed (should've acted): ${score.missedActions} (${pct(score.missRate)})\n` +
    `False writes (dangerous): ${score.falseActions} (${pct(score.falseRate)})\n` +
    `Wrong action: ${score.wrongActions}\n\n` +
    `_Bar: ≥90% match, ≤2% false writes, ≤10% missed. 5 winning days → flip ENGINE_ACTIONS=on._` +
    (score.samples.length ? `\n\nTop misses:\n${score.samples.slice(0, 5).map(s => `• ${s}`).join("\n")}` : `\n\nNo mismatches — clean.`);

  return { ...score, whatsappText };
}
