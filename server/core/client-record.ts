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
import { users, clientEvents, clientFacts, turnLedger } from "@shared/schema";
import { withheldContext } from "../life-context";
import { sastDayKey } from "../sast";

export const FACT_KINDS = ["goal", "injury", "constraint", "schedule", "preference", "life_event", "commitment"] as const;
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
- commitment: ONE small thing they commit to doing on a day, in their own words ("I'll walk after work on Thursday"), or their yes
  to the one thing COACH K'S LAST MESSAGE suggested ("yes, Thursday"). Only movement (a session, a walk, steps) or one food habit.
  detail: {"domain":"movement|food","what":"<the thing, a few words, as they or the coach put it>","due":"YYYY-MM-DD"}.
  When they say how an OPEN commitment went, it is a commitment too, with detail {"outcome":"kept|missed"}. Never one they did not make.

NOT facts: questions ("could my knee be the problem?"), other people ("my sister is pregnant"), hypotheticals,
food they ate (meals are logged elsewhere), greetings, and anything you would have to guess.
If the message corrects or replaces one of the KNOWN FACTS listed below it, set "corrects" to that known fact's subject, exactly as listed.
A fact that only starts later ("I start night shifts in December") gets "valid_from"; one that ends ("my knee is sore this week") gets "valid_until".

In your JSON, include "facts":[{"kind":"goal|injury|constraint|schedule|preference|life_event|commitment","subject":"<2-4 words, lowercase>","statement":"<the client's own words, verbatim span>","detail":{},"valid_from":"YYYY-MM-DD or null","valid_until":"YYYY-MM-DD or null","corrects":"<known subject or null>"}]}
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

/**
 * THE COMMITMENT LOOP (A19, docs/COMMITMENT-LOOP.md). One open at a time: every commitment row has the
 * subject "commitment", so a new one or its outcome supersedes the last. Due today to a week out, or
 * an outcome; anything else is dropped. Released with no message two days after it was due (valid_until).
 */
export type Commitment = { domain: "movement" | "food"; what: string; due: string; state: "open" | "asked" | "kept" | "missed"; outcome?: "kept" | "missed" };
function commitmentDetail(d: any, today = sastDayKey()): Partial<Commitment> | null {
  if (d?.outcome === "kept" || d?.outcome === "missed") return { outcome: d.outcome };
  const due = day(d?.due), what = String(d?.what || "").trim().slice(0, 80);
  if (!due || !what || !["movement", "food"].includes(d?.domain)) return null;
  const ahead = (Date.parse(due) - Date.parse(today)) / 86_400_000;
  return ahead >= 0 && ahead <= 7 ? { domain: d.domain, what, due, state: "open" } : null;
}
/** The words that name what was promised: 3+ letters, without filler, days or times ("gym", "walk", "takeaways"). */
const NOT_CONTENT = new Set(["the", "and", "for", "after", "before", "with", "from", "then", "this", "that", "each", "every", "one", "some", "today", "tomorrow", "tonight", "morning", "afternoon", "evening", "night", "week", "day", "days", "time", "minutes", "mins", "hour", "hours", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "will", "going", "get", "make", "have", "more", "less", "least"]);
const tokens = (t: string): string[] => t.toLowerCase().match(/[a-z]{3,}/g) ?? [];
const words = (t: string) => tokens(t).filter(w => !NOT_CONTENT.has(w));
/**
 * The words of the promise. `actionOnly`: the action without its setting, for deciding whether they
 * promised it at all ("a walk after work" is a walk; "work" would match any "would that work?"). A
 * reply that asks about it may name either ("How did Virgin Active go?", Codex @ ce85430).
 */
export const whatWords = (what: string, actionOnly = true): string[] => {
  const w = what.toLowerCase();
  const action = actionOnly ? words(w.split(/\b(?:after|before|during|at|on|in|by|when|while|until)\b/)[0]) : [];
  return action.length ? action : words(w);
};
/** Does `text` name the promise? A word of it, or a longer form of one ("walk" in "walking"). */
export const namesWhat = (what: string, text: string, actionOnly = true): boolean => {
  const said = tokens(text);
  return whatWords(what, actionOnly).some(w => said.some(t => t === w || t.startsWith(w)));
};
/**
 * A FOOD promise to go without ("no takeaways this week"), which a "won't" states rather than refuses
 * (Codex @ ce85430). Food only: a movement promise is never an avoidance, so "not walking on Thursday"
 * stays a refusal (Codex @ 686bc16); and "not"/"never" are not avoidance words, they echo the refusal.
 */
