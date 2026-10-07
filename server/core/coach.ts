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
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { users, coreShadow, turnLedger, clientEvents, chatHistory, mealLogs } from "@shared/schema";
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
  const [{ getProgressTruth }, { getGoalProfile }, { energyFrameLine, waterTargetLitres, stepBurnKcal }, { readHealthState }, { foodConstraints }] = await Promise.all([
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
  // Walking calories (from advice-commands, deleted 6 Oct): the estimate is stepBurnKcal's, and the target already counts activity.
  const burn = d.steps ? stepBurnKcal(d.steps, Number(user.currentWeight) || 75) : 0;
  lines.push(`Water today: ${d.water}L of ${waterTargetLitres(user.currentWeight)}L. Steps today: ${d.steps ? `${d.steps.toLocaleString("en-ZA")} (about ${burn} kcal burned walking; their calorie target already allows for activity, so these are not "eaten back")` : "none logged"}.`);
  const w = t.window;
  lines.push(`Last ${w.days} days: food logged on ${w.daysLogged} day(s)${w.daysLogged ? `, averaging ${Math.round(w.avgKcal)} kcal and ${Math.round(w.avgProtein)}g protein per logged day` : ""}; ${t.sessions} training session(s); steps averaging ${Math.round(t.avgSteps).toLocaleString("en-ZA")} a day. Any streak or count must come from these numbers.`);
  const wt = t.weight;
  lines.push(wt.withheld ? "Weight: they asked us not to raise it. Never mention the scale."
    : wt.currentKg != null ? `Weight: now ${wt.currentKg}kg${wt.startKg != null && wt.startKg !== wt.currentKg ? `, started at ${wt.startKg}kg` : ""}${wt.toGoalKg != null ? `, ${Math.abs(wt.toGoalKg)}kg still to ${wt.toGoalKg < 0 ? "lose" : "gain"}` : ""}.`
    : "Weight: no weigh-in on record. Never quote a weight.");
  if (!wt.withheld) { // A12: "am I on track?" is answered from the trajectory owner's numbers, never a second computation
    const r = await (await import("../trajectory-report")).getTrajectoryForUser(user.id).catch(() => null);
    if (r) lines.push(`Trajectory from their last 7 days of logs (quote only these numbers): ${r.whatsappText.replace(/\*/g, "").replace(/\s+/g, " ").slice(0, 500)}`);
  }
  return lines.join("\n");
}

/** Everything the composer may know, read BEFORE the old path runs the turn. */
export async function readPreTurn(phone: string, message?: string): Promise<PreTurn | null> {
  const [u] = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
  if (!u || u.onboardingState !== "COMPLETE") return null; // onboarding is its own journey, not this composer's yet
  // THE SPEND CAP COVERS THE NEW COACH TOO (#340): over the ceiling, or unable to read spend, it stands down
  // and every caller falls back to what the cap already owns (the short degraded reply, the plain fact).
  if (!(await (await import("../cost-tracking")).isUnderGPTCallLimit(u.id))) return null;
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
Return ONLY JSON: {"family":"report|question|plan|feeling|correction|other","scope":"in|out","wants":"<one short sentence>","one_question":"<the single question worth asking, or null>","uncertainty":<0..1>,"facts":[...],"actions":[...]}
- scope: "out" ONLY when they ask for help with something that is not their health, body, food, training, sleep, stress, mood or wellbeing (homework, a CV, coding, a legal or money question). Anything in their life that touches those is "in".
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
export type Understanding = { family: string; wants: string; one_question: string | null; uncertainty: number; actions: CoachAction[]; scope?: "in" | "out" };

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
    // A reading that does not say how sure it is fails closed (#593 attack): fully uncertain, so a write is confirmed first.
    const unsure = typeof j.uncertainty === "number" && j.uncertainty >= 0 && j.uncertainty <= 1 ? j.uncertainty : 1;
    return { u: { family: j.family, wants: String(j.wants || ""), one_question: j.one_question ? String(j.one_question) : null, uncertainty: unsure,
      actions: validateActions(j.actions ?? []), scope: j.scope === "out" ? "out" : "in" }, raw };
  } catch { return { u: null, raw }; }
}

/**
 * A due commitment asked about inside a reply is its one follow-up (A19). Only a reply that names it and
 * asks counts (#545 attack @ 07f9c1f: any "?" did), and it is marked asked only once the transport
 * accepts that reply (closeFollowUp, the same verdict B7 uses): a dropped send leaves it open.
 */
async function foldedFollowUp(phone: string, pre: PreTurn, reply: string): Promise<void> {
  if (!pre.facts.includes("Due now and not yet asked") || !reply.includes("?")) return;
  const { activeCommitment, followUpRides, namesWhat } = await import("./client-record");
  const c = await activeCommitment(pre.userId);
  const named = !!c && namesWhat(c.what, reply, false); // 3+ letters ("gym", Grok on #545), the setting too ("Virgin Active", Codex @ ce85430)
  // Keyed by THIS turn (#545 @ 5bb55de): an unrelated reply delivered first must not close another turn's follow-up.
  if (c && !c.outcome && c.state === "open" && named) followUpRides((await import("../handlers/chat-log")).turnRootId() ?? phone, c.id);
}

