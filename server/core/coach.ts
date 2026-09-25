/**
 * THE NEW COACH, IN READ-ONLY SHADOW (#272, ORDERS §4 Steps 4-5; docs/TESTER-EXPERIENCE.md).
 *
 *   understand()  ONE call: what the client wants from this turn, how sure it is, and the durable facts it
 *                 states for their record (#271, validated and stored by client-record.ts applyFacts).
 *   compose()     the ONE composer: one reply, from what the client told us (client_facts, #271),
 *                 their real numbers (the client snapshot), the recent conversation, and the rules
 *                 in TESTER-EXPERIENCE.md. It coaches; it never files a report.
 *   runShadow()   runs both beside the old path on the same raw message and the state read BEFORE
 *                 the turn, and stores what it WOULD have said in core_shadow. It never writes
 *                 client state and never sends. The replay gate grades core_shadow per journey
 *                 against the old path; a family switches only when it wins with no hard failure.
 *
 * Off unless CORE_SHADOW=on: in production it doubles model spend per message, so it is switched
 * on for the gate and for a measured tester sample, not by default.
 */
import type OpenAI from "openai";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { users, coreShadow, turnLedger, clientEvents } from "@shared/schema";
import { assertAiOnline } from "../ai-offline";
import { validateActions, type CoachAction } from "../understanding/actions";

export const CORE_MODEL = process.env.CORE_MODEL || "gpt-4o-mini";
export const shadowOn = () => process.env.CORE_SHADOW === "on";

export interface PreTurn { userId: string; name: string; facts: string; known: string; numbers: string; conversation: Array<{ role: "user" | "assistant"; content: string }> }

/** Everything the composer may know, read BEFORE the old path runs the turn. */
export async function readPreTurn(phone: string): Promise<PreTurn | null> {
  const [u] = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
  if (!u || u.onboardingState !== "COMPLETE") return null; // onboarding is its own journey, not this composer's yet
  const [{ factsForCoach, knownFacts }, { buildClientSnapshot }] = await Promise.all([import("./client-record"), import("../brain/client-snapshot")]);
  const [facts, known, numbers, turns] = await Promise.all([
    factsForCoach(u.id).catch(() => ""),
    knownFacts(u.id).catch(() => "KNOWN FACTS: none"),
    buildClientSnapshot(u).catch(() => ""),
    db.select({ input: turnLedger.inputText, sent: turnLedger.deliveredBody, reply: turnLedger.reply })
      .from(turnLedger).where(eq(turnLedger.userId, u.id)).orderBy(desc(turnLedger.createdAt)).limit(6),
  ]);
  const conversation: PreTurn["conversation"] = [];
  for (const t of turns.reverse()) {
    if (t.input?.trim()) conversation.push({ role: "user", content: t.input.slice(0, 400) });
    const said = (t.sent || t.reply || "").trim();
    if (said) conversation.push({ role: "assistant", content: said.slice(0, 500) });
  }
  return { userId: u.id, name: (u.name || "").split(" ")[0] || "there", facts, known, numbers, conversation };
}

const UNDERSTAND_SYSTEM = `You read one WhatsApp message from a coaching client and say what they want from this turn.
Return ONLY JSON: {"family":"report|question|plan|feeling|correction|other","wants":"<one short sentence>","one_question":"<the single question worth asking, or null>","uncertainty":<0..1>,"facts":[...],"actions":[...]}
- report: they are telling you what they ate, did, weighed or felt, and want it noted.
- question: they ask for advice or information.
- plan: they want a plan (a day of eating, a session, a week).
- feeling: the message is mostly about how they feel.
- correction: they are correcting something said or recorded earlier.
Ask one_question ONLY if the answer would change the advice.
"actions": what the system should DO for a fresh transaction in this message — [] for a question, a plan, feelings, or something already recorded. One entry per transaction:
{"type":"LOG_MEAL","foodText":"<the food in their words, no calories>","meal":"breakfast|lunch|dinner|snack or omit","retro":"<a past day as they said it, or omit>","needsConfirmation":<true if the amount is vague>}
{"type":"LOG_STEPS","count":<n>} · {"type":"LOG_WATER","litres":<n>} · {"type":"LOG_WEIGHT","kg":<n>}
{"type":"REMOVE_LAST_MEAL"} · {"type":"SHOW_MEALS"} · {"type":"SHOW_WORKOUT"} · {"type":"SET_SICK","days":<n>} · {"type":"END_SICK"} · {"type":"SET_REMINDER","body":"<what>","when":"<as they said it>"}
{"type":"CORRECT_MEAL","from":"<what the record wrongly holds, or empty>","to":"<what it really was, or empty>","meal":"<slot or omit>","retro":"<a past day or omit>"} for a meal ALREADY logged that they say was wrong (never also LOG_MEAL for it)
{"type":"LOG_WORKOUT","what":"<the session in their words, or omit>","retro":"<a past day or omit>"} for a session they DID, never one planned, skipped or moved
{"type":"SET_GOAL","goal":"fat_loss|muscle_gain|recomposition"} only when they ask to change their goal`;

/** `actions` are what the new core WOULD do, validated by the existing permission gate (understanding/actions.ts).
 *  In shadow they are recorded, never performed; the gate compares them with what the old path stored (#391). */
export type Understanding = { family: string; wants: string; one_question: string | null; uncertainty: number; actions: CoachAction[] };

