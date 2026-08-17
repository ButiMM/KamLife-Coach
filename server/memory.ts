import { pool } from "./db";
import OpenAI from "openai";
import { assertAiOnline, isAiOfflineError } from "./ai-offline";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-missing-key",
});

export async function initMemoryTable(): Promise<void> {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding vector(1536),
        category TEXT NOT NULL DEFAULT 'general',
        importance INTEGER DEFAULT 3,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS memories_phone_idx ON memories(phone);
    `);
    console.log("[MEMORY] Table ready with pgvector");
  } catch (err) {
    console.error("[MEMORY] Init failed:", err);
  }
}

// NOTE: the `meal_logs` table is created by the canonical migration block in
// server/index.ts (and typed in shared/schema.ts). The duplicate DDL that used to
// live here was removed to end the schema drift — schema.ts is the source of truth.
// `memories` (pgvector) stays raw above because Drizzle lacks stable pgvector support.

const IMPORTANCE: Record<string, number> = {
  medical: 5, milestone: 5, preference: 4, commitment: 4,
  training: 3, nutrition: 3, mindset: 2,
};

async function pruneOldMemories(phone: string): Promise<void> {
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
    const oneYearAgo = new Date(Date.now() - 365 * 86400000).toISOString();
    await pool.query(
      `DELETE FROM memories WHERE phone = $1 AND ((importance <= 3 AND created_at < $2) OR (importance = 4 AND created_at < $3))`,
      [phone, ninetyDaysAgo, oneYearAgo]
    );
  } catch (err) {
    console.warn("[MEMORY] Prune error:", err);
  }
}

export async function storeMemory(phone: string, content: string, category: string): Promise<void> {
  try {
    assertAiOnline("storeMemory");

    // Identical facts should not be embedded and inserted again on every turn.
    // Keep this scoped to recent history so a genuinely repeated fact can become a
    // fresh memory later without letting the table fill with same-turn duplicates.
    const duplicate = await pool.query(
      `SELECT 1
       FROM memories
       WHERE phone = $1
         AND content = $2
         AND category = $3
         AND created_at >= NOW() - INTERVAL '30 days'
       LIMIT 1`,
      [phone, content, category]
    );
    if (duplicate.rows.length > 0) return;

    const resp = await openai.embeddings.create({ model: "text-embedding-3-small", input: content });
    const vec = resp.data[0].embedding;
    if (!Array.isArray(vec) || vec.length !== 1536) {
      console.warn(`[MEMORY] Unexpected embedding size: ${vec?.length} — skipping store`);
      return;
    }
    const importance = IMPORTANCE[category] || 3;
    await pool.query(
      `INSERT INTO memories (phone, content, embedding, category, importance) VALUES ($1, $2, $3::vector, $4, $5)`,
      [phone, content, `[${vec.join(",")}]`, category, importance]
    );
    // Prune stale low-importance memories occasionally (1-in-20 writes)
    if (Math.random() < 0.05) pruneOldMemories(phone).catch(() => {});
  } catch (err) {
    if (!isAiOfflineError(err)) console.error("[MEMORY] Store error:", err);
  }
}

async function recentConversation(phone: string): Promise<string> {
  try {
    // The turn ledger records the reply that actually reached the client after deterministic
    // handlers and post-turn reconciliation. Prefer it over chat_history, which some older
    // handler paths populated with a receipt/draft before the final reply was settled.
    const turnResult = await pool.query(
      `SELECT input_text AS message_in, reply AS message_out, created_at
       FROM turn_ledger
       WHERE user_id = (SELECT id FROM users WHERE phone_number = $1 LIMIT 1)
         AND reply IS NOT NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 4`,
      [phone]
    );

    const sourceRows = turnResult.rows.length > 0
      ? turnResult.rows
      : (await pool.query(
        `SELECT message_in, message_out, created_at
         FROM chat_history
         WHERE user_id = (SELECT id FROM users WHERE phone_number = $1 LIMIT 1)
         ORDER BY created_at DESC, id DESC
         LIMIT 4`,
        [phone]
      )).rows;

    if (sourceRows.length === 0) return "";
    const turns = sourceRows.reverse().map((r: any) => {
      const when = r.created_at instanceof Date
        ? r.created_at.toISOString().slice(0, 16).replace("T", " ")
        : String(r.created_at || "").slice(0, 16).replace("T", " ");
      const incoming = String(r.message_in || "").trim().slice(0, 600);
      const outgoing = String(r.message_out || "").trim().slice(0, 700);
      return `[${when}] CLIENT: ${incoming}\n[${when}] COACH: ${outgoing}`;
    });
    return turns.join("\n");
  } catch (err) {
    console.warn("[MEMORY] Recent conversation unavailable:", (err as any)?.message || err);
    return "";
  }
}

export async function retrieveMemories(phone: string, query: string): Promise<string[]> {
  try {
    assertAiOnline("retrieveMemories");
    const resp = await openai.embeddings.create({ model: "text-embedding-3-small", input: query });
    const vec = resp.data[0].embedding;
    if (!Array.isArray(vec) || vec.length !== 1536) {
      console.warn(`[MEMORY] Unexpected query embedding size: ${vec?.length} — returning empty`);
      return [];
    }
    const vector = `[${vec.join(",")}]`;

    // Memory should feel like a continuing relationship, not a static FAQ index.
    // Pure semantic ranking can surface an old, beautifully matching fact while burying
    // something the client just told us or a recent commitment. Keep semantic relevance as
    // the dominant signal, but blend in recency and importance so recent/high-stakes context
    // can survive retrieval when the wording is different.
    const result = await pool.query(
      `SELECT content,
              embedding <=> $2::vector AS distance,
              created_at,
              importance,
              (
                0.72 * (embedding <=> $2::vector)
                + 0.20 * LEAST(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0 / 30.0, 1.0)
                - 0.08 * (GREATEST(COALESCE(importance, 3), 1) / 5.0)
              ) AS retrieval_score
       FROM memories
       WHERE phone = $1
       ORDER BY retrieval_score ASC
       LIMIT 8`,
      [phone, vector]
    );
    const recalled = result.rows.map((r: any) => r.content as string);
    const thread = await recentConversation(phone);
    if (thread) {
      recalled.push(`RECENT CONVERSATION — use this to stay in the thread, not to recite it:\n${thread}`);
    }
    return recalled;
  } catch (err) {
    if (!isAiOfflineError(err)) console.error("[MEMORY] Retrieve error:", err);
    return [];
  }
}

// ============================================================
// SHARED FACT SCANNER — one memory writer for EVERY reply path.
// The store triggers lived inline in gpt-block only, so anything a client told
// the BRAIN was never remembered. Fire-and-forget; never blocks or fails a reply.
// ============================================================
export async function scanAndStoreClientFacts(phone: string, message: string): Promise<void> {
  const m = (message || "").toLowerCase();
  const raw = (message || "").trim();
  if (!raw) return;

  try {
    const writes: Array<[string, string]> = [];

    if (/\b(injury|injured|hurt|pain|bad knee|bad back|bad shoulder|bad hip)\b/.test(m)) {
      writes.push([`Client reported injury: "${raw}"`, "medical"]);
    }
    if (/\b(allergic|allergy|intolerant|can't eat|cannot eat|dairy free|gluten free|peanut allergy)\b/.test(m)) {
      writes.push([`Client dietary restriction: "${raw}"`, "medical"]);
    }
    if (/\b(diabetes|diabetic|hypertension|pcos|hiv|tb |tuberculosis|pregnant|epilepsy)\b/.test(m)) {
      writes.push([`Client medical condition: "${raw}"`, "medical"]);
    }
    if (/\bi(?:'m| am)?\s+(?:on|taking|using|take)\b[^.!?]{0,30}\b(creatine|whey|protein\s+(?:powder|shake)|pre.?workout|multivitamin|omega|bcaa|supplement)/i.test(raw)
        || /\b(creatine|whey|pre.?workout)\b[^.!?]{0,20}\b(daily|every\s+(?:day|morning)|before\s+(?:gym|training))\b/i.test(raw)) {
      writes.push([`Client supplement info: "${raw}"`, "supplement"]);
    }
    if (/\bonly\s+want\s+(?:to\s+(?:do|walk|hit)\s+)?[\d,]+\s*steps\b|\b[\d,]+\s*steps\s+(?:is|are)\s+(?:enough|my\s+(?:limit|max))\b/.test(m)) {
      writes.push([`Client steps preference: "${raw}"`, "preference"]);
    }
    if (/\b(i prefer|i hate|i love|don't like|can't stand|favourite food|i always eat|i never eat|my go.?to)\b/.test(m)) {
      writes.push([`Client food or training preference: "${raw}"`, "preference"]);
    }
    if (/\b(night shift|work from home|just had a baby|new job|retrenched|moved|single mom|single dad|divorce|breakup)\b/.test(m)) {
      writes.push([`Life situation update: "${raw}"`, "preference"]);
    }
    if (/\b(i'?ll|i will|i'm going to|i am going to|i plan to|i promise|i'll make sure|starting tomorrow)\b.{0,100}\b(?:train|workout|walk|hit|reach|log|eat|cook|pack|weigh|check in|sleep|drink)\b/i.test(raw)
      || /\b(?:tomorrow|tonight|this week)\b.{0,80}\b(?:i'?ll|i will|going to|plan to|promise to)\b/i.test(raw)) {
      writes.push([`Client commitment: "${raw.slice(0, 220)}"`, "commitment"]);
    }
    if (/\b(stressed|anxious|depressed|overwhelmed|struggling|bad week|hard week|tough week|not okay|burnout|quit|give up|want to stop|not working|no results|nothing is changing)\b/.test(m)) {
      writes.push([`Client mindset/motivation signal: "${raw.slice(0, 160)}"`, "mindset"]);
    }
    if (/\b(hit my goal|reached my goal|lost.*kg|gained.*kg|pb|personal best|new record)\b/.test(m)) {
      writes.push([`Client milestone: "${raw}"`, "milestone"]);
    }

    // Keep this fire-and-forget relative to the reply path, but don't let one malformed
    // category prevent the other facts in the same turn from being retained.
    await Promise.all(writes.map(([content, category]) => storeMemory(phone, content, category)));
  } catch (e: any) {
    console.warn("[MEMORY] fact scan non-fatal:", e?.message || e);
  }
}