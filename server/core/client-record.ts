/**
 * THE CLIENT RECORD (#271, ORDERS §4 Step 3). Design, retention and erasure: docs/CLIENT-RECORD.md.
 *
 * Three things, and nothing else:
 *   recordInbound  — what the client sent, exactly, one row per message (client_events).
 *   learnFrom      — what they told us about themselves, typed and sourced (client_facts). One
 *                    small model call after the turn; on any failure it writes NOTHING, never a guess.
 *   factsForCoach  — the active facts, in the client's own words, for the coach's context.
 *
 * It never decides a reply and never writes to the existing ledgers (meals, weights, steps,
 * workouts stay the owners of their writes). Failures are swallowed here on purpose: the record
 * must never be the reason a client does not get an answer.
 */
import type OpenAI from "openai";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { users, clientEvents, clientFacts } from "@shared/schema";
import { assertAiOnline } from "../ai-offline";

export const FACT_KINDS = ["goal", "injury", "constraint", "schedule", "preference", "life_event"] as const;
export type FactKind = typeof FACT_KINDS[number];
const EXTRACTOR = "client-record/v1 gpt-4o-mini";

type Channel = "text" | "voice" | "photo" | "video";
export function channelOf(mediaType?: string | null): Channel {
  if (!mediaType) return "text";
  if (mediaType.startsWith("audio/")) return "voice";
  if (mediaType.startsWith("image/")) return "photo";
  if (mediaType.startsWith("video/")) return "video";
  return "text";
}

/** Store the inbound message as received. Idempotent on the MessageSid; returns the event id. */
export async function recordInbound(p: { phone: string; rawText: string; mediaType?: string | null; sourceMessageId?: string }): Promise<string | null> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.phoneNumber, p.phone)).limit(1);
  if (!u) return null; // no client row (e.g. deleted this turn): nothing to attach it to
  const [row] = await db.insert(clientEvents).values({
    userId: u.id, sourceMessageId: p.sourceMessageId || null, channel: channelOf(p.mediaType), rawText: p.rawText || "",
  }).onConflictDoNothing().returning({ id: clientEvents.id });
  if (row) return row.id;
  if (!p.sourceMessageId) return null;
  // A retry of the same delivery is the same event — for the same client, never anyone else's.
  const [existing] = await db.select({ id: clientEvents.id }).from(clientEvents)
    .where(and(eq(clientEvents.sourceMessageId, p.sourceMessageId), eq(clientEvents.userId, u.id))).limit(1);
  return existing?.id ?? null;
}

const EXTRACT_SYSTEM = `You maintain a coaching client's record for a South African health and fitness coach.
From ONE client message, list the durable facts the client states ABOUT THEMSELVES that a coach must remember:
- goal: what they are working towards (an event, a target, a date)
- injury: a body part that hurts, is injured or limits training
- constraint: something that limits food or training (budget, equipment, religion, allergy, shift work)
- schedule: when they can or cannot train or eat
- preference: food or training they like or refuse
- life_event: something happening in their life that affects coaching (bereavement, new job, exams, travel)

NOT facts: questions ("could my knee be the problem?"), other people ("my sister is pregnant"), hypotheticals,
food they ate (meals are logged elsewhere), greetings, and anything you would have to guess.
If the message corrects an earlier fact, set "corrects" to that fact's subject.

Return ONLY JSON: {"facts":[{"kind":"goal|injury|constraint|schedule|preference|life_event","subject":"<2-4 words, lowercase>","statement":"<the client's own words, verbatim span>","detail":{},"valid_until":"YYYY-MM-DD or null","corrects":"<subject or null>"}]}
Return {"facts":[]} when there is nothing.`;

type Extracted = { kind: string; subject: string; statement: string; detail?: Record<string, unknown>; valid_until?: string | null; corrects?: string | null };

/** Parse and validate the extractor's answer. Anything malformed is dropped, never repaired. */
export function parseExtraction(raw: string, message: string): Extracted[] {
  let j: any;
  try { j = JSON.parse(raw); } catch { return []; }
  const facts = Array.isArray(j?.facts) ? j.facts : [];
  const said = message.toLowerCase();
  return facts.filter((f: any) =>
    f && FACT_KINDS.includes(f.kind) && typeof f.subject === "string" && f.subject.trim()
    && typeof f.statement === "string" && f.statement.trim()
    // The statement must be the client's words: a span the model invented is not a fact they stated.
    && said.includes(f.statement.trim().toLowerCase().slice(0, 40)),
  ).map((f: any) => ({ ...f, subject: f.subject.trim().toLowerCase(), statement: f.statement.trim() }));
}

