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
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { users, coreShadow, turnLedger, clientEvents, chatHistory } from "@shared/schema";
import { assertAiOnline } from "../ai-offline";
import { validateActions, type CoachAction } from "../understanding/actions";
import { ONE_VOICE } from "../coach-prompt";

export const CORE_MODEL = process.env.CORE_MODEL || "gpt-4o-mini";
export const shadowOn = () => process.env.CORE_SHADOW === "on";

export interface PreTurn { userId: string; name: string; facts: string; known: string; numbers: string; conversation: Array<{ role: "user" | "assistant"; content: string }>; tools?: string }

/**
 * THE PRODUCT'S FOOD TOOLS, READ FOR THIS MESSAGE (#437 reuse; #445 deleted the handlers that used to
 * answer with them). The restaurant guide's exact macros and the swap / "the shop didn't have it"
 * tables are deterministic and correct; the composer quotes them instead of inventing numbers.
 */
async function foodTools(user: any, message: string): Promise<string> {
  const m = message.toLowerCase();
  const [{ matchRestaurant, formatRestaurantGuide }, { answerSwapAsk, answerUnavailable, foodConstraints }] =
    await Promise.all([import("../restaurants"), import("../food-swaps")]);
  const out: string[] = [];
  const hit = matchRestaurant(m);
  if (hit) out.push(`FROM THE RESTAURANT GUIDE (exact; use these items and numbers, no others):\n${formatRestaurantGuide(hit, user.goalType || "fat_loss")}`);
  const c = foodConstraints(user);
  const swap = answerSwapAsk(m, user.goalType, c) ?? answerUnavailable(message, c);
  if (swap) out.push(`FROM THE SWAP TABLE (already fits their goal and what they don't eat):\n${swap}`);
  return out.join("\n\n");
}

/**
 * THEIR REAL NUMBERS, FROM THE LEDGER (#422). Every figure comes from the owners the product keeps:
 * day-ledger (today, the 7-day window, sessions, steps, weight) and the targets on the client's row.
 * The goal profile, energy frame, health hold and food constraints come from their own owners too.
 * Nothing here is computed a second way, and the old 7-day brain snapshot is not read.
 */