/** The rules of the product, in the composer's own words (docs/TESTER-EXPERIENCE.md). */
const COMPOSE_SYSTEM = `You are Coach K, a warm, direct South African health and fitness coach on WhatsApp.
Rules — every reply:
- Coach, never report. If they reported food or activity, acknowledge it in a few words at most, folded into the coaching.
- Use what they have told you (WHAT THIS CLIENT HAS TOLD YOU): injuries, goals, shifts, budget, what they don't eat. Never make them repeat it. Never contradict it.
- Use only THEIR REAL NUMBERS. Never invent a number, a streak, a count of sessions, an absence ("it's been 14 weeks"), or a meal slot they did not say.
- South African food and life: pap, wors, amasi, chakalaka, kota, taxi-rank food, Checkers budgets, night shifts.
- Help them follow through (A19): when no commitment is listed and the turn has a natural next step, your one question may offer ONE small thing on a named day (a session, a walk, one food habit), for them to say yes to. Never when they are unwell, grieving, or have closed the day.
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

type Reminder = { type: "SET_REMINDER"; body: string; when: string };
/** A14: reminders in their own words, each saved by the proven reminder command, which confirms the time. */
async function saveReminders(phone: string, message: string, asks: Reminder[], confidence: number): Promise<string | null> {
  const [user] = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
  if (!user) return null;
  const { handleReminderCommand } = await import("../handlers/reminders-handler");
  const { shouldAutoExecute } = await import("../understanding/actions");
  const sure = asks.every(a => shouldAutoExecute(a as any, confidence));
  const replies: string[] = [];
  for (const a of sure ? asks : asks.slice(0, 1)) {
    const synth = `remind me to ${a.body}${sure ? ` ${a.when}` : ""}`.replace(/\s+/g, " ").trim();
    const r = await handleReminderCommand({ phone, message: synth, m: synth.toLowerCase(), user, said: message, noLog: asks.length > 1 });
    if (r) replies.push(r);
  }
  const reply = replies.join("\n\n");
  // Several reminders, one message: one row in the chat record, holding what they actually got (#537).
  if (asks.length > 1 && reply) await (await import("../handlers/chat-log")).logChat(user.id, message, reply, "REMINDER_SET").catch(() => {});
  return reply || null;
}

/** What the executor can write from the new coach's reading. LOG_WORKOUT has no executor tool yet (A8). */
const LOGS = new Set(["LOG_MEAL", "LOG_STEPS", "LOG_WEIGHT", "LOG_WATER"]), READS = new Set(["SHOW_WORKOUT"]);

/**
 * #586: the new coach's validated logs through executeAction, the tool the meaning engine used for its
 * cohort only. A vague amount or a shaky reading gets the executor's confirm question, parked so the
 * client's "yes" lands in resumeEngineConfirm. `card` is the meal card marker the receipt carried.
 */
/** The meals a redrawn card names: those written, on the last written meal's day; the biggest one's protein (#616 review). */
export function cardMeals(written: Array<{ name: string; sid: string }>, rows: Array<{ sid: string | null; protein: number | null; at: Date | null }>, dayKey: (d: Date) => string) {
  const last = rows.find(r => r.sid === written[written.length - 1]?.sid);
  if (!last?.at) return null;
  const onDay = rows.filter(r => r.at && dayKey(r.at) === dayKey(last.at!));
  return { at: last.at, name: written.filter(w => onDay.some(r => r.sid === w.sid)).map(w => w.name).join(" + ").slice(0, 40), protein: Math.max(0, ...onDay.map(r => Number(r.protein) || 0)) };
}

async function logThroughExecutor(phone: string, message: string, actions: CoachAction[], confidence: number, sourceMessageId?: string):
  Promise<{ performed: boolean; confirm: string | null; reply: string; card: string; user?: any }> {
  const [user] = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
  const out = { performed: false, confirm: null as string | null, reply: "", card: "", user };
  if (!user) return out;
  const [{ executeAction, setPendingConfirm }, { describeAction }, { deriveSourceId }, { logChat }] = await Promise.all([
    import("../understanding/executor"), import("../understanding/actions"), import("../understanding/live"), import("../handlers/chat-log")]);
  const written: Array<{ name: string; sid: string }> = [];
  for (const action of actions) {
    const sid = `${sourceMessageId || deriveSourceId(user.id, message)}#${describeAction(action)}`;
    const exec = await executeAction(action, { user, phone, confidence, clientMessage: message, sourceMessageId: sid });
    await logChat(user.id, message, `${describeAction(action)} → ${exec.performed ? "performed" : exec.confirmed ? "confirm" : exec.skipped ? "skip" : exec.error ? "error" : "noop"}`, "ENGINE_ACTION").catch(() => {});
    if (exec.unwritten && exec.reply && !out.confirm) out.confirm = exec.reply; // the owner's own question: nothing is claimed
    // A READ ("what's my workout today?") is the owner's answer, shown as it is: it was dropped, and
    // the model answered without the programme (founder's Monday plan, item 4).
    if (!exec.performed && !exec.confirmed && !exec.unwritten && !exec.skipped && !exec.error && exec.reply && READS.has(action.type)) out.reply = [out.reply, exec.reply].filter(Boolean).join("\n\n");
    if (exec.confirmed && !out.confirm) {
      setPendingConfirm(user.id, action);
      await db.update(users).set({ awaitingInputType: "engine_confirm" }).where(eq(users.id, user.id)).catch(() => {});
      out.confirm = exec.reply;
    }
    if (exec.performed) {
      out.performed = true;
      if (action.type === "LOG_MEAL") written.push({ name: action.foodText, sid });
      const card = (exec.reply.match(/\[MEDIA:[^\]]+\]/) || [""])[0];
      if (!out.card) out.card = card;
      if (!out.reply) out.reply = exec.reply.replace(card, "").trim();
    }
  }
  // SEVERAL MEALS IN ONE MESSAGE (7 Oct, founder: people send lists): the card drawn after the first meal held only that
  // meal. Once every meal is written, it is drawn again from the day's real totals: the last written meal's day, naming
  // only the meals written on that day (never one waiting for a yes), with the biggest one's protein (#616 review).
  if (out.card && written.length > 1) {
    const [{ forgetCard }, { macroCardMarker }, { sastDayKey, isPastSastDay }] = await Promise.all([
      import("../card-policy"), import("../macro-card-attach"), import("../sast")]);
    const rows = await db.select({ sid: mealLogs.sourceMessageId, protein: mealLogs.proteinInt, at: mealLogs.loggedAt }).from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), inArray(mealLogs.sourceMessageId, written.map(w => w.sid)))).catch(() => []);
    const pick = cardMeals(written, rows, sastDayKey);
    if (pick) {
      forgetCard(user.id);
      out.card = await macroCardMarker({ user, mealName: pick.name, mealProtein: pick.protein, forDate: isPastSastDay(pick.at) ? pick.at : undefined }).catch(() => out.card) || out.card;
    }
  }
  return out;
}

