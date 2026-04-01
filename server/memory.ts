import { pool } from "./db";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
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

const IMPORTANCE: Record<string, number> = {
  medical: 5, milestone: 5, preference: 4,
  training: 3, nutrition: 3, mindset: 2,
};

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
