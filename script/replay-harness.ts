/**
 * REPLAY HARNESS (CLI) — dry-run the new Meaning Engine over historical conversations and
 * print a scorecard (rebuild blueprint Days 21-30). The core lives in server/eval/replay.ts
 * and is shared with the coach "replay" WhatsApp command, so both measure the same thing.
 *
 *   OPENAI_API_KEY=sk-... DATABASE_URL=... REPLAY_LIMIT=100 npx tsx script/replay-harness.ts
 */

const key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
if (!key) { console.error("replay-harness: set OPENAI_API_KEY (replays against the live models)."); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error("replay-harness: set DATABASE_URL (reads real conversations)."); process.exit(2); }

import OpenAI from "openai";
import { runReplayScorecard } from "../server/eval/replay";

const LIMIT = Math.max(5, Math.min(500, parseInt(process.env.REPLAY_LIMIT || "100", 10) || 100));

async function main() {
  console.log(`[REPLAY] replaying up to ${LIMIT} historical conversations through the new engine…\n`);
  const card = await runReplayScorecard(new OpenAI({ apiKey: key }), LIMIT);
  console.log(card.fullText);
  process.exit(0);
}
main().catch(e => { console.error("[REPLAY] fatal:", e?.message || e); process.exit(1); });