/**
 * The new coach answering for real, at the one place the old gpt-block answered (behind the scope
 * floor in routes.ts). Returns null when it cannot answer honestly: no reading of the message (#421)
 * or no reply. The caller then falls back to the old reply, so a failure is never silence.
 */
export async function answerLive(phone: string, message: string, opts: { final?: boolean; sourceMessageId?: string } = {}): Promise<string | null> {
  const pre = await readPreTurn(phone, message);
  if (!pre) return null;
  const openai = await openaiClient();
  const read = await understand(openai, message, pre.known);
  liveReads.set(phone, { at: Date.now(), raw: read.raw }); // the record learns from this read once the door has stored the message
  if (!read.u) return null;
  // Wave 1 only talks. A turn that needs a write (a meal, steps, a goal) stays with the old path until
  // its wave-2 row switches, so nothing the client reports is ever dropped.
  const { writesState } = await import("../understanding/actions");
  const writes = (read.u.actions ?? []).filter(a => writesState(a.type));
  // A14: reminders asked for in their own words ("nudge me before gym on Thursday") are saved by the
  // proven reminder command, which confirms the exact fire time; every one of them, never promised
  // without a row. Unsure of the time (the existing confidence gate), it asks rather than guesses.
  if (writes.length && writes.every(a => a.type === "SET_REMINDER")) return saveReminders(phone, message, writes as Reminder[], 1 - (read.u.uncertainty || 0));
  // #586: a meal, steps, a weight or water that no writer above took ("kota from the spaza", isiXhosa)
  // is written by the proven executor for every client, then the reply is composed from the record.
  if (writes.length && writes.every(a => LOGS.has(a.type))) {
    const logged = await logThroughExecutor(phone, message, writes, 1 - (read.u.uncertainty || 0), opts.sourceMessageId);
    if (logged.confirm) return logged.card + [logged.reply, logged.confirm].filter(Boolean).join("\n\n");
    if (logged.performed) {
      // The proven post-write composer (A1/A5): it knows the fact is saved, keeps the card and the guardrail.
      const receipt = logged.card + logged.reply;
      const kind = writes.every(a => a.type === "LOG_STEPS") ? "steps" : writes.some(a => a.type === "LOG_MEAL") ? "food" : null;
      return (kind ? await afterLogReply(phone, message, receipt, kind, logged.user) : null) ?? (receipt.trim() || null);
    }
  }
  // At the last door (`final`) every writer has already declined: answer anyway; the integrity floor stops a claimed write.
  if (!opts.final && writes.length) return null;
  const reply = (await compose(openai, pre, message, read.u))?.trim();
  if (reply) await foldedFollowUp(phone, pre, reply).catch(() => {});
  return reply || null;
}