/** Extract facts from one stored event and write them. Writes nothing on any failure. */
export async function learnFrom(openai: OpenAI, eventId: string): Promise<number> {
  const [ev] = await db.select().from(clientEvents).where(eq(clientEvents.id, eventId)).limit(1);
  const text = (ev?.rawText || "").trim();
  if (!ev || text.length < 12) return 0;
  const [done] = await db.select({ n: sql<number>`count(*)::int` }).from(clientFacts).where(eq(clientFacts.sourceEventId, eventId));
  if ((done?.n ?? 0) > 0) return 0; // a retried message is not learned twice
  assertAiOnline("client_record");
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini", temperature: 0, max_tokens: 400, response_format: { type: "json_object" },
    messages: [{ role: "system", content: EXTRACT_SYSTEM }, { role: "user", content: text.slice(0, 1500) }],
  });
  const { recordGptCost } = await import("../gpt");
  recordGptCost({ userId: ev.userId, model: "gpt-4o-mini", feature: "client_record", promptTokens: resp.usage?.prompt_tokens ?? 0, completionTokens: resp.usage?.completion_tokens ?? 0 });
  const facts = parseExtraction(resp.choices[0]?.message?.content || "", text);
  let written = 0;
  for (const f of facts) {
    await db.transaction(async tx => {
      const [row] = await tx.insert(clientFacts).values({
        userId: ev.userId, kind: f.kind, subject: f.subject, statement: f.statement, detail: f.detail ?? null,
        sourceEventId: ev.id, validUntil: f.valid_until && /^\d{4}-\d{2}-\d{2}$/.test(f.valid_until) ? new Date(`${f.valid_until}T23:59:59+02:00`) : null,
        extractedBy: EXTRACTOR,
      }).returning({ id: clientFacts.id });
      // CORRECTIONS SUPERSEDE: the same kind and subject, or the subject it says it corrects.
      const olderSubjects = [f.subject, (f.corrects || "").trim().toLowerCase()].filter(Boolean);
      await tx.update(clientFacts).set({ supersededBy: row.id, supersededAt: new Date() }).where(and(
        eq(clientFacts.userId, ev.userId), isNull(clientFacts.supersededBy),
        ne(clientFacts.id, row.id),
        // Parenthesised by or(): an unbracketed OR here once reached every client's facts.
        or(and(eq(clientFacts.kind, f.kind), eq(clientFacts.subject, f.subject)), inArray(clientFacts.subject, olderSubjects)),
      ));
    });
    written++;
  }
  return written;
}

/** The active facts, for the coach. Empty string when there are none. */
export async function factsForCoach(userId: string): Promise<string> {
  const rows = await db.select().from(clientFacts).where(and(
    eq(clientFacts.userId, userId), isNull(clientFacts.supersededBy),
    sql`(${clientFacts.validUntil} IS NULL OR ${clientFacts.validUntil} > now())`,
  )).orderBy(clientFacts.createdAt).limit(30);
  if (!rows.length) return "";
  return "WHAT THIS CLIENT HAS TOLD YOU (their own words; use it, never contradict it):\n"
    + rows.map(r => `- ${r.kind}: "${r.statement}"`).join("\n");
}

let client: OpenAI | null = null;
async function openaiClient(): Promise<OpenAI> {
  if (!client) {
    const OpenAI = (await import("openai")).default;
    client = new OpenAI({ apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY });
  }
  return client;
}

/** The transport's one call: store what was sent, then learn from it. Never throws. */
export async function recordAndLearn(p: { phone: string; rawText: string; mediaType?: string | null; sourceMessageId?: string }): Promise<void> {
  try {
    const id = await recordInbound(p);
    if (id && p.rawText?.trim()) await learnFrom(await openaiClient(), id);
  } catch (e) {
    const { isAiOfflineError } = await import("../ai-offline");
    if (!isAiOfflineError(e)) console.warn("[CLIENT_RECORD]", (e as Error)?.message || e);
  }
}