const AVOIDING = new Set(["no", "avoid", "cut", "stop", "skip", "less", "fewer", "zero", "without", "quit"]);
const NEGATED = /\b(?:not|never|won'?t|can'?t|cannot|don'?t|didn'?t|isn'?t|aren'?t|wasn'?t|no longer)\b|n't\b/i;
/**
 * A PROMISE THEY MADE, IN CODE (Grok attack on #545, CTO 6 Oct). The model's read is not enough: a
 * commitment is stored only when the clause holding their statement is not a negation ("I'm not
 * walking on Thursday"), and a word of `what` is in their message or in the coach's message they
 * were answering (a bare "yes" holds only what the coach just proposed).
 */
export function commitmentHeld(text: string, statement: string, what: string, coachLast: string, domain = "movement"): boolean {
  const at = text.toLowerCase().indexOf(statement.toLowerCase());
  const clause = (at > 0 ? text.slice(0, at).split(/[.!?,;\n]|\bbut\b/i).pop() ?? "" : "") + " " + statement;
  const first = what.trim().toLowerCase().split(/\s+/)[0], without = AVOIDING.has(first);
  if (domain !== "food" && without) return false; // "no walk on Thursday" is not a movement promise
  // A "won't" that negates the having states the going-without ("I won't have takeaways"); one that negates
  // the going-without itself refuses it ("I won't skip takeaways", Codex @ c1c4a52).
  if (NEGATED.test(clause) && !(domain === "food" && without && !tokens(clause).includes(first))) return false;
  return namesWhat(what, text) || namesWhat(what, coachLast);
}
const endOfDay = (d: string, plus = 0) => new Date(Date.parse(`${d}T23:59:59+02:00`) + plus * 86_400_000);
/** The client's one active commitment (open, asked, or its outcome), or null. */
export async function activeCommitment(userId: string): Promise<(Commitment & { id: string; statement: string }) | null> {
  const [r] = await db.select().from(clientFacts).where(and(eq(clientFacts.userId, userId), eq(clientFacts.kind, "commitment"),
    isNull(clientFacts.supersededBy), sql`(${clientFacts.validUntil} IS NULL OR ${clientFacts.validUntil} > now())`)).orderBy(desc(clientFacts.createdAt)).limit(1);
  return r ? { ...(r.detail as Commitment), id: r.id, statement: r.statement } : null;
}
/** What the evening job saw: the ledger showed it kept, or it asked. */
export async function markCommitment(id: string, state: "asked" | "kept"): Promise<void> {
  await db.update(clientFacts).set({ detail: sql`${clientFacts.detail} || ${JSON.stringify({ state })}::jsonb` }).where(eq(clientFacts.id, id));
}

/** turn (rootId, else phone) → the commitment that turn's reply asks about; closed by its transport verdict (#545). */
const followUpRiding = new Map<string, string>();
export function followUpRides(turnKey: string, commitmentId: string): void { followUpRiding.set(turnKey, commitmentId); }
export async function closeFollowUp(turnKey: string, accepted: boolean): Promise<void> {
  const id = followUpRiding.get(turnKey);
  followUpRiding.delete(turnKey);
  if (id && accepted) await markCommitment(id, "asked");
}
/** The ledger is the evidence (spec §4): a movement commitment is kept by a completed session, or their step target, on its due day. */
export async function settleCommitment(userId: string): Promise<Awaited<ReturnType<typeof activeCommitment>>> {
  const c = await activeCommitment(userId);
  if (!c || c.outcome || c.state === "kept" || c.domain !== "movement" || c.due > sastDayKey()) return c;
  const r = await db.execute(sql`SELECT EXISTS (SELECT 1 FROM workout_logs WHERE user_id = ${userId} AND workout_completed
      AND to_char(logged_at + interval '2 hours', 'YYYY-MM-DD') = ${c.due})
    OR EXISTS (SELECT 1 FROM step_logs s JOIN users u ON u.id = s.user_id WHERE s.user_id = ${userId}
      AND to_char(s.logged_at + interval '2 hours', 'YYYY-MM-DD') = ${c.due} AND s.steps >= coalesce(u.steps_target, 8500)) AS kept`);
  if (!(r as any).rows?.[0]?.kept) return c;
  await markCommitment(c.id, "kept");
  return { ...c, state: "kept" };
}
/** Inside WhatsApp's 24-hour window: their last message, as the record received it. */
export async function inWhatsAppWindow(userId: string): Promise<boolean> {
  const [r] = await db.select({ at: sql<Date | null>`max(${clientEvents.receivedAt})` }).from(clientEvents).where(eq(clientEvents.userId, userId));
  return !!r?.at && Date.now() - new Date(r.at).getTime() < 23 * 3600_000;
}

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
    && inOwnVoice(said, norm(f.statement))
    && (f.kind !== "commitment" || commitmentDetail(f.detail) !== null),
  ).map((f: any) => f.kind === "commitment"
    ? { ...f, subject: "commitment", statement: f.statement.trim(), detail: commitmentDetail(f.detail), valid_from: null, valid_until: null }
    : { ...f, subject: f.subject.trim().toLowerCase(), statement: f.statement.trim() });
}