/**
 * WAVE 2, ROW A1 — FOOD IN WORDS (on for everyone, #459, ORDERS §0d; CORE_WAVE2=off is the rollback).
 * The WRITE stays with the proven owner (food-context: the scanner owns the numbers, the slot, the
 * day), exactly the tool the executor's LOG_MEAL already calls. What moves is the REPLY: after the
 * meal is on the ledger, the new coach composes from the ledger that now holds it, instead of the
 * old receipt. The write is graded on stored state as before; the reply by the gate's judge.
 */
export function coreWave2For(_phone: string): boolean {
  return String(process.env.CORE_WAVE2 || "on").toLowerCase() !== "off";
}

/**
 * The new words, or null to keep the receipt (#455 attack). The receipt stays when it carries a
 * status the words could hide: an honest gap ("could not price X"), a correction ("Fixed ✅"), a
 * past day ("Logged to Tuesday") or a question the old flow is waiting on. The model's own instructions are stripped by their one owner, so
 * the canonical close stays the only move.
 */
// A receipt that ASKS something ("How did it feel?") is an old flow awaiting the answer (programme
// progression, portions): the words would drop the question, so it stays.
const keepsReceipt = (receipt: string) => /could not price|not in the total|Fixed ✅|logged to |\?/i.test(receipt.replace(/\[[A-Z]+:[^\]]*\]/g, ""));
export function afterLogWords(reply: string, receipt: string, strip: (r: string) => string): string | null {
  if (keepsReceipt(receipt)) return null;
  const kept = strip(reply).trim();
  if (!kept) return null;
  const media = (receipt.match(/\[MEDIA:[^\]]+\]/g) || []).join("");
  return media ? `${kept}\n${media}` : kept;
}

/**
 * WAVE 2, ROW A2 — CORRECT A MEAL. The new coach reads WHAT was wrong and WHAT it really was ("Hayi, I had a
 * burger, not pap" → pap → burger); the proven correction engine (food-log-mgmt applyCorrection, priced by the
 * quantity authority) does the write. null = the deterministic parse stands, exactly as before.
 */
export async function correctionRead(phone: string, message: string): Promise<{ from: string; to: string; meal?: string } | null> {
  if (!coreWave2For(phone)) return null;
  try {
    const held = frontReads.get(phone); // #592: the front door already read this message; never a second call
    const pre = held?.message === message ? null : await readPreTurn(phone, message);
    if (!held && !pre) return null;
    const read = held?.message === message ? held : await understand(await openaiClient(), message, pre!.known);
    const a = (read.u?.actions ?? []).find(x => x.type === "CORRECT_MEAL") as { from?: string; to?: string; meal?: string } | undefined;
    // The meal they named travels too (#466 attack): without it the writer edited the newest meal.
    return a?.from && a?.to ? { from: a.from.toLowerCase(), to: a.to.toLowerCase(), ...(a.meal ? { meal: a.meal } : {}) } : null;
  } catch (e) {
    console.warn("[CORE_WAVE2] correction read failed, the parser stands:", (e as Error)?.message || e);
    return null;
  }
}

const JUST_LOGGED = {
  food: "they told you what they ate; acknowledge it in a few words, from today's real numbers",
  steps: "they told you their steps; acknowledge them in a few words, from today's real step count and their target", // A5
  workout: "they told you they trained; acknowledge the session in a few words, from this week's real sessions", // A8
  goal: "they just confirmed a new goal; say what it is and their new daily targets, from their real numbers, in a few words", // A12
} as const;

/** The new coach's reply to a turn whose fact the proven owner just wrote. null = keep the old receipt. */
export async function afterLogReply(phone: string, message: string, receipt: string, kind: keyof typeof JUST_LOGGED = "food", user?: any): Promise<string | null> {
  if (!coreWave2For(phone) || keepsReceipt(receipt)) return null;
  try {
    const pre = await readPreTurn(phone, message);
    if (!pre) return null;
    // THE HEALTH-STANDARD GUARDRAIL IS DETERMINISTIC (#575): given the client, today's line ("caffeine is not
    // fuel…") follows the new words, and is kept out of the composer's context so it is said once.
    const guard = user ? await (await import("../nutrition-guardrails")).nutritionGuardrailNudge(user) : "";
    if (guard) receipt = receipt.replace(guard.trim(), "");
    pre.numbers += `\nJUST SAVED THIS TURN (already on the ledger above; never ask them to log it again): ${receipt.replace(/\[[A-Z]+:[^\]]*\]/g, "").replace(/\s+/g, " ").slice(0, 300)}`;
    const u: Understanding = { family: "report", wants: `${JUST_LOGGED[kind]}. Give no instruction or next step: the one next move is added after your words`, one_question: null, uncertainty: 0, actions: [] };
    const reply = (await compose(await openaiClient(), pre, message, u))?.trim();
    if (!reply) return null;
    // The meal card the old owner attached (a [MEDIA:…] marker) still rides with the new words.
    const { stripModelDirectives } = await import("../brain/reply-verifier");
    const words = afterLogWords(reply, receipt, r => stripModelDirectives(r, { modelAuthored: true } as any).kept);
    if (words) await foldedFollowUp(phone, pre, words).catch(() => {});
    return words ? `${words}${guard}` : words;
  } catch (e) {
    console.warn("[CORE_WAVE2] kept the receipt:", (e as Error)?.message || e);
    return null;
  }
}

