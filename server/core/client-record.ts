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
import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { users, clientEvents, clientFacts, clientUnderstanding } from "@shared/schema";

export const FACT_KINDS = ["goal", "injury", "constraint", "schedule", "preference", "life_event"] as const;
export type FactKind = typeof FACT_KINDS[number];
const EXTRACTOR = "client-record/v2 understanding-call";

type Channel = "text" | "voice" | "photo" | "video";
export function channelOf(mediaType?: string | null): Channel {
  if (!mediaType) return "text";
  if (mediaType.startsWith("audio/")) return "voice";
  if (mediaType.startsWith("image/")) return "photo";
  if (mediaType.startsWith("video/")) return "video";
  return "text";
}

/** Store the inbound message as received. Idempotent on the MessageSid; returns the event id. */
export async function recordInbound(p: { phone: string; rawText: string; mediaType?: string | null; sourceMessageId?: string; transcriptRaw?: string | null }): Promise<string | null> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.phoneNumber, p.phone)).limit(1);
  if (!u) return null; // no client row (e.g. deleted this turn): nothing to attach it to
  const [row] = await db.insert(clientEvents).values({
    userId: u.id, sourceMessageId: p.sourceMessageId || null, channel: channelOf(p.mediaType), rawText: p.rawText || "",
    transcriptRaw: p.transcriptRaw ?? null,
  }).onConflictDoNothing().returning({ id: clientEvents.id });
  if (row) return row.id;
  if (!p.sourceMessageId) return null;
  // A retry of the same delivery is the same event — for the same client, never anyone else's.
  const [existing] = await db.select({ id: clientEvents.id }).from(clientEvents)
    .where(and(eq(clientEvents.sourceMessageId, p.sourceMessageId), eq(clientEvents.userId, u.id))).limit(1);
  return existing?.id ?? null;
}

/**
 * NO MODEL CALL OF ITS OWN (CTO, 24 Sep): these instructions are folded into the new core's single
 * understanding call (#359), which returns a "facts" array beside its reading of the turn. The
 * record validates and stores what that call returns (applyFacts); it never asks a model itself.
 */
export const FACTS_INSTRUCTIONS = `You also maintain the client's record for their South African health and fitness coach.
From the client's message, list the durable facts the client states ABOUT THEMSELVES that a coach must remember:
- goal: what they are working towards (an event, a target, a date)
- injury: a body part that hurts, is injured or limits training
- constraint: something that limits food or training (budget, equipment, religion, allergy, shift work)
- schedule: when they can or cannot train or eat
- preference: food or training they like or refuse
- life_event: something happening in their life that affects coaching (bereavement, new job, exams, travel)

NOT facts: questions ("could my knee be the problem?"), other people ("my sister is pregnant"), hypotheticals,
food they ate (meals are logged elsewhere), greetings, and anything you would have to guess.
If the message corrects or replaces one of the KNOWN FACTS listed below it, set "corrects" to that known fact's subject, exactly as listed.
A fact that only starts later ("I start night shifts in December") gets "valid_from"; one that ends ("my knee is sore this week") gets "valid_until".

In your JSON, include "facts":[{"kind":"goal|injury|constraint|schedule|preference|life_event","subject":"<2-4 words, lowercase>","statement":"<the client's own words, verbatim span>","detail":{},"valid_from":"YYYY-MM-DD or null","valid_until":"YYYY-MM-DD or null","corrects":"<known subject or null>"}]}
Use "facts":[] when there is nothing.`;

type Extracted = { kind: string; subject: string; statement: string; detail?: Record<string, unknown>; valid_from?: string | null; valid_until?: string | null; corrects?: string | null };

const norm = (t: string) => t.toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();

/**
 * IN THE CLIENT'S OWN VOICE (Codex @ 4c36554). Verbatim is not enough: in `My sister said "I'm
 * pregnant"` the words are in the message but they are the sister's. A statement counts only where
 * at least one occurrence is neither inside double quotes nor reported speech ("X said / told me /
 * asked ... that"). Deterministic, so the model can propose a quote but the record never stores it.
 */
