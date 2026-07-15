/**
 * Replay core (blueprint Days 21-30 "dry-run historical conversations"), as a reusable
 * function that RETURNS a scorecard string. Used by:
 *   - script/replay-harness.ts (CLI, prints it)
 *   - the coach "replay" WhatsApp command (texts it to the founder — no shell needed)
 *
 * Replays real historical conversational turns through the new Meaning Engine, threads
 * understanding across each conversation, and has the Judge score the new reply vs what
 * production actually sent. Returns an aggregate scorecard + the biggest regressions/wins.
 */

import type OpenAI from "openai";
import { desc, and, isNotNull, eq } from "drizzle-orm";
import { db } from "../db";
import { chatHistory, users } from "../../shared/schema";
import { buildClientSnapshot } from "../brain/client-snapshot";
import { seedUnderstanding } from "../understanding/seed";
import { evaluateTurn } from "./evaluate";
import type { UnderstandingState } from "../understanding/state";

// Skip the turns that STAY deterministic in the rollout — the engine will never own
// these, so grading it on them is measuring the wrong thing. This is the blueprint split:
// the engine owns CONVERSATION; safety (sick/injury/pain/overtraining/comeback) and
// transactions/commands (logging, payment, workout + programme delivery, equipment) stay
// on the deterministic rails. What's left is the engine's real territory.
const SKIP_INTENT = /(_LOG$|_OK$|_ACK$|_DONE$|PAYMENT|MEDIA_|STEP_|WATER_|FOOD_LOG|WEIGHT|SUPPLEMENT_LOG|EQUIPMENT|PROFILE_UPDATE|SYSTEM|SICK|OVERTRAIN|RETURN_PLAN|INJURY|DOMS|PAIN|LOAD_SHEDDING|PROGRAMME|WORKOUT)/i;
const isMarker = (s: string) => /^\s*\[/.test(s || "");

interface Turn { userId: string; messageIn: string; messageOut: string; intent: string | null }

export interface ReplayScorecard {
  scored: number;
  candidateAvg: number;
  productionAvg: number;
  stateAvg: number;
  intentAvg: number;
  toneAvg: number;
  candWins: number;
  prodWins: number;
  ties: number;
  flagged: number;
  regressions: string[];
  wins: string[];
  /** a WhatsApp-friendly summary (short) */
  whatsappText: string;
  /** a full console report */
  fullText: string;
}

export async function runReplayScorecard(openai: OpenAI, limit = 100): Promise<ReplayScorecard> {
  const rows = await db
    .select({ userId: chatHistory.userId, messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut, intent: chatHistory.intent })
    .from(chatHistory)
    .where(and(isNotNull(chatHistory.messageIn), isNotNull(chatHistory.messageOut), isNotNull(chatHistory.userId)))
    .orderBy(desc(chatHistory.createdAt))
    .limit(limit * 4);

  const turns: Turn[] = rows
    .filter(r => r.userId && r.messageIn?.trim() && r.messageOut?.trim())
    .filter(r => !SKIP_INTENT.test(r.intent || "") && !isMarker(r.messageIn!) && !isMarker(r.messageOut!))
    .map(r => ({ userId: r.userId!, messageIn: r.messageIn!, messageOut: r.messageOut!, intent: r.intent ?? null }))
    .slice(0, limit);

  const byUser = new Map<string, Turn[]>();
  for (const t of turns) { const a = byUser.get(t.userId) || []; a.push(t); byUser.set(t.userId, a); }
  for (const a of byUser.values()) a.reverse(); // oldest first

  const agg = { n: 0, candWins: 0, baseWins: 0, ties: 0, cand: 0, base: 0, s: 0, i: 0, t: 0, flags: 0 };
  const regressions: string[] = [];
  const wins: string[] = [];

  for (const [userId, userTurns] of byUser) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1).catch(() => [] as any[]);
    if (!user) continue;
    const snapshot = await buildClientSnapshot(user).catch(() => undefined);
    let state: UnderstandingState | undefined = seedUnderstanding(user, snapshot);
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const turn of userTurns) {
      try {
        const r = await evaluateTurn({ openai, user, message: turn.messageIn, productionReply: turn.messageOut, snapshot, prior: state, history });
        history.push({ role: "user", content: turn.messageIn }, { role: "assistant", content: turn.messageOut });
        if (history.length > 16) history.splice(0, history.length - 16);
        if (!r) continue;
        state = r.state;
        const c = r.verdict.candidate, b = r.verdict.baseline;
        agg.n++; agg.cand += c.overall; agg.s += c.stateAdherence; agg.i += c.intentAccuracy; agg.t += c.toneFit;
        if (r.verdict.needsHumanReview) agg.flags++;
        if (b) {
          agg.base += b.overall;
          if (r.verdict.winner === "candidate") agg.candWins++;
          else if (r.verdict.winner === "baseline") agg.baseWins++;
          else agg.ties++;
          const line = `• "${turn.messageIn.slice(0, 60)}"\n   new ${c.overall.toFixed(1)} vs prod ${b.overall.toFixed(1)} — ${c.worstIssue}`;
          if (b.overall > c.overall + 1) regressions.push(line);
          else if (c.overall > b.overall + 1) wins.push(line);
        }
      } catch { /* skip a bad turn */ }
    }
  }

  const avg = (x: number) => (agg.n ? x / agg.n : 0);
  const decided = agg.candWins + agg.baseWins + agg.ties;
  const winPct = decided ? Math.round((agg.candWins / decided) * 100) : 0;
  const candidateAvg = avg(agg.cand), productionAvg = avg(agg.base);

  const verdict = candidateAvg >= productionAvg + 0.5
    ? "✅ New engine is winning"
    : candidateAvg <= productionAvg - 0.5
      ? "⚠️ Production still ahead — not ready to flip"
      : "≈ Too close — keep tuning";

  const whatsappText =
    `📊 *KamLife Replay Scorecard* (${agg.n} real conversations)\n\n` +
    `*New engine: ${candidateAvg.toFixed(1)}/10*  vs  Production: ${productionAvg.toFixed(1)}/10\n` +
    `${verdict}\n\n` +
    `Head-to-head: new wins *${winPct}%* (${agg.candWins} vs ${agg.baseWins}, ${agg.ties} ties)\n` +
    `Breakdown — listens: ${avg(agg.s).toFixed(1)} | understands: ${avg(agg.i).toFixed(1)} | sounds human: ${avg(agg.t).toFixed(1)}\n\n` +
    (regressions.length ? `Still losing on ${regressions.length} — top:\n${regressions.slice(0, 3).join("\n")}` : `No regressions — clean.`);

  const fullText =
    `===================== REPLAY SCORECARD =====================\n` +
    `Turns scored: ${agg.n}\n` +
    `Candidate (NEW) avg: ${candidateAvg.toFixed(2)}/10   Production avg: ${productionAvg.toFixed(2)}/10   → ${verdict}\n` +
    `  state-adherence ${avg(agg.s).toFixed(2)} | intent-accuracy ${avg(agg.i).toFixed(2)} | tone-fit ${avg(agg.t).toFixed(2)}\n` +
    `Head-to-head: NEW ${agg.candWins} (${winPct}%) | PROD ${agg.baseWins} | ties ${agg.ties}   Flagged: ${agg.flags}\n` +
    `============================================================\n` +
    (regressions.length ? `\n── TOP REGRESSIONS ──\n${regressions.slice(0, 8).join("\n")}\n` : "") +
    (wins.length ? `\n── TOP WINS ──\n${wins.slice(0, 8).join("\n")}\n` : "");

  return {
    scored: agg.n, candidateAvg, productionAvg,
    stateAvg: avg(agg.s), intentAvg: avg(agg.i), toneAvg: avg(agg.t),
    candWins: agg.candWins, prodWins: agg.baseWins, ties: agg.ties, flagged: agg.flags,
    regressions, wins, whatsappText, fullText,
  };
}