export async function ledgerNumbers(user: any, message = ""): Promise<string> {
  const [{ getProgressTruth }, { getGoalProfile }, { energyFrameLine, waterTargetLitres }, { readHealthState }, { foodConstraints }] = await Promise.all([
    import("../day-ledger"), import("../goal-profiles"), import("../targets"), import("../health-state"), import("../food-swaps")]);
  const t = await getProgressTruth(user, { days: 7 });
  const sa = (o: Intl.DateTimeFormatOptions) => new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", ...o });
  const lines = [`Time now: ${sa({ weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false })} (SA). Today's numbers are a running count, not a finished day.`];
  const profile = getGoalProfile(user.goalType);
  lines.push(profile.usesMacros
    ? `Goal: ${String(user.goalType || "fat_loss").replace(/_/g, " ")}. Daily targets: ${user.calorieTarget ?? "?"} kcal, ${user.proteinTarget ?? "?"}g protein.`
    : `Goal: ${profile.label}. This client is not chasing numbers: never push a kcal or protein target.`);
  const frame = energyFrameLine(user.goalType, user.calorieTarget);
  if (frame) lines.push(frame);
  const health = readHealthState(user);
  if (health.isSick) lines.push(`Sick: resting until about ${(health as any).sickUntil ?? "they say they're better"}. Care first; no training or calorie pressure.`);
  const constraint = foodConstraints(user).line;
  if (constraint) lines.push(constraint);
  // WHAT TODAY'S OWN WORDS SETTLED (held-constraints.ts, the owner the outbound floor also reads):
  // "I'm done eating today" closes the food day, and this message can reopen it. The next-meal door
  // that honoured it was deleted with #445, so the composer is told, not trusted to remember.
  const { readHeldConstraints, foodDayClosedWith } = await import("../held-constraints");
  const held = await readHeldConstraints(user.phoneNumber, user).catch(() => null);
  if (held && foodDayClosedWith(held.foodDayClosed, message)) lines.push("Food day: CLOSED. They said they are done eating today. Suggest no more food for today; if they ask, plan tomorrow.");
  if (held?.trainingDeclined) lines.push("Training: they said they are not training today. Do not push a session.");
  const d = t.today;
  const cal = Number(user.calorieTarget) || 0;
  lines.push(d.meals.length
    ? `Food today: ${d.meals.map(m => `${m.label || "meal"}: ${m.foods}`).join("; ")}. About ${Math.round(d.kcal)} kcal and ${Math.round(d.protein)}g protein so far${cal && profile.usesMacros ? `; about ${Math.max(0, cal - Math.round(d.kcal))} kcal left in the day` : ""}.`
    : "Food today: nothing logged yet. Don't scold, don't invent intake.");
  lines.push(`Water today: ${d.water}L of ${waterTargetLitres(user.currentWeight)}L. Steps today: ${d.steps ? d.steps.toLocaleString("en-ZA") : "none logged"}.`);
  const w = t.window;
  lines.push(`Last ${w.days} days: food logged on ${w.daysLogged} day(s)${w.daysLogged ? `, averaging ${Math.round(w.avgKcal)} kcal and ${Math.round(w.avgProtein)}g protein per logged day` : ""}; ${t.sessions} training session(s); steps averaging ${Math.round(t.avgSteps).toLocaleString("en-ZA")} a day. Any streak or count must come from these numbers.`);
  const wt = t.weight;
  lines.push(wt.withheld ? "Weight: they asked us not to raise it. Never mention the scale."
    : wt.currentKg != null ? `Weight: now ${wt.currentKg}kg${wt.startKg != null && wt.startKg !== wt.currentKg ? `, started at ${wt.startKg}kg` : ""}${wt.toGoalKg != null ? `, ${Math.abs(wt.toGoalKg)}kg still to ${wt.toGoalKg < 0 ? "lose" : "gain"}` : ""}.`
    : "Weight: no weigh-in on record. Never quote a weight.");
  return lines.join("\n");
}

/** Everything the composer may know, read BEFORE the old path runs the turn. */
export async function readPreTurn(phone: string, message?: string): Promise<PreTurn | null> {
  const [u] = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
  if (!u || u.onboardingState !== "COMPLETE") return null; // onboarding is its own journey, not this composer's yet
  const { factsForCoach, knownFacts, backfillFromOldStores } = await import("./client-record");
  await backfillFromOldStores(u).catch(e => console.warn("[RECORD] backfill skipped:", (e as Error).message)); // #414: before the first read
  void learnFromHistory(u.id); // #414: what they said in chat, in the background; the next turn reads it
  const [facts, known, numbers, turns] = await Promise.all([
    factsForCoach(u.id).catch(() => ""),
    knownFacts(u.id).catch(() => "KNOWN FACTS: none"),
    ledgerNumbers(u, message).catch(() => ""),
    db.select({ input: turnLedger.inputText, sent: turnLedger.deliveredBody, reply: turnLedger.reply })
      .from(turnLedger).where(eq(turnLedger.userId, u.id)).orderBy(desc(turnLedger.createdAt)).limit(6),
  ]);
  const conversation: PreTurn["conversation"] = [];
  for (const t of turns.reverse()) {
    if (t.input?.trim()) conversation.push({ role: "user", content: t.input.slice(0, 400) });
    const said = (t.sent || t.reply || "").trim();
    if (said) conversation.push({ role: "assistant", content: said.slice(0, 500) });
  }
  const tools = message ? await foodTools(u, message).catch(() => "") : "";
  return { userId: u.id, name: (u.name || "").split(" ")[0] || "there", facts, known, numbers, conversation, tools };
}

