import { pool } from "./db";
import OpenAI from "openai";

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

// Structured meal log — replaces regex text-parsing of chat history.
// Idempotent: CREATE TABLE IF NOT EXISTS.
export async function initMealLogsTable(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meal_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id),
        logged_at TIMESTAMP NOT NULL DEFAULT NOW(),
        raw_message TEXT,
        source TEXT NOT NULL,
        kcal_int INTEGER NOT NULL DEFAULT 0,
        protein_int INTEGER NOT NULL DEFAULT 0,
        carbs_int INTEGER NOT NULL DEFAULT 0,
        fat_int INTEGER NOT NULL DEFAULT 0,
        items JSONB,
        meal_label TEXT,
        corrected BOOLEAN NOT NULL DEFAULT FALSE
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS meal_logs_user_date_idx ON meal_logs(user_id, logged_at);
    `);
    console.log("[MEAL_LOGS] Table ready");
  } catch (err) {
    console.error("[MEAL_LOGS] Init failed:", err);
  }
}

const IMPORTANCE: Record<string, number> = {
  medical: 5, milestone: 5, preference: 4,
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
    console.error("[MEMORY] Store error:", err);
  }
}

export async function retrieveMemories(phone: string, query: string): Promise<string[]> {
  try {
    const resp = await openai.embeddings.create({ model: "text-embedding-3-small", input: query });
    const vec = resp.data[0].embedding;
    if (!Array.isArray(vec) || vec.length !== 1536) {
      console.warn(`[MEMORY] Unexpected query embedding size: ${vec?.length} — returning empty`);
      return [];
    }
    const result = await pool.query(
      `SELECT content FROM memories WHERE phone = $1 ORDER BY embedding <=> $2::vector LIMIT 8`,
      [phone, `[${vec.join(",")}]`]
    );
    return result.rows.map((r: any) => r.content as string);
  } catch (err) {
    console.error("[MEMORY] Retrieve error:", err);
    return [];
  }
}