/**
 * WAVE 4 (B1 first, #319): the messages the coach starts, in the new coach's words. CORE_WAVE4=off is the
 * rollback to the old composers, with no deploy. The DECISION stays with its owner (decideProactive);
 * the new coach writes only the recognition around it, from the record and the ledger, and the caller
 * appends the decision's line as the one instruction.
 */
export function coreWave4For(_phone: string): boolean {
  return String(process.env.CORE_WAVE4 || "on").toLowerCase() !== "off";
}
const SCHEDULED = {
  morning: "It is early morning: your scheduled morning message. Greet them by first name and recognise YESTERDAY in one or two short lines, only from YESTERDAY's real numbers; if nothing was logged, don't mention it. Warm, plain, no streaks or counts you can't see",
  // B3: the weigh-in IS the ask, so its words keep it (no move is appended).
  weigh: "It is Monday morning: their weekly weigh-in. By first name, in two or three short lines, ask for this morning's weight: after the toilet, before food, the same way each week. If a weight is on record, name their last one. The scale is information, never judgement",
  // B6: they have gone quiet. The ladder's ask is appended after these words.
  // B5: the programme moved up a phase; the facts of it come in `extra`, and "today" is appended as the move.
  phase: "Their training programme has just moved up a phase (see JUST HAPPENED). By first name, in two short lines, say they earned it from the real session count and name the new phase",
  silence: "They have not written for a few days or more (see the conversation dates). A short, warm hello by first name, in one or two lines: no guilt, no catching up, nothing about what they missed, no numbers",
} as const;

/** The new coach's words for a scheduled message, or null (the caller sends its plain floor). Never throws. */
export async function scheduledWords(phone: string, job: keyof typeof SCHEDULED, extra = ""): Promise<string | null> {
  const asks = job === "weigh";
  if (!coreWave4For(phone)) return null;
  try {
    const pre = await readPreTurn(phone);
    if (!pre) return null;
    const { getDayLedger } = await import("../day-ledger");
    const y = await getDayLedger(pre.userId, { forDate: new Date(Date.now() - 86_400_000) });
    pre.numbers += `\nYESTERDAY: ${y.meals.length ? `${y.meals.map(m => `${m.label || "meal"}: ${m.foods}`).join("; ")}; about ${Math.round(y.kcal)} kcal and ${Math.round(y.protein)}g protein` : "no food logged"}; steps ${y.steps ? y.steps.toLocaleString("en-ZA") : "none logged"}.`;
    if (extra) pre.numbers += `\nJUST HAPPENED: ${extra}`;
    const u: Understanding = { family: "other", wants: asks ? SCHEDULED[job] : `${SCHEDULED[job]}. Ask nothing and give no instruction: the one next move is added after your words`, one_question: null, uncertainty: 0, actions: [] };
    const words = (await compose(await openaiClient(), pre, `(No message from ${pre.name}: this is your scheduled ${job} message.)`, u))?.trim();
    if (!words || asks) return words || null;
    const { stripModelDirectives } = await import("../brain/reply-verifier");
    return stripModelDirectives(words, { modelAuthored: true } as any).kept.trim() || null;
  } catch (e) {
    console.warn(`[CORE_WAVE4] ${job} kept the old words:`, (e as Error)?.message || e);
    return null;
  }
}

/**
 * THE LAST DOOR (wave-1 deletion, 6 Oct). gpt-block answered whatever no owner above it did; it is
 * deleted, and the new coach answers instead, even a turn whose reading names a write no writer took.
 * Only when the new coach cannot answer at all (no reading, the model down) does askCoachK speak: its
 * failure path alerts the founder on a dead key or an empty balance (#395) and returns a line the
 * turn-integrity owner recognises as unanswered (#92). `readAlready`: wave1Turn read this turn (#451).
 */