const UNDERSTAND_SYSTEM = `You read one WhatsApp message from a coaching client and say what they want from this turn.
Return ONLY JSON: {"family":"report|question|plan|feeling|correction|other","wants":"<one short sentence>","one_question":"<the single question worth asking, or null>","uncertainty":<0..1>,"facts":[...],"actions":[...]}
- report: they are telling you what they ate, did, weighed or felt, and want it noted.
- question: they ask for advice or information.
- plan: they want a plan (a day of eating, a session, a week).
- feeling: the message is mostly about how they feel.
- correction: they are correcting something said or recorded earlier.
Ask one_question ONLY if the answer would change the advice.
"actions": what the system should DO for a fresh transaction in this message — [] for a question, a plan, pure feelings, or something already recorded. Food, training or numbers the client says they HAD or DID are a report even inside a feeling ("I had a burger last night and feel I ruined everything" logs the burger). One entry per transaction:
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
export async function understand(openai: OpenAI, message: string, known = "KNOWN FACTS: none", cap = 1500): Promise<{ u: Understanding | null; raw: string }> {
  assertAiOnline("core_understand");
  const { FACTS_INSTRUCTIONS } = await import("./client-record");
  const r = await openai.chat.completions.create({
    model: CORE_MODEL, temperature: 0, max_tokens: 500, response_format: { type: "json_object" },
    messages: [{ role: "system", content: `${UNDERSTAND_SYSTEM}\n\n${FACTS_INSTRUCTIONS}\n\n${known}` }, { role: "user", content: message.slice(0, cap) }],
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
- Coach, never report. If they reported food or activity, acknowledge it in a few words at most, folded into the coaching.
- Use what they have told you (WHAT THIS CLIENT HAS TOLD YOU): injuries, goals, shifts, budget, what they don't eat. Never make them repeat it. Never contradict it.
- Use only THEIR REAL NUMBERS. Never invent a number, a streak, a count of sessions, an absence ("it's been 14 weeks"), or a meal slot they did not say.
- South African food and life: pap, wors, amasi, chakalaka, kota, taxi-rank food, Checkers budgets, night shifts.
- Medical, pregnancy, eating-disorder and minor situations: do not coach them here; say you'll get them the right help. (Those turns are answered by the safety owner before you.)

${ONE_VOICE}`;

export async function compose(openai: OpenAI, pre: PreTurn, message: string, u: Understanding | null): Promise<string | null> {
  assertAiOnline("core_compose");
  const context = [
    `CLIENT: ${pre.name}`,
    pre.facts || "WHAT THIS CLIENT HAS TOLD YOU: nothing yet.",
    pre.numbers ? `THEIR REAL NUMBERS (authoritative — quote these, never invent):\n${pre.numbers}` : "THEIR REAL NUMBERS: none on record.",
    pre.tools || "",
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
    // #441: never hang a WhatsApp turn on a slow model (the SDK default is ten minutes and two retries).
    client = new OpenAI({ apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY, timeout: 20_000, maxRetries: 1 });
  }
  return client;
}

/**
 * THE WAVE-1 SWITCH (COVERAGE A10, A11, A13, A16, A17). CORE_WAVE1 = off | founder | on.
 * "founder" is the per-client rollout of #438: only COACH_ALERT_PHONE meets the new coach, everyone
 * else keeps the old one. Rollback is instant: set CORE_WAVE1=off, no deploy.
 */
export function coreWave1For(phone: string): boolean {
  // FOUNDER BY DEFAULT (#453, the overnight rule): the founder's number meets the new coach; every tester
  // keeps the old one until the CTO attacks this and a follow-up turns it on with the deletions.
  // `on` is everyone; `off` is the rollback.
  const mode = String(process.env.CORE_WAVE1 || "founder").toLowerCase();
  if (mode === "on") return true;
  if (mode !== "founder") return false;
  const digits = (p: string) => (p || "").replace(/\D/g, "").replace(/^0/, "27");
  const founder = digits(process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE || "");
  return !!founder && digits(phone) === founder;
}

/**
 * The new coach answering for real, at the one place the old gpt-block answered (behind the scope
 * floor in routes.ts). Returns null when it cannot answer honestly: no reading of the message (#421)
 * or no reply. The caller then falls back to the old reply, so a failure is never silence.
 */