/** What is already known, for the understanding call: a correction can only name what it corrects if it sees it. */
export async function knownFacts(userId: string): Promise<string> {
  // CORRECTIONS NEED THE RECORD (Codex @ c5a521b): "actually the race is in May" names no prior subject.
  const known = await db.select({ kind: clientFacts.kind, subject: clientFacts.subject, statement: clientFacts.statement })
    .from(clientFacts).where(and(eq(clientFacts.userId, userId), isNull(clientFacts.supersededBy))).orderBy(desc(clientFacts.createdAt)).limit(30);
  const [last] = await db.select({ said: sql<string>`coalesce(${turnLedger.deliveredBody}, ${turnLedger.reply})` }).from(turnLedger)
    .where(eq(turnLedger.userId, userId)).orderBy(desc(turnLedger.createdAt)).limit(1);
  const today = new Date(`${sastDayKey()}T12:00:00Z`).toLocaleDateString("en-ZA", { weekday: "long", timeZone: "UTC" });
  const context = `TODAY: ${today} ${sastDayKey()}${last?.said ? `\nCOACH K'S LAST MESSAGE: "${String(last.said).slice(0, 400)}"` : ""}`;
  return known.length ? `KNOWN FACTS:\n${known.map(k => `- ${k.kind} / ${k.subject}: "${k.statement}"`).join("\n")}\n${context}` : `KNOWN FACTS: none\n${context}`;
}

/**
 * Validate the facts the understanding call returned for one stored event, and write them.
 * `raw` is that call's JSON answer. Writes nothing on any failure; a retried message is not learned twice.
 */