export async function answerFinal(phone: string, message: string, user: any, readAlready = false, sourceMessageId?: string): Promise<string> {
  const [{ looksLikeRecallQuestion, answerRecall }, { turnEvidence, logChat }] = await Promise.all([import("../memory"), import("../handlers/chat-log")]);
  // "What did I tell you about…": the grounded recall answers from their own messages, as it did behind gpt-block.
  if (looksLikeRecallQuestion(message)) { turnEvidence({ conversationalOnly: true }); return answerRecall(user, message); }
  const reply = readAlready ? null : await answerLive(phone, message, { final: true, sourceMessageId }).catch(() => null);
  // numbers:low still does its job at the last door, whichever mouth speaks, as it did behind gpt-block.
  const { getNumbersMode, stripNumbersFromProse } = await import("../numbers-mode");
  const plain = (t: string) => getNumbersMode(user) === "low" ? stripNumbersFromProse(t) : t;
  if (reply) return plain(reply);
  // OVER THE SPEND CAP (#340): the short deterministic reply the old last door owned (gpt-block's, kept), never a model call.
  if (!(await (await import("../cost-tracking")).isUnderGPTCallLimit(user.id))) {
    turnEvidence({ conversationalOnly: true });
    const name = (await import("../utils")).getDisplayName(user) || "there";
    const move = user.goalType === "muscle_gain" ? "hit your protein and get 8 hours sleep tonight" : "hit your step target and keep your last meal clean tonight";
    return `${name}, quick answer: ${move}\n\nEverything's still live — *menu* for your programme, *my progress* for your numbers, *workout* for today's session. Anything broken? Name it and I'll fix it.`;
  }
  // The model is out and they only said thanks: a short ack, never "the coach is unavailable" (gpt-block's, kept).
  if ((await import("../handlers/chat-log")).isPureReaction(message)) { turnEvidence({ conversationalOnly: true }); return ["Sharp.", "Lekker.", "Sho.", "Yebo. 👊"][Math.floor(Math.random() * 4)]; }
  const fallback = plain(await (await import("../gpt")).askCoachK(message, user));
  // #92: a question we could not answer is told so, with no action invented on top of it.
  if ((await import("../brain/reply-verifier")).isCoachUnavailableReply(fallback)) {
    turnEvidence({ conversationalOnly: true });
    await logChat(user.id, message, fallback, "COACH_UNAVAILABLE").catch(() => {});
  }
  return fallback;
}