export async function answerLive(phone: string, message: string): Promise<string | null> {
  const pre = await readPreTurn(phone, message);
  if (!pre) return null;
  const openai = await openaiClient();
  const read = await understand(openai, message, pre.known);
  if (!read.u) return null;
  // Wave 1 only talks. A turn that needs a write (a meal, steps, a goal) stays with the old path until
  // its wave-2 row switches, so nothing the client reports is ever dropped.
  const { writesState } = await import("../understanding/actions");
  if ((read.u.actions ?? []).some(a => writesState(a.type))) return null;
  const reply = (await compose(openai, pre, message, read.u))?.trim();
  return reply || null;
}

/**
 * WAVE 2, ROW A1 — FOOD IN WORDS (founder-only by default, CORE_WAVE2 = off | founder | on; #453).
 * The WRITE stays with the proven owner (food-context: the scanner owns the numbers, the slot, the
 * day), exactly the tool the executor's LOG_MEAL already calls. What moves is the REPLY: after the
 * meal is on the ledger, the new coach composes from the ledger that now holds it, instead of the
 * old receipt. The write is graded on stored state as before; the reply by the gate's judge.
 */
export function coreWave2For(phone: string): boolean {
  const mode = String(process.env.CORE_WAVE2 || "founder").toLowerCase();
  if (mode === "on") return true;
  if (mode !== "founder") return false;
  const digits = (p: string) => (p || "").replace(/\D/g, "").replace(/^0/, "27");
  const founder = digits(process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE || "");
  return !!founder && digits(phone) === founder;
}

/** The new coach's reply to a turn whose meal the old owner just wrote. null = keep the old receipt. */
export async function afterMealReply(phone: string, message: string, receipt: string): Promise<string | null> {
  if (!coreWave2For(phone)) return null;
  try {
    const pre = await readPreTurn(phone, message);
    if (!pre) return null;
    pre.numbers += `\nJUST SAVED THIS TURN (already on the ledger above; never ask them to log it again): ${receipt.replace(/\[[A-Z]+:[^\]]*\]/g, "").replace(/\s+/g, " ").slice(0, 300)}`;
    const u: Understanding = { family: "report", wants: "they told you what they ate; acknowledge it in a few words and coach the next move from today's real numbers", one_question: null, uncertainty: 0, actions: [] };
    const reply = (await compose(await openaiClient(), pre, message, u))?.trim();
    if (!reply) return null;
    // The meal card the old owner attached (a [MEDIA:…] marker) still rides with the new words.
    const media = (receipt.match(/\[MEDIA:[^\]]+\]/g) || []).join("");
    return media ? `${reply}\n${media}` : reply;
  } catch (e) {
    console.warn("[CORE_WAVE2] kept the receipt:", (e as Error)?.message || e);
    return null;
  }
}

/** One switched turn: the scope floor first, then the new coach. null = let the old engine answer. */
export async function wave1Turn(p: { phone: string; message: string; userId: string; ongoing: boolean; evidence: (f: { conversationalOnly: true }) => void }): Promise<{ reply: string; src: string } | null> {
  const { classifyDomain, declineOutOfScope } = await import("../understanding/domain-guard");
  const scope = await classifyDomain(await openaiClient(), p.message, { ongoing: p.ongoing });
  if (scope.redirectMessage) return { reply: await declineOutOfScope(p.userId, p.message, scope.redirectMessage, p.evidence), src: "scope" };
  let down: string | null = null;
  const reply = await answerLive(p.phone, p.message).catch(async e => {
    console.warn("[CORE_WAVE1] fell back:", (e as Error)?.message);
    // #441: slow or unreachable, answer honestly now; a dead key or no credits falls through to the engine that alerts.
    if ((await import("../ai-offline")).isModelSlowOrUnreachable(e)) down = (await import("../brain/reply-verifier")).COACH_NETWORK_HICCUP_REPLY;
    return null;
  });
  if (down) return { reply: down, src: "model down" };
  return reply ? { reply, src: "new coach" } : null;
}