/**
 * ONE CALL READS THE MESSAGE (CTO, 24 Sep): what the client wants from this turn AND the durable facts
 * it states for their record (#271). `raw` is that call's whole JSON answer; the record validates its
 * "facts" (client-record.ts applyFacts) — the model proposes, code decides what is stored.
 */
export async function understand(openai: OpenAI, message: string, known = "KNOWN FACTS: none"): Promise<{ u: Understanding | null; raw: string }> {
  assertAiOnline("core_understand");
  const { FACTS_INSTRUCTIONS } = await import("./client-record");
  const r = await openai.chat.completions.create({
    model: CORE_MODEL, temperature: 0, max_tokens: 500, response_format: { type: "json_object" },
    messages: [{ role: "system", content: `${UNDERSTAND_SYSTEM}\n\n${FACTS_INSTRUCTIONS}\n\n${known}` }, { role: "user", content: message.slice(0, 1500) }],
  });
  const raw = r.choices[0]?.message?.content || "{}";
  try {
    const j = JSON.parse(raw);
    if (typeof j.family !== "string") return { u: null, raw };
    return { u: { family: j.family, wants: String(j.wants || ""), one_question: j.one_question ? String(j.one_question) : null, uncertainty: Number(j.uncertainty) || 0,
      actions: validateActions(j.actions ?? []) }, raw };
  } catch { return { u: null, raw }; }
}

/** The rules of the product, in the composer's own words (docs/TESTER-EXPERIENCE.md). */
const COMPOSE_SYSTEM = `You are Coach K, a warm, direct South African health and fitness coach on WhatsApp.
Rules — every reply:
- Coach, never report. Never a receipt ("Logged: 540 kcal") on its own. Say what this means for them and give ONE clear next move.
- If they reported food or activity, acknowledge it in a few words at most, folded into the coaching.
- Use what they have told you (WHAT THIS CLIENT HAS TOLD YOU): injuries, goals, shifts, budget, what they don't eat. Never make them repeat it. Never contradict it.
- Use only THEIR REAL NUMBERS. Never invent a number, a streak, a count of sessions, an absence ("it's been 14 weeks"), or a meal slot they did not say.
- South African food and life: pap, wors, amasi, chakalaka, kota, taxi-rank food, Checkers budgets, night shifts.
- No menus ("reply 1, 2 or 3"), no "log a meal" nags, no lectures, no shame. At most one question, and only if the answer changes the advice.
- Short: 2-4 sentences, one WhatsApp message. Plain text; *bold* sparingly.
- Medical, pregnancy, eating-disorder and minor situations: do not coach them here; say you'll get them the right help. (Those turns are answered by the safety owner before you.)`;

export async function compose(openai: OpenAI, pre: PreTurn, message: string, u: Understanding | null): Promise<string | null> {
  assertAiOnline("core_compose");
  const context = [
    `CLIENT: ${pre.name}`,
    pre.facts || "WHAT THIS CLIENT HAS TOLD YOU: nothing yet.",
    pre.numbers ? `THEIR REAL NUMBERS (authoritative — quote these, never invent):\n${pre.numbers}` : "THEIR REAL NUMBERS: none on record.",
    u ? `THIS TURN: ${u.family} — they want: ${u.wants}${u.one_question ? `\nIf you need one thing, ask: ${u.one_question}` : ""}` : "",
  ].filter(Boolean).join("\n\n");
  const r = await openai.chat.completions.create({
    model: CORE_MODEL, temperature: 0.4, max_tokens: 300,
    messages: [{ role: "system", content: `${COMPOSE_SYSTEM}\n\n${context}` }, ...pre.conversation, { role: "user", content: message }],
  });
  const reply = (r.choices[0]?.message?.content || "").trim();
  return reply || null;
}

let client: OpenAI | null = null;
async function openaiClient(): Promise<OpenAI> {
  if (!client) {
    const OpenAI = (await import("openai")).default;
    client = new OpenAI({ apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY });
  }
  return client;
}

/** Run the new coach beside the old one and store what it would have said. Never throws, never sends. */
export async function runShadow(pre: PreTurn | null, message: string, rootId: string, sourceMessageId?: string): Promise<void> {
  if (!pre || !message?.trim()) return;
  const t0 = Date.now();
  try {
    const openai = await openaiClient();
    const read = await understand(openai, message, pre.known).catch(() => null);
    const u = read?.u ?? null;
    // The record learns from the same call (#271): its own validation decides what is stored.
    if (read && sourceMessageId) {
      const [ev] = await db.select({ id: clientEvents.id }).from(clientEvents)
        .where(and(eq(clientEvents.sourceMessageId, sourceMessageId), eq(clientEvents.userId, pre.userId))).limit(1);
      if (ev) await (await import("./client-record")).applyFacts(ev.id, read.raw).catch(() => 0);
    }
    const reply = await compose(openai, pre, message, u);
    await db.insert(coreShadow).values({
      userId: pre.userId, rootId, inputText: message, understanding: u, factsRead: pre.facts ? pre.facts.split("\n").length - 1 : 0,
      reply: reply ?? "", model: CORE_MODEL, ms: Date.now() - t0,
    });
  } catch (e) {
    const { isAiOfflineError } = await import("../ai-offline");
    if (!isAiOfflineError(e)) console.warn("[CORE_SHADOW]", (e as Error)?.message || e);
  }
}
