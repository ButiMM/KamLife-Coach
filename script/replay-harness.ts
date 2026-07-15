/**
 * REPLAY HARNESS — the dry-run over historical conversations (rebuild blueprint Days 21-30:
 * "dry-run 100 historical conversations").
 *
 * This is the answer to "where's the traffic?": we don't need live volume — we already own
 * thousands of real conversations in chat_history. For each real client turn we replay the
 * NEW Meaning Engine and have the Judge score its reply against the reply production actually
 * sent. Understanding is threaded across the turns of each conversation, exactly as it would
 * accumulate in production, so the engine is scored WITH memory.
 *
 * Output: an aggregate scorecard (win rate, per-dimension averages, candidate vs production)
 * plus the biggest regressions and wins to eyeball. This is the objective signal that decides
 * whether we flip the engine live — no guessing, no waiting.
 *
 * Runs against the real DB + live models (like the drill battery). Not part of npm test.
 *   OPENAI_API_KEY=sk-... DATABASE_URL=... REPLAY_LIMIT=100 npx tsx script/replay-harness.ts
 */

const key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
if (!key) {
  console.error("replay-harness: set OPENAI_API_KEY (this replays against the live models).");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("replay-harness: set DATABASE_URL (this reads real historical conversations).");
  process.exit(2);
}

import OpenAI from "openai";
import { desc, and, isNotNull, eq } from "drizzle-orm";
import { db } from "../server/db";
import { chatHistory, users } from "../shared/schema";
import { buildClientSnapshot } from "../server/brain/client-snapshot";
import { seedUnderstanding } from "../server/understanding/seed";
import { evaluateTurn } from "../server/eval/evaluate";
import type { UnderstandingState } from "../server/understanding/state";

const openai = new OpenAI({ apiKey: key });
const LIMIT = Math.max(5, Math.min(500, parseInt(process.env.REPLAY_LIMIT || "100", 10) || 100));

// We only replay CONVERSATIONAL turns — not transactions/logging/media/telemetry (the engine
// isn't meant to own those). Exclude by intent and by bracketed marker content.
const SKIP_INTENT = /(_LOG$|_OK$|_ACK$|_DONE$|PAYMENT|MEDIA_(SUCCESS|FAILURE)|STEP_|WATER_|FOOD_LOG|WEIGHT|SUPPLEMENT_LOG|EQUIPMENT_UPDATE|PROFILE_UPDATE|SYSTEM)/i;
const isMarker = (s: string) => /^\s*\[/.test(s || "");

interface Turn { userId: string; messageIn: string; messageOut: string; intent: string | null; createdAt: Date }

async function main() {
  console.log(`[REPLAY] pulling up to ${LIMIT} conversational turns from history…`);
  const rows = await db
    .select({ userId: chatHistory.userId, messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut, intent: chatHistory.intent, createdAt: chatHistory.createdAt })
    .from(chatHistory)
    .where(and(isNotNull(chatHistory.messageIn), isNotNull(chatHistory.messageOut), isNotNull(chatHistory.userId)))
    .orderBy(desc(chatHistory.createdAt))
    .limit(LIMIT * 4);

  const turns: Turn[] = rows
    .filter(r => r.userId && r.messageIn?.trim() && r.messageOut?.trim())
    .filter(r => !SKIP_INTENT.test(r.intent || "") && !isMarker(r.messageIn!) && !isMarker(r.messageOut!))
    .map(r => ({ userId: r.userId!, messageIn: r.messageIn!, messageOut: r.messageOut!, intent: r.intent ?? null, createdAt: r.createdAt as Date }))
    .slice(0, LIMIT);

  if (turns.length === 0) { console.log("[REPLAY] no conversational turns found."); process.exit(0); }

  // Group by user, oldest-first, so understanding threads forward through each conversation.
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
        state = r.state; // thread the evolving understanding (in-memory — a dry-run never persists)

        const c = r.verdict.candidate, b = r.verdict.baseline;
        agg.n++; agg.cand += c.overall; agg.s += c.stateAdherence; agg.i += c.intentAccuracy; agg.t += c.toneFit;
        if (r.verdict.needsHumanReview) agg.flags++;
        if (b) {
          agg.base += b.overall;
          if (r.verdict.winner === "candidate") agg.candWins++;
          else if (r.verdict.winner === "baseline") agg.baseWins++;
          else agg.ties++;
          const line = `  msg="${turn.messageIn.slice(0, 70)}"\n    cand ${c.overall.toFixed(1)} vs prod ${b.overall.toFixed(1)} | issue: ${c.worstIssue}\n    NEW:  ${r.candidateReply.slice(0, 140)}\n    PROD: ${turn.messageOut.slice(0, 140)}`;
          if (b.overall > c.overall + 1) regressions.push(line);
          else if (c.overall > b.overall + 1) wins.push(line);
        }
        process.stdout.write(`\r[REPLAY] scored ${agg.n}/${turns.length}…   `);
      } catch (e: any) {
        console.warn(`\n[REPLAY] turn failed: ${e?.message || e}`);
      }
    }
  }

  const avg = (x: number) => (agg.n ? (x / agg.n).toFixed(2) : "0");
  console.log("\n\n===================== REPLAY SCORECARD =====================");
  console.log(`Turns scored: ${agg.n}`);
  console.log(`Candidate (NEW engine) avg: ${avg(agg.cand)}/10   Production avg: ${avg(agg.base)}/10`);
  console.log(`  state-adherence ${avg(agg.s)} | intent-accuracy ${avg(agg.i)} | tone-fit ${avg(agg.t)}`);
  const decided = agg.candWins + agg.baseWins + agg.ties;
  if (decided) console.log(`Head-to-head: NEW wins ${agg.candWins} (${((agg.candWins / decided) * 100).toFixed(0)}%) | PROD wins ${agg.baseWins} | ties ${agg.ties}`);
  console.log(`Flagged for human review: ${agg.flags}`);
  console.log("============================================================");

  if (regressions.length) {
    console.log(`\n── TOP REGRESSIONS (production still better — fix these) ──`);
    regressions.slice(0, 8).forEach(l => console.log(l));
  }
  if (wins.length) {
    console.log(`\n── TOP WINS (new engine clearly better) ──`);
    wins.slice(0, 8).forEach(l => console.log(l));
  }
  process.exit(0);
}

main().catch(e => { console.error("[REPLAY] fatal:", e?.message || e); process.exit(1); });