/**
 * THEIR EARLIER MESSAGES, READ ONCE (#414). The same understanding call, over the client's recent
 * messages as one block; client-record writeHistoryFacts keeps only verbatim, own-voice facts. One call
 * per client per process at most, none when there is no history or it was already learned. Never throws.
 */
const historyTried = new Set<string>();
export function _resetHistoryTried(): void { historyTried.clear(); }
export async function learnFromHistory(userId: string): Promise<number> {
  if (historyTried.has(userId)) return 0;
  historyTried.add(userId);
  try {
    const rec = await import("./client-record");
    const msgs = await rec.historyToLearn(userId);
    if (!msgs.length) return 0;
    const block = `EARLIER MESSAGES FROM THIS CLIENT, oldest first, one per line. Read them together and list the durable facts they state about themselves:\n${msgs.map(m => m.text.replace(/\s+/g, " ")).join("\n")}`;
    const read = await understand(await openaiClient(), block, "KNOWN FACTS: none", 6000);
    return await rec.writeHistoryFacts(userId, read.raw, msgs);
  } catch (e) {
    historyTried.delete(userId); // an outage is not an answer: try again on a later turn
    console.warn("[RECORD] history skipped:", (e as Error)?.message || e);
    return 0;
  }
}

/** Run the new coach beside the old one and store what it would have said. Never throws, never sends. */
export async function runShadow(pre: PreTurn | null, message: string, rootId: string, sourceMessageId?: string): Promise<void> {
  if (!pre || !message?.trim()) return;
  const t0 = Date.now();
  try {
    const openai = await openaiClient();
    const read = await understand(openai, message, pre.known).catch(async e => {
      if ((await import("../ai-offline")).isAiOfflineError(e)) throw e; // an outage is not a verdict: no row
      return null;
    });
    const u = read?.u ?? null;
    // The record learns from the same call (#271): its own validation decides what is stored.
    if (read && sourceMessageId) {
      const [ev] = await db.select({ id: clientEvents.id }).from(clientEvents)
        .where(and(eq(clientEvents.sourceMessageId, sourceMessageId), eq(clientEvents.userId, pre.userId))).limit(1);
      if (ev) await (await import("./client-record")).applyFacts(ev.id, read.raw).catch(() => 0);
    }
    // THE SCOPE FLOOR STAYS IN FRONT (docs/COVERAGE.md A17: floor). At the switch the new coach takes
    // the place of handleGptBlock, which sits BEHIND classifyDomain in routes.ts: a scope decline never
    // reaches it. So when this turn's own last exchange was that decline, the shadow records the decline
    // instead of composing. Otherwise the gate grades a coach that answers maths homework, which is not
    // the coach testers would meet.
    const [last] = await db.select({ intent: chatHistory.intent, out: chatHistory.messageOut }).from(chatHistory)
      .where(and(eq(chatHistory.userId, pre.userId), sql`${chatHistory.createdAt} > now() - interval '2 minutes'`))
      .orderBy(desc(chatHistory.createdAt)).limit(1);
    const scoped = last?.intent === "DOMAIN_REDIRECT" && !!last.out;
    // NO CONFIDENT REPLY WITHOUT UNDERSTANDING (#421, ORDERS §4 step 4). When the reading failed, the
    // composer would be guessing what the client meant. Record the failure with no reply; the gate
    // counts it against the new coach instead of grading a guess.
    const failed = !scoped && !u;
    const reply = scoped ? last!.out : failed ? "" : await compose(openai, pre, message, u);
    await db.insert(coreShadow).values({
      userId: pre.userId, rootId, inputText: message,
      understanding: scoped ? { ...(u ?? {}), floor: "scope" } as any : failed ? { failed: "understanding_failed" } as any : u,
      factsRead: pre.facts ? pre.facts.split("\n").length - 1 : 0,
      reply: reply ?? "", model: CORE_MODEL, ms: Date.now() - t0,
    });
  } catch (e) {
    const { isAiOfflineError } = await import("../ai-offline");
    if (!isAiOfflineError(e)) console.warn("[CORE_SHADOW]", (e as Error)?.message || e);
  }
}