const SPEECH = new Set(["said", "says", "saying", "asked", "asks", "wrote", "writes", "texted", "mentioned", "reckons",
  "told me", "told us", "told her", "told him", "tells me", "tells us",
  // The languages our clients mix in (Codex @ 63f489a): Setswana/Sesotho "o re", "o rile", "o itse";
  // isiZulu/isiXhosa "uthi", "uthe", "wathi"; Afrikaans "sê", "gesê".
  "o re", "a re", "o rile", "o itse", "uthi", "uthe", "wathi", "sê", "gesê"]);
/** True when the words just before a statement report someone else's speech ("she said (that)"). */
function reported(before: string): boolean {
  const w = before.replace(/[:,\s]+$/, "").split(" ");
  if (w[w.length - 1] === "that") w.pop();
  return SPEECH.has(w[w.length - 1] ?? "") || SPEECH.has(w.slice(-2).join(" "));
}
function inOwnVoice(said: string, statement: string): boolean {
  for (let at = said.indexOf(statement); at !== -1; at = said.indexOf(statement, at + 1)) {
    const before = said.slice(0, at);
    const quoted = (before.match(/"/g) || []).length % 2 === 1;
    if (!quoted && !reported(before)) return true;
  }
  return false;
}
const day = (d?: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);

/** Parse and validate the extractor's answer. Anything malformed is dropped, never repaired. */
export function parseExtraction(raw: string, message: string): Extracted[] {
  let j: any;
  try { j = JSON.parse(raw); } catch { return []; }
  const facts = Array.isArray(j?.facts) ? j.facts : [];
  const said = norm(message);
  return facts.filter((f: any) =>
    f && FACT_KINDS.includes(f.kind) && typeof f.subject === "string" && f.subject.trim()
    && typeof f.statement === "string" && f.statement.trim()
    // The WHOLE statement must be the client's words (Codex @ c5a521b: a prefix check let an
    // invented clause ride on a real opening). Case, spacing and apostrophe style aside, verbatim.
    && said.includes(norm(f.statement))
    && inOwnVoice(said, norm(f.statement)),
  ).map((f: any) => ({ ...f, subject: f.subject.trim().toLowerCase(), statement: f.statement.trim() }));
}

/** What is already known, for the understanding call: a correction can only name what it corrects if it sees it. */
export async function knownFacts(userId: string): Promise<string> {
  // CORRECTIONS NEED THE RECORD (Codex @ c5a521b): "actually the race is in May" names no prior subject.
  const known = await db.select({ kind: clientFacts.kind, subject: clientFacts.subject, statement: clientFacts.statement })
    .from(clientFacts).where(and(eq(clientFacts.userId, userId), isNull(clientFacts.supersededBy))).orderBy(desc(clientFacts.createdAt)).limit(30);
  return known.length ? `KNOWN FACTS:\n${known.map(k => `- ${k.kind} / ${k.subject}: "${k.statement}"`).join("\n")}` : "KNOWN FACTS: none";
}

/**
 * Validate the facts the understanding call returned for one stored event, and write them.
 * `raw` is that call's JSON answer. Writes nothing on any failure; a retried message is not learned twice.
 */
export async function applyFacts(eventId: string, raw: string): Promise<number> {
  const [ev] = await db.select().from(clientEvents).where(eq(clientEvents.id, eventId)).limit(1);
  const text = (ev?.rawText?.trim() || ev?.transcriptRaw?.trim() || "");
  if (!ev || text.length < 12) return 0;
  const [done] = await db.select({ n: sql<number>`count(*)::int` }).from(clientFacts).where(eq(clientFacts.sourceEventId, eventId));
  if ((done?.n ?? 0) > 0) return 0;
  const facts = parseExtraction(raw, text);
  let written = 0;
  for (const f of facts) {
    await db.transaction(async tx => {
      const [row] = await tx.insert(clientFacts).values({
        userId: ev.userId, kind: f.kind, subject: f.subject, statement: f.statement, detail: f.detail ?? null,
        sourceEventId: ev.id,
        validFrom: day(f.valid_from) ? new Date(`${day(f.valid_from)}T00:00:00+02:00`) : new Date(),
        validUntil: day(f.valid_until) ? new Date(`${day(f.valid_until)}T23:59:59+02:00`) : null,
        extractedBy: EXTRACTOR,
      }).returning({ id: clientFacts.id });
      // CORRECTIONS SUPERSEDE, within the same KIND only (Codex @ c5a521b): the same subject, or the
      // known subject it says it corrects. A constraint never retires a preference that shares a word.
      const olderSubjects = [f.subject, (f.corrects || "").trim().toLowerCase()].filter(Boolean);
      await tx.update(clientFacts).set({ supersededBy: row.id, supersededAt: new Date() }).where(and(
        eq(clientFacts.userId, ev.userId), isNull(clientFacts.supersededBy),
        ne(clientFacts.id, row.id),
        // Parenthesised by or(): an unbracketed OR here once reached every client's facts.
        eq(clientFacts.kind, f.kind), inArray(clientFacts.subject, olderSubjects),
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
    sql`${clientFacts.validFrom} <= now()`, // a fact that starts in December is not true today
    sql`(${clientFacts.validUntil} IS NULL OR ${clientFacts.validUntil} > now())`,
  )).orderBy(desc(clientFacts.createdAt)).limit(30); // the NEWEST thirty, shown oldest first
  rows.reverse();
  if (!rows.length) return "";
  return "WHAT THIS CLIENT HAS TOLD YOU (their own words; use it, never contradict it):\n"
    + rows.map(r => `- ${r.kind}: "${r.statement}"`).join("\n");
}

/**
 * WHAT THE OLD COACH ALREADY KNEW (#414). The record starts on 24 Sep; a client who told the old
 * coach about their knee, their night shifts or their dislikes weeks ago must not meet a new coach
 * that knows none of it. Once per client, before the new coach first reads their facts, this copies
 * the durable old stores into client_facts: the users profile (the same labels seed.ts has always
 * given the old engine), the old engine's key facts and life story (client_understanding), and the
 * high-importance memories. Deterministic: no model call. Each row says where it came from
 * (extracted_by "backfill:<store>"), is dated at the client's sign-up so anything they tell the new
 * coach is newer and wins, and is erased with the client by the users cascade. Held constraints are
 * today-only states (sick today, food closed), not durable facts, so they are not copied.
 */
const BACKFILL_KIND: Array<[RegExp, FactKind]> = [
  [/^injury/i, "injury"],
  [/^(dietary restriction|medical|do not mention|won't eat)/i, "constraint"],
  [/^work pattern/i, "schedule"],
  [/^(their staple foods|food budget)/i, "preference"],
];
const backfilled = new Set<string>();
export function _resetBackfillCache(): void { backfilled.clear(); }

export async function backfillFromOldStores(user: any): Promise<number> {
  if (!user?.id || backfilled.has(user.id)) return 0;
  const { keyFactsFromUser } = await import("../understanding/seed");
  const found: Array<{ kind: FactKind; subject: string; statement: string; store: string }> = [];
  for (const line of keyFactsFromUser(user)) {
    const label = line.split(":")[0].trim().toLowerCase();
    // Goal and training setup are settings the snapshot already gives the coach, and they have
    // column defaults ("trains: home"): copying them would record something the client never said.
    if (label === "goal" || label === "trains") continue;
    found.push({ kind: BACKFILL_KIND.find(([re]) => re.test(label))?.[1] ?? "life_event", subject: label, statement: line, store: "users" });
  }
  const [cu] = await db.select({ profile: clientUnderstanding.profile }).from(clientUnderstanding).where(eq(clientUnderstanding.userId, user.id)).limit(1);
  const profile: any = cu?.profile || {};
  if (typeof profile.lifeStory === "string" && profile.lifeStory.trim()) found.push({ kind: "life_event", subject: "life story", statement: profile.lifeStory.trim().slice(0, 400), store: "client_understanding" });
  for (const k of Array.isArray(profile.keyFacts) ? profile.keyFacts : []) {
    if (typeof k === "string" && k.trim()) found.push({ kind: "life_event", subject: k.trim().toLowerCase().split(/\s+/).slice(0, 4).join(" "), statement: k.trim().slice(0, 300), store: "client_understanding" });
  }
  try { // memories is created by initMemoryTable at boot; a database without it has nothing to copy
    const r = await db.execute(sql`SELECT content, category FROM memories WHERE phone = ${user.phoneNumber} AND importance >= 4 ORDER BY created_at DESC LIMIT 20`);
    for (const m of ((r as any).rows || []) as Array<{ content: string; category: string }>) {
      if (m.content?.trim()) found.push({ kind: m.category === "medical" ? "constraint" : m.category === "preference" ? "preference" : "life_event", subject: `memory: ${m.category}`, statement: m.content.trim().slice(0, 300), store: "memories" });
    }
  } catch { /* no memories table */ }
  const since = user.createdAt ? new Date(user.createdAt) : new Date(Date.now() - 365 * 24 * 3600_000);
  let written = 0;
  await db.transaction(async tx => {
    // One copy per client, even when two turns arrive at once.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"backfill:" + user.id}))`);
    const [done] = await tx.select({ n: sql<number>`count(*)::int` }).from(clientFacts)
      .where(and(eq(clientFacts.userId, user.id), sql`${clientFacts.extractedBy} LIKE 'backfill:%'`));
    if ((done?.n ?? 0) > 0) return;
    const seen = new Set<string>();
    for (const f of found) {
      const key = norm(f.statement.replace(/^[^:]{1,40}:\s*/, ""));
      if (!key || seen.has(key)) continue; // client_understanding was seeded from the same users fields
      seen.add(key);
      await tx.insert(clientFacts).values({ userId: user.id, kind: f.kind, subject: f.subject, statement: f.statement,
        validFrom: since, createdAt: since, extractedBy: `backfill:${f.store}` });
      written++;
    }
  });
  backfilled.add(user.id);
  if (written) console.log(`[RECORD] backfilled ${written} fact(s) from the old stores for ...${String(user.phoneNumber || "").slice(-6)}`);
  return written;
}

/** A voice note's transcript, as the turn recorded it (turn_ledger), waited for briefly. */
async function voiceTranscript(rootId?: string): Promise<string | null> {
  if (!rootId) return null;
  for (let i = 0; i < 10; i++) {
    const r = await db.execute(sql`SELECT voice_transcript_raw t FROM turn_ledger WHERE root_id = ${rootId} AND voice_transcript_raw IS NOT NULL LIMIT 1`);
    const t = (r as any).rows?.[0]?.t as string | undefined;
    if (t) return t;
    await new Promise(res => setTimeout(res, 300));
  }
  return null;
}

/**
 * RETENTION (docs/CLIENT-RECORD.md): raw messages 12 months; a superseded fact 12 months after it
 * was superseded. Run from the record's own write path at most once a day per process, so no new
 * cron is needed and a quiet system retains nothing longer than a busy one would.
 */
let lastPurge = 0;
export async function purgeExpired(now = Date.now()): Promise<{ events: number; facts: number }> {
  const cutoff = new Date(now - 365 * 24 * 3600_000);
  const events = await db.delete(clientEvents).where(lt(clientEvents.receivedAt, cutoff)).returning({ id: clientEvents.id });
  const facts = await db.delete(clientFacts).where(lt(clientFacts.supersededAt, cutoff)).returning({ id: clientFacts.id });
  lastPurge = now;
  return { events: events.length, facts: facts.length };
}

/** The transport's one call: store what was sent, exactly. No model call. Never throws. */
export async function recordAtDoor(p: { phone: string; rawText: string; mediaType?: string | null; sourceMessageId?: string; rootId?: string }): Promise<void> {
  try {
    if (Date.now() - lastPurge > 24 * 3600_000) await purgeExpired().catch(() => {});
    const transcriptRaw = channelOf(p.mediaType) === "voice" ? await voiceTranscript(p.rootId) : null;
    await recordInbound({ ...p, transcriptRaw });
  } catch (e) {
    console.warn("[CLIENT_RECORD]", (e as Error)?.message || e);
  }
}