/** The coach's last message before this one arrived: what a bare "yes" can be agreeing to. */
async function coachSaidBefore(userId: string, at: Date | null): Promise<string> {
  const [r] = await db.select({ said: sql<string>`coalesce(${turnLedger.deliveredBody}, ${turnLedger.reply})` }).from(turnLedger)
    .where(and(eq(turnLedger.userId, userId), lt(turnLedger.createdAt, at ?? new Date()))).orderBy(desc(turnLedger.createdAt)).limit(1);
  return String(r?.said || "");
}
export async function applyFacts(eventId: string, raw: string): Promise<number> {
  const [ev] = await db.select().from(clientEvents).where(eq(clientEvents.id, eventId)).limit(1);
  const text = (ev?.rawText?.trim() || ev?.transcriptRaw?.trim() || "");
  if (!ev || !text) return 0;
  const [done] = await db.select({ n: sql<number>`count(*)::int` }).from(clientFacts).where(eq(clientFacts.sourceEventId, eventId));
  if ((done?.n ?? 0) > 0) return 0;
  // A short message ("yes", "done!") can only answer a commitment; it states nothing else worth keeping.
  const facts = parseExtraction(raw, text).filter(f => f.kind === "commitment" || text.length >= 12);
  const open = facts.some(f => f.kind === "commitment") ? await activeCommitment(ev.userId) : null;
  let written = 0;
  for (const f of facts) {
    if (f.kind === "commitment") {
      const d = f.detail as Partial<Commitment>;
      if (d.outcome && (!open || open.outcome)) continue; // an outcome of nothing open is not a fact
      if (!d.outcome && !commitmentHeld(text, f.statement, String(d.what || ""), await coachSaidBefore(ev.userId, ev.receivedAt), String(d.domain || ""))) continue;
      f.detail = d.outcome ? { domain: open!.domain, what: open!.what, due: open!.due, state: d.outcome, outcome: d.outcome } : d;
      f.valid_until = d.outcome ? sastDayKey(Date.now() + 7 * 86_400_000) : null; // an outcome informs the next week's offer
    }
    await db.transaction(async tx => {
      const [row] = await tx.insert(clientFacts).values({
        userId: ev.userId, kind: f.kind, subject: f.subject, statement: f.statement, detail: f.detail ?? null,
        sourceEventId: ev.id,
        validFrom: day(f.valid_from) ? new Date(`${day(f.valid_from)}T00:00:00+02:00`) : new Date(),
        validUntil: f.kind === "commitment" && !f.valid_until ? endOfDay((f.detail as Commitment).due, 2)
          : day(f.valid_until) ? new Date(`${day(f.valid_until)}T23:59:59+02:00`) : null,
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

/** What the composer does about the one commitment, by its state (model-facing, never sent as is). */
const COMMITMENT_STATE = {
  kept: "KEPT. If they bring it up, recognise it in one line; never ask about it.",
  missed: "It did not happen. Any next suggestion is smaller (fewer days, shorter, easier time). No guilt words.",
  ahead: "Open. Help them get ready if it fits; don't propose another.",
  asked: "You already asked how it went: never ask again. If they answer, take it kindly; if it didn't happen, ask what got in the way, once.",
  due: "Due now and not yet asked: ask once, in one line, how it went, unless they just told you.",
} as const;
function commitmentLine(c: Commitment, said: string, today = sastDayKey()): string {
  const at = c.state === "open" ? (c.due > today ? "ahead" : "due") : c.state;
  const line = `- commitment: ${c.what}, due ${c.due} (they said: "${said}"). ${COMMITMENT_STATE[at]}`;
  return line;
}

/**
 * TWO MISSES CHANGE THE DOMAIN (spec §6, CTO 5 Oct): the last two outcomes both missed, in one domain,
 * the latest this week → no third of that kind for now; any offer is the other kind. Empty otherwise.
 */
async function restingDomain(userId: string): Promise<string> {
  const rows = await db.select({ d: clientFacts.detail, recent: sql<boolean>`${clientFacts.createdAt} > now() - interval '7 days'` })
    .from(clientFacts).where(and(eq(clientFacts.userId, userId), eq(clientFacts.kind, "commitment"), sql`${clientFacts.detail} ? 'outcome'`))
    .orderBy(desc(clientFacts.createdAt)).limit(2);
  const [a, b] = rows.map(r => r.d as Commitment);
  const twoMissed = !!a && !!b && rows[0].recent && a.outcome === "missed" && b.outcome === "missed" && a.domain === b.domain;
  return twoMissed ? `- two ${a.domain} commitments missed in a row: don't propose another ${a.domain} one this week; if you offer one, make it ${a.domain === "movement" ? "one small food habit" : "a short walk or session"}.` : ""; // model-facing
}

/** The active facts, for the coach. Empty string when there are none. */
export async function factsForCoach(userId: string): Promise<string> {
  await settleCommitment(userId).catch(() => null);
  const rows = await db.select().from(clientFacts).where(and(
    eq(clientFacts.userId, userId), isNull(clientFacts.supersededBy),
    sql`${clientFacts.validFrom} <= now()`, // a fact that starts in December is not true today
    sql`(${clientFacts.validUntil} IS NULL OR ${clientFacts.validUntil} > now())`,
  )).orderBy(desc(clientFacts.createdAt)).limit(30); // the NEWEST thirty, shown oldest first
  rows.reverse();
  const resting = await restingDomain(userId).catch(() => "");
  if (!rows.length && !resting) return "";
  return "WHAT THIS CLIENT HAS TOLD YOU (their own words; use it, never contradict it):\n"
    + [...rows.map(r => r.kind === "commitment" ? commitmentLine(r.detail as Commitment, r.statement) : `- ${r.kind}: "${r.statement}"`), resting].filter(Boolean).join("\n");
}

/**
 * WHAT THE OLD COACH ALREADY KNEW (#414). The record starts on 24 Sep; a client who told the old
 * coach about their knee, their night shifts or their dislikes weeks ago must not meet a new coach
 * that knows none of it. Once per client, before the new coach first reads their facts, this copies
 * the users profile into client_facts: the fields the client typed at onboarding and the ones set by
 * deterministic rules from their own messages (the same labels seed.ts has always given the old
 * engine), plus their dream goal and biggest struggle. NEVER the model-written stores (CTO on #426):
 * client_understanding's life story and key facts, the CIP narrative and memories were written by
 * the old model, unvalidated, and would import its inventions as "what the client told us".
 * Deterministic: no model call. Each row says where it came from
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
  if (String(user.dreamGoal || "").trim()) found.push({ kind: "goal", subject: "dream goal", statement: `their 3-month dream: ${String(user.dreamGoal).trim().slice(0, 200)}`, store: "users" });
  if (String(user.biggestStruggle || "").trim()) found.push({ kind: "constraint", subject: "biggest struggle", statement: `their biggest struggle: ${String(user.biggestStruggle).trim().slice(0, 200)}`, store: "users" });
  for (const line of keyFactsFromUser(user)) {
    const label = line.split(":")[0].trim().toLowerCase();
    // Goal and training setup are settings the snapshot already gives the coach, and they have
    // column defaults ("trains: home"): copying them would record something the client never said.
    // "life/work" is users.life_situation. Two of its values are not the client's words (#456): onboarding's
    // "office" stand-in for a client who never answered, and the withheld states ("pregnant",
    // "disordered_eating") the safety owner and ledgerNumbers carry. What they did say (breastfeeding) is kept.
    if (label === "goal" || label === "trains") continue;
    if (label === "life/work" && (user.lifeSituation === "office" || withheldContext(user.lifeSituation))) continue;
    found.push({ kind: BACKFILL_KIND.find(([re]) => re.test(label))?.[1] ?? "life_event", subject: label, statement: line, store: "users" });
  }
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
      if (!key || seen.has(key)) continue;
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

/**
 * WHAT THEY TOLD THE OLD COACH IN THEIR OWN MESSAGES (#414, second half). The profile copy above misses
 * what a client only ever said in chat ("my knee flares up on the stairs", "I work nights at Bara").
 * Once per client, their most recent messages (capped at about 5,500 characters) go through the new
 * core's same understanding call (core/coach.ts learnFromHistory: no new model call site). The model
 * proposes; this code keeps a fact only if it is verbatim, in the client's own voice, inside ONE of
 * those messages (parseExtraction, the rule every live fact meets), and dates it at that message, so
 * whatever the client says next is newer and wins. Nothing the old coach SAID is read: only what came in.
 */
const HISTORY = "backfill:history";
export async function historyToLearn(userId: string): Promise<Array<{ text: string; at: Date }>> {
  const [done] = await db.select({ n: sql<number>`count(*)::int` }).from(clientFacts)
    .where(and(eq(clientFacts.userId, userId), eq(clientFacts.extractedBy, HISTORY)));
  if ((done?.n ?? 0) > 0) return [];
  const { chatHistory } = await import("@shared/schema");
  const rows = await db.select({ text: chatHistory.messageIn, at: chatHistory.createdAt }).from(chatHistory)
    .where(and(eq(chatHistory.userId, userId), sql`length(trim(${chatHistory.messageIn})) >= 12`))
    .orderBy(desc(chatHistory.createdAt)).limit(60);
  const out: Array<{ text: string; at: Date }> = [];
  let chars = 0;
  for (const r of rows) {
    const text = String(r.text).trim().slice(0, 300);
    if (chars + text.length > 5500) break;
    chars += text.length + 1;
    out.push({ text, at: new Date(r.at as any) });
  }
  return out.reverse(); // oldest first
}

export async function writeHistoryFacts(userId: string, raw: string, msgs: Array<{ text: string; at: Date }>): Promise<number> {
  const placed = parseExtraction(raw, msgs.map(m => m.text).join("\n")).filter(f => f.kind !== "commitment").slice(0, 15)
    // One message must hold the whole statement in the client's voice; the newest such message dates it.
    .map(f => ({ f, m: [...msgs].reverse().find(m => parseExtraction(JSON.stringify({ facts: [f] }), m.text).length > 0) }))
    .filter((x): x is { f: Extracted; m: { text: string; at: Date } } => !!x.m)
    .sort((a, b) => +a.m.at - +b.m.at);
  let written = 0;
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${HISTORY + ":" + userId}))`);
    const [done] = await tx.select({ n: sql<number>`count(*)::int` }).from(clientFacts)
      .where(and(eq(clientFacts.userId, userId), eq(clientFacts.extractedBy, HISTORY)));
    if ((done?.n ?? 0) > 0) return;
    for (const { f, m } of placed) {
      const [row] = await tx.insert(clientFacts).values({ userId, kind: f.kind, subject: f.subject, statement: f.statement,
        detail: f.detail ?? null, validFrom: m.at, createdAt: m.at, extractedBy: HISTORY }).returning({ id: clientFacts.id });
      // The newer statement of the same thing wins, exactly as a live correction does (same kind only).
      await tx.update(clientFacts).set({ supersededBy: row.id, supersededAt: new Date() }).where(and(
        eq(clientFacts.userId, userId), isNull(clientFacts.supersededBy), ne(clientFacts.id, row.id),
        eq(clientFacts.kind, f.kind), eq(clientFacts.subject, f.subject), lt(clientFacts.createdAt, m.at)));
      written++;
    }
  });
  if (written) console.log(`[RECORD] learned ${written} fact(s) from earlier messages for ...${userId.slice(-6)}`);
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
