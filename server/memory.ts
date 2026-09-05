import { pool } from "./db";
import OpenAI from "openai";
import { assertAiOnline, isAiOfflineError } from "./ai-offline";
import { sastDaysBetween } from "./sast";

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
  training: 3, nutrition: 3, mindset: 2, correction: 5,
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

/**
 * EMBEDDINGS ARE OFF (2026-08-19, Cut 7). Set MEMORY_EMBEDDINGS=on in Railway to restore them.
 *
 * What this table was sold to us as: relationship. What it is: cosine similarity over chat. It
 * cost an OpenAI embedding call on every stored fact AND on every retrieval — two per coached
 * message on the GPT path — to recall a paragraph that no part of the coaching decision could act
 * on, because acting requires a field.
 *
 * The six things a coach actually has to remember — injury, condition, dietary restriction, work
 * pattern, life context, don't-mention — are now typed columns on the client, written by
 * recordClientFacts below and read by the decision. That is memory. This was search.
 *
 * Nothing is deleted: the table, the writer and the reader all still work, and one env var turns
 * them back on. What is switched off is paying per message for fog.
 */
const EMBEDDINGS_ON = String(process.env.MEMORY_EMBEDDINGS || "").toLowerCase() === "on";

export async function storeMemory(phone: string, content: string, category: string): Promise<void> {
  if (!EMBEDDINGS_ON) return;
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
  // THE THREAD IS NOT AN EMBEDDING. recentConversation below is a plain read of the last four
  // turns, and it is the part of this function that was always doing honest work — staying in
  // the conversation rather than recalling a similar-sounding one. It survives the mute.
  if (!EMBEDDINGS_ON) {
    const [facts, thread] = await Promise.all([factsLine(phone), recentConversation(phone)]);
    const out: string[] = [];
    if (facts) out.push(facts);
    if (thread) out.push(`RECENT CONVERSATION — use this to stay in the thread, not to recite it:\n${thread}`);
    return out;
  }
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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE SIX DURABLE FACTS — memory as a person, not a search index (2026-08-19, Cut 7)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// What was here before: scanAndStoreClientFacts, a detector set that turned everything a client
// told us into prose and embedded it. It had ZERO callers — imported by brain/coach-brain.ts and
// never invoked — and an almost identical, LIVE copy of the same detectors sat inline in
// handlers/gpt-block.ts. So the facts were being caught twice and stored somewhere nothing could
// read, or not caught at all, depending on which handler the sentence routed to.
//
// The defect that makes this a safety fix and not a memory nicety:
//
//   `users.injuries` is typed and it already WORKS. programme.ts filters exercises against it,
//   verifiers/injury-rules.ts parses body parts out of it, response-gate.ts and
//   programme-validator.ts both read it. A client who goes through pain triage gets every future
//   session built around their knee.
//
//   A client who just SAYS "my knee has been killing me since Saturday" hit the gpt-block
//   detector, which embedded the sentence into pgvector and left the column NULL — and the
//   programme carried on prescribing squats. Same client, same fact, two outcomes, decided by
//   routing.
//
// So: one detector set, one writer, typed columns, read by the decision and by the programme.

import { db } from "./db";
import { clientTruthCommits, users } from "../shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { looksLikeQuestion, isFutureIntent } from "./utils";
import { foodConstraints } from "./food-swaps";

export interface DurableFacts {
  injuries?: string;
  medicalConditions?: string;
  dietaryRestrictions?: string;
  lifeContext?: string;
  doNotMention?: string;
  workSchedule?: string;
}

/** Body parts we can actually train around — the vocabulary programme.ts already filters on. */
const BODY_PART = /\b(knee|back|shoulder|hip|ankle|wrist|elbow|neck|groin|hamstring|calf|foot|heel)\b/i;

/**
 * WHAT THE CLIENT JUST TOLD US ABOUT THEMSELVES, AS FIELDS. Pure — no database, no model.
 *
 * Deliberately narrow. Every one of these is written into a column the coach ACTS on, so a false
 * positive is not noise, it is a programme built around an injury the client does not have. The
 * old prose detectors could afford to be loose because nothing read them.
 */
export function detectFacts(message: string): DurableFacts {
  const raw = (message || "").trim();
  const m = raw.toLowerCase();
  const facts: DurableFacts = {};
  if (!raw) return facts;

  // ── THE GUARDS, APPLIED PER FACT AND NOT IN A BLOCK ──────────────────────────────────────
  //
  // (2026-08-19, Cut 8b — the architecture governor caught this file writing to the database off
  // the client's message with nothing in front of it.) The asymmetry decides the design: a false
  // positive here rewrites the client's programme silently and forever, while a false negative
  // just means we learn the fact next time, or through pain triage, which still works. So when
  // the phrasing is a question or a plan, we do not record.
  //
  // Applied where they are RIGHT, and excluded where they would be wrong — a blanket guard would
  // be worse than none:
  //   • the question and future guards do NOT apply to don't-mention, because "don't mention my
  //     weight" is itself a negative imperative and looksLikeQuestion matches a leading "don't".
  //     Guarding it would silently discard the only fact whose value is being honoured.
  //   • mentionsNotDone is used NOWHERE here. It matches "can't", and "can't eat dairy" is the
  //     dietary fact, not its negation. Injury resolution is detected explicitly below instead.
  const asking = looksLikeQuestion(raw);
  const planning = isFutureIntent(raw);
  const reporting = !asking && !planning;

  // INJURY — needs both a pain word and a body part. "my back is killing me" qualifies;
  // "that workout hurt" does not, and must not amputate their leg day.
  // "my knee doesn't hurt anymore", "the back is healed" — the client is telling us the injury is
  // OVER. Recording it here would train around a knee that is fine, permanently.
  const resolved = /\b(?:no longer|not\s+(?:really\s+)?(?:sore|hurting|painful)|doesn'?t\s+hurt|don'?t\s+hurt|healed|all\s+better|fine\s+now|better\s+now|sorted\s+now)\b|\banymore\b/i.test(m);
  const part = m.match(BODY_PART)?.[0]?.toLowerCase();
  if (part && reporting && !resolved) {
    // An INJURY VERB naming a body part is enough on its own — "I hurt my lower back at work" is
    // a report, not a complaint about a hard session.
    const injuryVerb = /\b(injur\w*|hurt|strain\w*|sprain\w*|pulled|tweaked|twisted)\b/i.test(m);
    // "sore" and "pain" are vaguer and overlap with DOMS, which pain-triage owns — those need a
    // second signal before we let them rewrite a programme.
    const vagueWithSignal = /\b(sore|pain\w*|killing me)\b/i.test(m)
      && /\b(sharp|stab\w*|shooting|can'?t|cannot|weeks?|days?|since|still|again|killing)\b/i.test(m);
    if (injuryVerb || vagueWithSignal) facts.injuries = part;
  }

  // MEDICAL CONDITION — first person only. "my sister has diabetes" is not this client's chart.
  const condition = m.match(/\b(diabetes|diabetic|hypertension|high blood pressure|pcos|hiv|tuberculosis|epilepsy|pregnant|asthma|thyroid)\b/)?.[0];
  if (condition && reporting && /\b(i|i'?m|i am|i have|i'?ve|my)\b/i.test(m) && !/\b(my (?:sister|brother|mother|father|mom|dad|wife|husband|friend|aunt|uncle|gran))\b/i.test(m)) {
    facts.medicalConditions = condition === "diabetic" ? "diabetes" : condition;
  }

  // DIETARY RESTRICTION — what they cannot or will not eat. Separate from a preference: this one
  // constrains every meal suggestion we make from now on.
  // Question and future only — see the note above on why mentionsNotDone must not run here.
  const allergy = !reporting ? undefined : m.match(/\b(?:allergic to|intolerant to|can'?t eat|cannot eat|don'?t eat|i'?m|i am)\s+([a-z ]{3,20}?)\b(?:\.|,|$| and | but )/)?.[1]?.trim();
  if (allergy && /\b(lactose|gluten|dairy|nuts?|peanuts?|shellfish|eggs?|pork|beef|halaal|halal|vegan|vegetarian|seafood|fish)\b/i.test(allergy)) {
    facts.dietaryRestrictions = allergy;
  } else if (reporting && /\b(lactose intolerant|gluten free|dairy free|vegan|vegetarian|halaal|halal|kosher)\b/i.test(m) && /\bi'?m|i am\b/i.test(m)) {
    facts.dietaryRestrictions = m.match(/\b(lactose intolerant|gluten free|dairy free|vegan|vegetarian|halaal|halal|kosher)\b/i)![0];
  }

  // LIFE CONTEXT — the thing that makes a month-gone "just say hi" land as a coach. This is the
  // fact the old store was worst at: it embedded "just had a baby" and then recalled it only if
  // the client later said something semantically similar to a baby.
  const life = !reporting ? undefined : m.match(/\b(night shift|night shifts|just had a baby|new baby|newborn|new job|retrenched|laid off|lost my job|got married|divorce|breakup|moved house|moved to|studying|exams)\b/)?.[0];
  if (life) {
    facts.lifeContext = life;
    if (/night shift/.test(life)) facts.workSchedule = "night_shift";
  }

  // DON'T MENTION — the one fact whose entire value is that it constrains what we say. Nothing
  // detected this before; it was the clearest hole in "memory that is a person".
  const drop = raw.match(/\b(?:do ?n'?t|please don'?t|stop|never)\s+(?:talk(?:ing)? about|mention(?:ing)?|bring(?:ing)? up|ask(?:ing)? about|remind(?:ing)? me about)\s+(?:my |the )?([a-zA-Z ]{2,28})/i)?.[1]?.trim();
  if (drop) facts.doNotMention = drop.replace(/\s+(again|anymore|any more|please)$/i, "").trim();

  return facts;
}

/**
 * Append one item to a comma-separated column without duplicating it.
 *
 * THE THIRD COPY, AVOIDED. handlers/pain-triage.ts and handlers/misc-commands.ts each carry their
 * own inline version of exactly this — read `user.injuries`, lowercase it, `includes()`, join with
 * ", ", treat the string "none" as empty. Both now call this instead.
 */
export function addFact(existing: string | null | undefined, item: string): string | null {
  const clean = (item || "").trim();
  if (!clean) return existing ?? null;
  const cur = (existing || "").trim();
  if (!cur || cur.toLowerCase() === "none") return clean;
  if (cur.toLowerCase().includes(clean.toLowerCase())) return cur; // already known
  return `${cur}, ${clean}`;
}

export interface ClientFactOperation {
  fact: keyof DurableFacts;
  operation: "assert";
  previousValue: string | null;
  value: string;
  provenance: "client_explicit";
}

/**
 * Build the users-row projection and its evidence operations from the latest locked row.
 * This function is pure so the precedence rule is testable without pretending the DB stub can
 * model PostgreSQL row locks. Durable list facts append; a new boundary never erases an unrelated
 * boundary. Work schedule is a single current slot and therefore replaces its earlier value.
 */
export function projectClientFacts(
  current: any,
  facts: DurableFacts,
): { patch: Record<string, string>; operations: ClientFactOperation[] } {
  const patch: Record<string, string> = {};
  const operations: ClientFactOperation[] = [];
  const appendFacts: Array<keyof Pick<DurableFacts,
    "injuries" | "medicalConditions" | "dietaryRestrictions" | "lifeContext" | "doNotMention"
  >> = ["injuries", "medicalConditions", "dietaryRestrictions", "lifeContext", "doNotMention"];

  for (const fact of appendFacts) {
    const asserted = facts[fact];
    if (!asserted) continue;
    const previous = current?.[fact] == null ? null : String(current[fact]);
    const next = addFact(previous, asserted);
    if (!next || next === previous) continue;
    patch[fact] = next;
    operations.push({ fact, operation: "assert", previousValue: previous, value: next, provenance: "client_explicit" });
  }

  if (facts.workSchedule && facts.workSchedule !== current?.workSchedule) {
    const previous = current?.workSchedule == null ? null : String(current.workSchedule);
    patch.workSchedule = facts.workSchedule;
    operations.push({
      fact: "workSchedule", operation: "assert", previousValue: previous,
      value: facts.workSchedule, provenance: "client_explicit",
    });
  }
  return { patch, operations };
}

/**
 * Commit what this message told us before the turn is coached.
 *
 * Called from the FRONT DOOR, not from the GPT handler, which is the whole point — the old
 * detectors sat last in the pipeline, so an injury mentioned alongside a meal was routed to the
 * food handler and never recorded at all. The user row is locked and re-read inside the transaction:
 * building a patch from the request's stale user object would lose simultaneous facts.
 *
 * The returned row is the immutable factual context for the rest of this turn. A Twilio source ID
 * makes delivery retries idempotent; separate identical utterances without the same source remain
 * separate turns. Errors fail open for availability but never masquerade as a successful commit.
 */
export async function recordClientFacts(user: any, message: string, sourceMessageId?: string): Promise<any> {
  const facts = detectFacts(message);
  try {
    const committed = await db.transaction(async (tx) => {
      // Drizzle transactions use one checked-out connection. Lock first, then re-read from that
      // same connection so two messages cannot both derive a replacement from the same old row.
      await tx.execute(sql`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`);
      const rows = await tx.select().from(users).where(eq(users.id, user.id)).limit(1);
      const current = rows[0] || user;

      const source = String(sourceMessageId || "").trim() || null;
      if (source) {
        const prior = await tx.select({ id: clientTruthCommits.id })
          .from(clientTruthCommits)
          .where(and(eq(clientTruthCommits.userId, user.id), eq(clientTruthCommits.sourceMessageId, source)))
          .limit(1);
        if (prior.length) return current;
      }

      const { patch, operations } = projectClientFacts(current, facts);
      // Every accepted source advances the context clock, even when it carries no durable profile
      // mutation. Otherwise two ordinary model turns share a revision and a slow older save can
      // still overwrite the newer understanding.
      const revision = Math.max(0, Number(current.truthRevision) || 0) + 1;

      await tx.update(users).set({ ...patch, truthRevision: revision }).where(eq(users.id, user.id));
      await tx.insert(clientTruthCommits).values({
        userId: user.id,
        sourceMessageId: source,
        revision,
        operations: operations as any,
        receivedAt: new Date(),
      });
      return { ...current, ...patch, truthRevision: revision };
    });
    if ((committed?.truthRevision || 0) !== (user?.truthRevision || 0)) {
      console.log(`[FACTS] ...${String(user.id).slice(-6)} committed truth revision ${committed.truthRevision}`);
    }
    return committed;
  } catch (e) {
    console.warn("[FACTS] non-fatal:", (e as any)?.message || e);
    return { ...user, __factCommitFailed: true };
  }
}

/**
 * WHO IS THIS, AND WHAT DID THEY JUST TELL US — bound and committed before anything routes.
 *
 * Lives here, with recordClientFacts, rather than inline at the door: the door's job is to decide
 * where a turn goes, and it cannot do that honestly until this has already happened. Keeping the
 * lookup and the commit as one named step is also what stops the two drifting apart — the commit
 * must read the row this returns, not a staler one fetched somewhere else.
 *
 * BINDING AN EXISTING IDENTITY MUST NEVER CREATE ONE. "delete my data" from a number we have
 * never seen has to keep answering "no account found", so this returns undefined for an unknown
 * caller and the door creates only after the guards have stood down.
 *
 * FAILS OPEN, DELIBERATELY. If the database is unreachable the turn still runs: a client in
 * crisis must reach the safety guards whether or not we could record what they said. The
 * alternative — refusing the turn because bookkeeping failed — is the one outcome that cannot be
 * allowed to happen here.
 */
export async function bindClientTruth(phone: string, message: string, sourceMessageId?: string): Promise<any | undefined> {
  try {
    const existing = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
    return existing[0] ? await recordClientFacts(existing[0], message, sourceMessageId) : undefined;
  } catch (e: any) {
    console.error("[TRUTH_COMMIT] unavailable before routing; safety remains live:", e?.message || e);
    return undefined;
  }
}

/** The six facts as one context line for the coach. Replaces the embedded prose. */
export async function factsLine(phone: string): Promise<string> {
  try {
    const rows = await db.select({
      injuries: users.injuries, medicalConditions: users.medicalConditions,
      dietaryRestrictions: users.dietaryRestrictions, lifeContext: users.lifeContext,
      doNotMention: users.doNotMention, workSchedule: users.workSchedule,
      foodDislikes: users.foodDislikes,
    }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    const u = rows[0];
    if (!u) return "";
    const parts: string[] = [];
    const usable = (v: any) => v && String(v).trim() && String(v).trim().toLowerCase() !== "none";
    if (usable(u.injuries)) parts.push(`Injury: ${u.injuries} — train around it, never through it.`);
    if (usable(u.medicalConditions)) parts.push(`Medical: ${u.medicalConditions}.`);
    // ONE CONSTRAINT LINE (Cut 9), through the same owner every deterministic food path uses —
    // otherwise the model and the meal plan disagree about what this person eats, and the client
    // hears both. dietary_restrictions and food_dislikes are merged and expanded here exactly as
    // they are for the plan, the swaps and the shopping list.
    const foodLine = foodConstraints({
      dietaryRestrictions: u.dietaryRestrictions, foodDislikes: u.foodDislikes,
    }).line;
    if (foodLine) parts.push(foodLine);
    if (usable(u.workSchedule) && u.workSchedule !== "standard") parts.push(`Work pattern: ${u.workSchedule}.`);
    if (usable(u.lifeContext)) parts.push(`Life right now: ${u.lifeContext}.`);
    if (usable(u.doNotMention)) parts.push(`DO NOT MENTION: ${u.doNotMention}. They asked.`);
    return parts.length ? `WHAT YOU KNOW ABOUT THIS PERSON:\n${parts.join("\n")}` : "";
  } catch {
    return "";
  }
}

/**
 * ONE LINE ABOUT WHAT IS HAPPENING AROUND THEM TODAY. Not a dump, not embeddings.
 * Occasion is context for the Coach mouth — it is not an ActionKind.
 */
export function extractSalientSituation(clientMessages: string[]): string {
  const texts = (clientMessages || []).map(s => String(s || "").trim()).filter(Boolean);
  if (texts.length === 0) return "";
  const blob = texts.join("\n").toLowerCase();
  const birthday = /\b(birthday|anniversary|wedding)\b/.test(blob);
  const eatingOut = /\b(restaurants?|eating out|go(?:ing)? out to eat|outing|date night)\b/.test(blob);
  const todayish = /\b(today|tonight|this weekend|that day is today|the day is today)\b/.test(blob);
  const foodClosed = foodDayClosedIn(blob);
  const drinks = /\b(alcohol|zero[- ]calorie drinks|just drinks)\b/.test(blob);
  if (birthday && (eatingOut || todayish)) {
    return "CURRENT SITUATION: Client has a celebration outing around today; restaurant eating is expected.";
  }
  if (eatingOut && todayish) {
    return "CURRENT SITUATION: Client expects to eat out today.";
  }
  if (foodClosed || drinks) {
    return "CURRENT SITUATION: Client has closed food for the rest of today.";
  }
  return "";
}

function foodDayClosedIn(blob: string): boolean {
  return /won'?t be able to eat|not (?:going to|gonna) eat anymore|no more food|done eating|zero[- ]calorie drinks/.test(blob);
}

/** Day-relative: 0 = today, 1 = last night, else stale (do not coach as if it is still happening). */
export function situationWhen(stamped: Array<{ text: string; at: Date }>, now?: Date | number): "today" | "last_night" | "stale" | "" {
  if (!stamped.length) return "";
  const newest = stamped.reduce((a, b) => (a.at > b.at ? a : b));
  const days = sastDaysBetween(newest.at, now);
  if (days <= 0) return "today";
  if (days === 1) return "last_night";
  return "stale";
}

/** Client-facing frame for a decision turn. Code owns this; the model does not paraphrase it. */
export function frameSituationForClient(situationLine: string, when: "today" | "last_night" | "stale" | "" = ""): string {
  const s = String(situationLine || "");
  if (!s || when === "stale") return "";
  if (/closed food/i.test(s)) {
    return when === "last_night"
      ? "You closed food last night. Today is a new day — we start from what's in front of you."
      : "You've closed food for today. We're not adding another meal.";
  }
  if (/celebration outing/i.test(s)) {
    return when === "last_night"
      ? "Last night was the birthday outing. Today we start the week — no chasing yesterday."
      : "Today is the birthday outing, so we're not trying to make the whole day perfect. Enjoy yourself — we'll keep the rest of the day sensible.";
  }
  if (/eat out today/i.test(s)) {
    return when === "last_night"
      ? "You ate out last night. Today we keep it ordinary."
      : "You're eating out today, so we're not chasing a perfect day. Keep the rest of it sensible.";
  }
  return "";
}

export async function loadSalientSituation(phone: string, currentMessage?: string): Promise<string> {
  const fromThisTurn = currentMessage ? [currentMessage] : [];
  const prior = await recentClientMessages(phone);
  return extractSalientSituation([...fromThisTurn, ...prior]);
}

export async function loadSituationFrame(phone: string, currentMessage?: string): Promise<string> {
  const stamped = await recentClientMessagesStamped(phone);
  if (currentMessage) stamped.unshift({ text: currentMessage, at: new Date() });
  const line = extractSalientSituation(stamped.map(s => s.text));
  if (!line) return "";
  const when = situationWhen(stamped.filter(s => {
    const blob = s.text.toLowerCase();
    return /birthday|restaurant|outing|eat anymore|alcohol|zero[- ]calorie|closed food/.test(blob);
  }));
  return frameSituationForClient(line, when || "today");
}

export async function recentClientMessagesStamped(phone: string): Promise<Array<{ text: string; at: Date }>> {
  try {
    const result = await pool.query(
      `SELECT message_in, created_at
         FROM chat_history
        WHERE user_id = (SELECT id FROM users WHERE phone_number = $1 LIMIT 1)
          AND message_in IS NOT NULL
          AND length(trim(message_in)) > 0
          AND message_in NOT LIKE '[%'
        ORDER BY created_at DESC
        LIMIT 24`,
      [phone],
    );
    return (result.rows as { message_in: string; created_at: Date }[])
      .map(r => ({ text: String(r.message_in || "").trim(), at: new Date(r.created_at) }))
      .filter(r => r.text);
  } catch (err) {
    console.warn("[SITUATION] unavailable:", (err as any)?.message || err);
    return [];
  }
}

export async function recentClientMessages(phone: string): Promise<string[]> {
  return (await recentClientMessagesStamped(phone)).map(r => r.text);
}

const RECALL_SHAPE = /\b(?:do you remember|what did i (?:tell|say|mention)|did i (?:tell|say|mention)|can you remember)\b/i;

/**
 * TRUST DOCTRINE (locked): owner holds it → say it; owner doesn't → don't invent it.
 * A recall question never reaches GPT. Quote owned evidence or abstain.
 * This is not a memory product and not RAG.
 */

export function looksLikeRecallQuestion(text: string): boolean {
  return RECALL_SHAPE.test(String(text || ""));
}

const RECALL_STOP = new Set([
  "do", "you", "remember", "what", "did", "i", "me", "my", "said", "say", "tell", "told",
  "mention", "mentioned", "about", "the", "a", "an", "your", "to", "of", "for", "on", "in",
  "is", "was", "when", "last", "please", "can", "could", "would", "have", "had", "that",
  "this", "with", "from", "just", "like",
]);

const RECALL_MISS = "I don't have the exact detail in front of me. Remind me.";

function recallTopic(question: string): string[] {
  return String(question || "").toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4 && !RECALL_STOP.has(w));
}

function quoteClient(line: string): string {
  const cleaned = String(line || "").replace(/\s+/g, " ").trim().slice(0, 220);
  return cleaned ? `Yes — you said: "${cleaned}"` : RECALL_MISS;
}

export function groundedRecallAnswer(opts: {
  question: string;
  clientMessages: string[];
  calorieTarget?: number | null;
  proteinTarget?: number | null;
  stepsTarget?: number | null;
  lastWorkoutDate?: string | Date | null;
  currentWeightKg?: number | null;
}): string {
  const q = String(opts.question || "");
  if (!looksLikeRecallQuestion(q)) return RECALL_MISS;
  const prior = (opts.clientMessages || []).filter(m => m && !looksLikeRecallQuestion(m));

  if (/\b(targets?|calories?|kcal|protein|steps?)\b/i.test(q)) {
    const cal = Number(opts.calorieTarget) || 0;
    const prot = Number(opts.proteinTarget) || 0;
    const steps = Number(opts.stepsTarget) || 0;
    const bits: string[] = [];
    if (cal) bits.push(`${cal} kcal`);
    if (prot) bits.push(`${prot}g protein`);
    if (steps) bits.push(`${steps} steps`);
    return bits.length
      ? `Yes — your targets are ${bits.join(", ")}.`
      : RECALL_MISS;
  }

  if (/\b(train(?:ed|ing)?|workout|gym|session)\b/i.test(q)) {
    const raw = opts.lastWorkoutDate;
    const d = raw ? new Date(raw) : null;
    if (d && !Number.isNaN(d.getTime())) {
      const when = d.toLocaleDateString("en-ZA", { day: "numeric", month: "long", timeZone: "Africa/Johannesburg" });
      return `Yes — your last logged session is ${when}.`;
    }
    return RECALL_MISS;
  }

  if (/\b(weight|scale)\b/i.test(q)) {
    const kg = Number(opts.currentWeightKg);
    return kg > 0 ? `Yes — the last weight on record is ${kg}kg.` : RECALL_MISS;
  }

  const topic = recallTopic(q);
  const overlap = topic.length
    ? prior.find(m => topic.some(t => new RegExp(`\\b${t}\\b`, "i").test(m)))
    : undefined;
  if (overlap) return quoteClient(overlap);

  // Occasion already detected by extractSalientSituation: quote the client line that
  // triggered it. Not a new store — the same 24-message scan, the client's words.
  if (/\b(weekend|saturday|sunday|today|tonight)\b/i.test(q) && extractSalientSituation(prior)) {
    const hit = prior.find(m => /\b(birthday|anniversary|wedding|restaurants?|outing|date night)\b/i.test(m));
    if (hit) return quoteClient(hit);
  }

  return RECALL_MISS;
}

export async function answerRecall(user: any, message: string): Promise<string> {
  const prior = await recentClientMessages(String(user?.phoneNumber || ""));
  return groundedRecallAnswer({
    question: message,
    clientMessages: prior,
    calorieTarget: user?.calorieTarget,
    proteinTarget: user?.proteinTarget,
    stepsTarget: user?.stepsTarget,
    lastWorkoutDate: user?.lastWorkoutDate,
    currentWeightKg: user?.currentWeight,
  });
}