/** One switched turn: the scope floor first, then the new coach. null = let the old engine answer. */
export async function wave1Turn(p: { phone: string; message: string; userId: string; ongoing: boolean; sourceMessageId?: string; evidence: (f: { conversationalOnly: true }) => void }): Promise<{ reply: string; src: string } | null> {
  const { classifyDomain, declineOutOfScope } = await import("../understanding/domain-guard");
  const scope = await classifyDomain(await openaiClient(), p.message, { ongoing: p.ongoing });
  if (scope.redirectMessage) return { reply: await declineOutOfScope(p.userId, p.message, scope.redirectMessage, p.evidence), src: "scope" };
  let down: string | null = null;
  const reply = await answerLive(p.phone, p.message, { sourceMessageId: p.sourceMessageId }).catch(async e => {
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
 * messages as one block; client-record writeHistoryFacts keeps only verbatim, own-voice facts. Never throws.
 * ONCE PER CLIENT EVER (#467): users.history_learned_at is claimed in the database BEFORE the call, so a
 * deploy (which empties historyTried) never re-runs it, even for a client whose history held no facts.
 * At most HISTORY_DAILY_CAP clients (default 40) are read per 24 hours. A failed call releases the claim,
 * so a later turn tries again.
 */
const historyTried = new Set<string>();
export function _resetHistoryTried(): void { historyTried.clear(); }
export async function learnFromHistory(userId: string): Promise<number> {
  if (historyTried.has(userId)) return 0;
  historyTried.add(userId);
  const cap = Number(process.env.HISTORY_DAILY_CAP ?? 40);
  let claimed = false;
  try {
    const won = await db.execute(sql`UPDATE users SET history_learned_at = now() WHERE id = ${userId} AND history_learned_at IS NULL
      AND (SELECT count(*) FROM users WHERE history_learned_at > now() - interval '24 hours') < ${cap} RETURNING id`);
    if (!(won as any).rows?.length) return 0; // learned before, by any process, or today's cap is spent
    claimed = true;
    const rec = await import("./client-record");
    const msgs = await rec.historyToLearn(userId);
    if (!msgs.length) return 0;
    const block = `EARLIER MESSAGES FROM THIS CLIENT, oldest first, one per line. Read them together and list the durable facts they state about themselves:\n${msgs.map(m => m.text.replace(/\s+/g, " ")).join("\n")}`;
    const read = await understand(await openaiClient(), block, "KNOWN FACTS: none", 6000);
    return await rec.writeHistoryFacts(userId, read.raw, msgs);
  } catch (e) {
    // An outage is not an answer: release the claim so a later turn tries again (#472 attack).
    historyTried.delete(userId);
    if (claimed) await db.execute(sql`UPDATE users SET history_learned_at = NULL WHERE id = ${userId}`).catch(() => {});
    console.warn("[RECORD] history skipped:", (e as Error)?.message || e);
    return 0;
  }
}

/**
 * THE LIVE TURN TEACHES THE RECORD (#545 attack @ f63d700). Facts were stored only by runShadow, which
 * is off unless CORE_SHADOW=on, so a commitment the live coach accepted was never written. The
 * transport calls this after recordAtDoor has stored the message: the live understanding call's own
 * answer goes through applyFacts, the same validation and the same once-per-message rule. No model call.
 * Keyed by phone, not by the text (the normaliser may have rewritten it): a read paired with the wrong
 * message stores nothing, because applyFacts keeps only statements verbatim in that event's own text.
 */
const liveReads = new Map<string, { at: number; raw: string }>();
export async function learnFromLiveRead(phone: string, sourceMessageId?: string): Promise<number> {
  const read = liveReads.get(phone);
  liveReads.delete(phone);
  if (!read || Date.now() - read.at > 120_000 || !sourceMessageId) return 0;
  const [ev] = await db.select({ id: clientEvents.id }).from(clientEvents).innerJoin(users, eq(users.id, clientEvents.userId))
    .where(and(eq(clientEvents.sourceMessageId, sourceMessageId), eq(users.phoneNumber, phone))).limit(1);
  return ev ? (await import("./client-record")).applyFacts(ev.id, read.raw) : 0;
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
    const [last] = await db.select({ intent: chatHistory.intent, out: chatHistory.messageOut, said: chatHistory.messageIn }).from(chatHistory)
      .where(and(eq(chatHistory.userId, pre.userId), sql`${chatHistory.createdAt} > now() - interval '2 minutes'`))
      .orderBy(desc(chatHistory.createdAt)).limit(1);
    // THIS message's decline only: the live new coach writes no chat row, so the last row can be the turn before.
    const scoped = last?.intent === "DOMAIN_REDIRECT" && !!last.out && last.said === message;
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

/**
 * #592, THE INVERSION — the new coach is the front door. Behind the floors (safety, consent, onboarding,
 * billing, anything awaiting an answer) and the exact commands, every text message is read once
 * (understand: meaning, scope, facts, actions), its validated actions run through the existing tools
 * for every client, and the reply is composed from the record. Two model calls a turn. null = the
 * old doors answer: no reading, over the spend cap, or the model down. CORE_FRONT=off is the rollback
 * (expires 14 Oct; the doors it keeps reachable are deleted then, #568).
 */
export function coreFront(): boolean {
  return String(process.env.CORE_FRONT || "on").toLowerCase() !== "off";
}

const frontReads = new Map<string, { message: string; u: Understanding | null }>();
const EXACT_COMMANDS = new Set(["menu", "progress", "targets", "cancel", "stop", "start", "help", "workout", "today's workout",
  "todays workout", "meals", "diary", "status", "pause", "resume", "unsubscribe", "shopping list"]);
/** The whole message is a fixed command or a button/number reply: the old command owns it. */
export function isExactCommand(m: string): boolean {
  const t = m.trim().toLowerCase().replace(/[.!?\s]+$/, "").replace(/^my /, "");
  return EXACT_COMMANDS.has(t) || (t.length > 0 && t.length <= 2 && Number.isFinite(Number(t)));
}

export async function frontTurn(p: { phone: string; message: string; user: any; sourceMessageId?: string; ongoing: boolean;
  evidence: (f: { conversationalOnly: true }) => void }): Promise<{ reply: string; src: string; wrote: boolean; read?: boolean } | null> {
  const { phone, message, user } = p;
  const guard = await import("../understanding/domain-guard");
  const ask = await guard.deterministicScope(message, p.ongoing); // the human hand-off and the off-domain asks, in code
  if (ask) return { reply: await guard.declineOutOfScope(user.id, message, ask, p.evidence), src: "scope", wrote: false };
  try {
    const pre = await readPreTurn(phone, message);
    if (!pre) return null;
    const openai = await openaiClient();
    const read = await understand(openai, message, pre.known);
    liveReads.set(phone, { at: Date.now(), raw: read.raw });
    const unanswered = { reply: "", src: "core front", wrote: false, read: true }; // read once: no later door reads it again (#271)
    if (!read.u) return unanswered;
    if (read.u.scope === "out") return { reply: await guard.declineOutOfScope(user.id, message, guard.scopeRedirect(p.ongoing), p.evidence), src: "scope", wrote: false };
    frontReads.set(phone, { message, u: read.u });
    const done = await runActions(p, read.u, openai);
    if (done?.src === "core front: read") p.evidence({ conversationalOnly: true }); // the programme's own text, not a claim of a write
    if (done?.reply) return done;
    const reply = (await compose(openai, pre, message, read.u))?.trim();
    if (!reply) return unanswered;
    await foldedFollowUp(phone, pre, reply).catch(() => {});
    return { reply, src: "core front", wrote: false };
  } catch (e) {
    console.warn("[CORE_FRONT] the old doors answer:", (e as Error)?.message || e);
    return null;
  } finally { frontReads.delete(phone); }
}

/** The read's writes, each through the tool that already owns it. null = nothing to write (a question, a feeling). */
async function runActions(p: { phone: string; message: string; user: any; sourceMessageId?: string }, u: Understanding, openai: OpenAI):
  Promise<{ reply: string; src: string; wrote: boolean } | null> {
  const { phone, message, user } = p;
  const { writesState } = await import("../understanding/actions");
  const m = message.toLowerCase().replace(/\s+/g, " ").trim();
  // THE DESTRUCTIVE-ACTION BOUNCER, as the old engine had it (#597 attack): a delete needs the client's own
  // removal words. Vetoed, a correction still goes to the correction engine; anything else is talk.
  const { asksToRemove } = await import("../understanding/live");
  const vetoed = u.actions.some(a => a.type === "REMOVE_LAST_MEAL") && !asksToRemove(message);
  const acts = u.actions.filter(a => a.type !== "JUST_REPLY" && !(vetoed && a.type === "REMOVE_LAST_MEAL"));
  if (vetoed && !acts.length) {
    const r = await (await import("../handlers/food-log-mgmt")).handleFoodLogMgmt(user, m);
    return r ? { reply: r, src: "core front: correction", wrote: true } : null;
  }
  if (!acts.length) return null;
  const one = acts.length === 1 ? acts[0] : null;
  // Owners that take the client's words, not a value: the correction engine, the workout log, the goal confirm.
  if (one?.type === "CORRECT_MEAL") {
    const r = await (await import("../handlers/food-log-mgmt")).handleFoodLogMgmt(user, m);
    return r ? { reply: r, src: "core front: correction", wrote: true } : null;
  }
  // The workout log takes the client's words; with a meal in the same message (#609) only the session's own words.
  const workoutTool = async (w: Extract<CoachAction, { type: "LOG_WORKOUT" }>, whole: boolean) => {
    const { handleWorkoutCommands } = await import("../handlers/workout");
    const said = `I did ${w.what || "my workout"}${w.retro ? ` ${w.retro}` : ""}`;
    const r = (whole ? await handleWorkoutCommands({ phone, message, m, user, sourceMessageId: p.sourceMessageId }) : null)
      ?? await handleWorkoutCommands({ phone, message: said, m: said.toLowerCase(), user, sourceMessageId: p.sourceMessageId });
    if (!r) return null;
    // The receipt's closing question ("How did that session feel?" + buttons) is the progression flow's: it stays,
    // after the new coach's words about the session (#597 review: the reply was still the old tool's).
    const parts = r.split("\n\n"), ask = parts.length > 1 && parts[parts.length - 1].includes("?") ? parts.pop()! : "";
    return { r, receipt: parts.join("\n\n"), ask };
  };
  if (one?.type === "LOG_WORKOUT") {
    const w = await workoutTool(one, true);
    if (!w) return null;
    const words = await afterLogReply(phone, message, w.receipt, "workout");
    return { reply: words ? [words, w.ask].filter(Boolean).join("\n\n") : w.r, src: "core front: workout", wrote: true };
  }
  const session = acts.filter(a => a.type === "LOG_WORKOUT"), logs = acts.filter(a => LOGS.has(a.type));
  if (session.length === 1 && logs.length === acts.length - 1) { // "pap and wors for lunch and a 30 min home workout" (#609)
    const logged = await logThroughExecutor(phone, message, logs, 1 - (u.uncertainty || 0), p.sourceMessageId);
    const w = await workoutTool(session[0] as Extract<CoachAction, { type: "LOG_WORKOUT" }>, false);
    if (!logged.performed && !w) return logged.confirm ? { reply: logged.confirm, src: "core front: confirm", wrote: false } : null;
    const receipt = [(logged.card + logged.reply).trim(), w?.receipt].filter(Boolean).join("\n\n");
    const words = await afterLogReply(phone, message, receipt, logged.performed ? "food" : "workout", logged.user);
    return { reply: [words || receipt, logged.confirm || w?.ask].filter(Boolean).join("\n\n"), src: "core front: log + workout", wrote: true };
  }
  if (one?.type === "SET_GOAL") {
    const said = `change my goal to ${one.goal.replace("_", " ")}`;
    const r = await (await import("../handlers/lifecycle")).handleLifecycle({ phone, message: said, m: said, user, isQuestion: false });
    return r ? { reply: r, src: "core front: goal", wrote: false } : null;
  }
  if (acts.every(a => a.type === "SET_REMINDER")) {
    const r = await saveReminders(phone, message, acts as Reminder[], 1 - (u.uncertainty || 0));
    return r ? { reply: r, src: "core front: reminder", wrote: false } : null;
  }
  // Everything else is the executor's (meals, steps, weight, water, sick days, show and undo).
  if (acts.some(a => ["CORRECT_MEAL", "LOG_WORKOUT", "SET_GOAL"].includes(a.type))) return null; // mixed with a words-owner: compose, never half-write
  const confidence = 1 - (u.uncertainty || 0);
  const logged = await logThroughExecutor(phone, message, acts, confidence, p.sourceMessageId);
  if (logged.confirm) return { reply: logged.card + [logged.reply, logged.confirm].filter(Boolean).join("\n\n"), src: "core front: confirm", wrote: false };
  const receipt = (logged.card + logged.reply).trim();
  if (!logged.performed) return receipt ? { reply: receipt, src: "core front: read", wrote: false } : null;
  const kind = acts.every(a => a.type === "LOG_STEPS") ? "steps" : acts.some(a => a.type === "LOG_MEAL") ? "food" : null;
  const words = kind ? await afterLogReply(phone, message, receipt, kind, logged.user) : null;
  return { reply: words || receipt, src: "core front", wrote: acts.some(a => writesState(a.type)) };
}
