/**
 * ENGINE LIVE (blueprint Days 31-40 — the rollout).
 *
 * Routes GENUINE CONVERSATION to the Meaning Engine live, while everything on the
 * deterministic rails (safety: sick/injury/pain; transactions: logging/payment; commands:
 * workout + programme delivery) has ALREADY been handled by the handlers that run before
 * this point. So the engine only ever sees the conversation it proved (in the replay
 * scorecard) that it wins.
 *
 * Flag-gated (ENGINE_LIVE=on, off by default) and FAIL-OPEN: any miss returns null and the
 * existing brain/gpt-block path runs, so turning this on can only add the engine, never
 * remove the fallback. Instantly reversible: set ENGINE_LIVE=off.
 *
 * The engine's raw reply still passes through the SAME guards production uses: the safety
 * gate (injury/medical conflicts), sanitize, and number-free delivery for numbers:low
 * clients. The understanding it builds is persisted so the coach's memory of the client
 * keeps growing.
 */

import { eq, desc, inArray, and, gte } from "drizzle-orm";
import { db } from "../db";
import { chatHistory, users, weightLogs } from "../../shared/schema";
import { buildClientSnapshot } from "../brain/client-snapshot";
import { seedUnderstanding } from "./seed";
import { loadUnderstanding, saveUnderstanding } from "./store";
import { runMeaningEngine, writeReplyAfterTools } from "./meaning-engine";
import { planCorrection, isMealDateMove } from "../food-identity-correction";
import { isRetroactiveMeal } from "../utils";
import { tellDontAsk } from "../reply-hygiene";
import { localiseSuggestion } from "../food-swaps";
import { matchRestaurant } from "../restaurants";
import { symptomPersistence } from "../quality-signals";
import { reportsHunger, asksAboutWeightProgress } from "../unlogged-notice";
import { gatherReportData } from "../report-card";
import { computeProgressScore, progressInputsFrom } from "../progress-score";
import { assembleHungerEvidence, hasRelevantHungerEvidence, type HungerEvidence } from "../hunger-evidence";
import { assembleDeficitEvidence, hasRelevantDeficitEvidence, weightTrendUsable, type DeficitEvidence } from "../adaptive-targets";

/**
 * THE COACH'S NEXT MOVE, for the conversation (2026-08-06).
 *
 * theNextMove() has computed this since July and only the macro-card image ever said it, so in
 * chat the engine had nothing to instruct with and filled the gap with a question — seven in a
 * row on the founder's phone. This reads the same real rows the card reads and hands the answer
 * to tellDontAsk, which swaps a hand-back question for the instruction.
 *
 * Fail-open and silent: any error returns "", the reply ships unchanged, and a client never
 * loses a message because the coach could not think of a task.
 */
// Exported (2026-08-11, P2-E WI1) so the GPT fallback path can shape its reply with the SAME
// computed instruction the engine uses. One owner for "what should this member do next".
export async function computeNextMove(user: any): Promise<string> {
  try {
    const { theNextMove } = await import("../education");
    const { recomputeTodayFoodTotals } = await import("../handlers/food-scanner");
    const { sastHour, sastDayStart } = await import("../sast");
    const { db } = await import("../db");
    const { stepLogs, workoutLogs, weightLogs } = await import("../../shared/schema");
    const { eq, desc, and, gte } = await import("drizzle-orm");

    const [totals, steps, lastSession, lastWeigh] = await Promise.all([
      recomputeTodayFoodTotals(user.id).catch(() => ({ calories: 0, protein: 0 })),
      db.select({ steps: stepLogs.steps }).from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sastDayStart()))).limit(1).catch(() => []),
      db.select({ at: workoutLogs.loggedAt }).from(workoutLogs)
        .where(eq(workoutLogs.userId, user.id)).orderBy(desc(workoutLogs.loggedAt)).limit(1).catch(() => []),
      db.select({ at: weightLogs.loggedAt }).from(weightLogs)
        .where(eq(weightLogs.userId, user.id)).orderBy(desc(weightLogs.loggedAt)).limit(1).catch(() => []),
    ]);
    const daysSince = (rows: any[]): number | null => rows[0]?.at
      ? Math.floor((Date.now() - new Date(rows[0].at).getTime()) / 86_400_000) : null;
    const { getTodayWorkoutState } = await import("../workout-state");
    const wState = await getTodayWorkoutState(user).catch(() => ({ type: "REST" as const }));

    return theNextMove({
      hourSAST: sastHour(),
      proteinLeft: (user.proteinTarget || 120) - (totals.protein || 0),
      calLeft: (user.calorieTarget || 1800) - (totals.calories || 0),
      stepsToday: steps[0]?.steps ?? 0,
      stepsTarget: user.stepsTarget || 8500,
      daysSinceSession: daysSince(lastSession),
      daysSinceWeighIn: daysSince(lastWeigh),
      isTrainingDayToday: wState.type !== "REST",
      building: (user.goalType || "") === "muscle_gain",
    });
  } catch { return ""; }
}
import { classifyDomain } from "./domain-guard";
import { captureFriction } from "../friction";
import { getNumbersMode, stripNumbersFromProse } from "../numbers-mode";
import { sanitizeCoachReply } from "../handlers/food-scanner";
import { safetyGate } from "../verifiers/response-gate";
import { logChat } from "../handlers/chat-log";
import { executeAction, setPendingConfirm, takePendingConfirm, takeLastToolFacts } from "./executor";
import { describeAction, isStrategyOrEmotional, type CoachAction } from "./actions";
import { classifyConfirmReply } from "./confirm-reply";
export { classifyConfirmReply } from "./confirm-reply";

export function engineLive(): boolean {
  return process.env.ENGINE_LIVE === "on";
}

// THE INVERSION rollout dial (increment 4) — SEPARATE from ENGINE_LIVE so the action
// emitter can be exercised without touching the conversational engine's rollout.
//   off    — default. Coach K never emits actions; behaviour is byte-identical.
//   shadow — emit + DRY-RUN execute + log the decision, but the client still gets the
//            normal path. This is how we gather replay evidence in production, safely.
//   on     — emit + REALLY execute; the deterministic executor's reply wins.
export type ActionMode = "off" | "shadow" | "on";
export function engineActionMode(): ActionMode {
  const v = (process.env.ENGINE_ACTIONS || "off").toLowerCase();
  return v === "on" ? "on" : v === "shadow" ? "shadow" : "off";
}

// COHORT GATE for the `on` rollout. Even with ENGINE_ACTIONS=on, real execution is limited
// to the coach + beta testers (people who opted into testing) UNLESS ENGINE_ACTIONS_ALL=on
// widens it to everyone. So "flip it on now" is safe: a wrong action on unseen live phrasing
// can only ever touch a tester, never a real client, until you deliberately open the gate.
// A non-cohort client in `on` mode runs the action DRY (byte-identical to today) — we still
// log the would-be decision so `shadow` review shows the whole base, not just testers.
export function engineActionsAll(): boolean {
  return (process.env.ENGINE_ACTIONS_ALL || "").toLowerCase() === "on";
}

// Idempotency source id. The inbound WhatsApp MessageSid is now threaded from the webhook
// (ctx.sourceMessageId) and is the stable key we prefer — the SAME identifier Twilio uses,
// and the one our webhook-level dedup already trusts. This derived hash is only the
// fallback for entrypoints without a SID (admin test-webhook, internal recursion): a
// literal retry of the same text within the dedup window still collapses correctly.
function deriveSourceId(userId: string, message: string): string {
  let h = 0;
  const s = `${userId}:${message}`;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return `d${(h >>> 0).toString(36)}`;
}

// RESUME a parked confirmation. Called EARLY in the pipeline (before any handler can swallow a
// bare "yes") whenever awaitingInputType === "engine_confirm". Returns the executed reply, a
// cancel line, or null — null meaning "not a yes/no, let the pipeline understand it fresh".
// This is the landing pad the confirm question never had (2026-07-23 live: "yes" looped forever).
export async function resumeEngineConfirm(ctx: {
  phone: string; message: string; m: string; user: any; sourceMessageId?: string; actionsLive?: boolean;
}): Promise<string | null> {
  const { user } = ctx;
  if (user?.awaitingInputType !== "engine_confirm") return null;
  const verdict = classifyConfirmReply(ctx.message);
  const pending: CoachAction | null = takePendingConfirm(user.id); // consume the parked offer
  // The confirm turn is over either way — clear the flag so we can never get stuck awaiting.
  await db.update(users).set({ awaitingInputType: null }).where(eq(users.id, user.id)).catch(() => {});
  user.awaitingInputType = null;

  if (verdict === "other") return null; // a fresh correction → the pipeline understands it
  const name = (user?.name || "").split(" ")[0];
  const hi = name ? `${name}, ` : "";
  if (verdict === "no") return `${hi}left it as it was — nothing logged. 👍`;
  if (!pending) return null; // "yes" but the offer expired (restart) → let the pipeline reparse

  const cohortLive = ctx.actionsLive === true || engineActionsAll();
  const exec = await executeAction(pending, {
    user, phone: ctx.phone,
    preConfirmed: true, // they said yes to a number we already validated when we offered it
    sourceMessageId: ctx.sourceMessageId || deriveSourceId(user.id, ctx.message),
    confidence: 0.99, // the client explicitly confirmed
    dryRun: !cohortLive,
  });
  await logChat(user.id, ctx.message,
    `CONFIRM ${describeAction(pending)} → ${exec.performed ? "performed" : exec.error ? "error" : "noop"}`,
    "ENGINE_CONFIRM").catch(() => {});
  return exec.reply?.trim() ? exec.reply : `${hi}done. ✅`;
}

// SHADOW REVIEW — the confirmation lap in WhatsApp. In shadow mode every emitted action is
// logged (dry-run, nothing written) as ENGINE_ACTION_SHADOW: messageIn = the real message,
// messageOut = "<action> → <status>". This pulls the recent ones so the coach can scan for a
// wrong decision before flipping ENGINE_ACTIONS=on — no Railway logs needed.
export async function recentShadowDecisions(limit = 15): Promise<string> {
  try {
    // BOTH LABELS (2026-07-30): a REAL execution logs as ENGINE_ACTION, and ENGINE_ACTIONS has
    // been `on`. Reading only the SHADOW label reported "nothing logged" while every genuine
    // engine write sat in the table under the other name.
    const rows = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut, intent: chatHistory.intent })
      .from(chatHistory)
      .where(inArray(chatHistory.intent, ["ENGINE_ACTION", "ENGINE_ACTION_SHADOW"]))
      .orderBy(desc(chatHistory.createdAt))
      .limit(Math.max(5, Math.min(40, limit)));
    if (!rows.length) {
      return "🕶️ *Shadow* — no action-decisions logged yet.\n\nSet *ENGINE_ACTIONS=shadow* in Railway; once real messages come in, Coach K's would-be actions show here (dry-run — nothing is written).";
    }
    const liveCount = rows.filter(r => r.intent === "ENGINE_ACTION").length;
    const lines = rows.map(r => {
      const msg = (r.messageIn || "").replace(/\s+/g, " ").slice(0, 42);
      const decision = (r.messageOut || "").replace(/\s*→\s*\w+(\(dup\))?\s*$/i, "").trim() || "(reply)";
      return `${r.intent === "ENGINE_ACTION" ? "🔴" : "🕶️"} "${msg}" → *${decision}*`;
    });
    const head = liveCount > 0
      ? `🔴 *Engine actions — last ${rows.length}* · ${liveCount} REALLY EXECUTED, ${rows.length - liveCount} dry-run`
      : `🕶️ *Shadow — last ${rows.length} action-decisions* (dry-run, nothing written)`;
    return `${head}\n\n${lines.join("\n")}\n\n${liveCount > 0 ? "_🔴 = a real write to this client's data. Scan for a wrong one._" : "_Dry-run. Scan for a wrong write, then flip ENGINE_ACTIONS=on._"}`;
  } catch (e) {
    return `Shadow read hit a snag: ${(e as any)?.message || e}`;
  }
}

// Last few real turns of THIS conversation, so the engine has short-term memory and
// stops answering each message in a vacuum ("it doesn't listen / forgets what I said").
// Best-effort: an empty list never blocks a reply. Skips internal markers.
async function recentTurns(userId: string): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  try {
    const rows = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut })
      .from(chatHistory).where(eq(chatHistory.userId, userId))
      .orderBy(desc(chatHistory.createdAt)).limit(5);
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const r of rows.reverse()) {
      const inMsg = (r.messageIn || "").trim();
      const outMsg = (r.messageOut || "").trim();
      if (inMsg && !inMsg.startsWith("[")) turns.push({ role: "user", content: inMsg.slice(0, 400) });
      if (outMsg && !outMsg.startsWith("[")) turns.push({ role: "assistant", content: outMsg.slice(0, 500) });
    }
    return turns.slice(-8);
  } catch { return []; }
}

export async function runMeaningEngineLive(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
  openai: any;
  /** The inbound WhatsApp MessageSid, when the caller has it (webhook path). Used as the
   *  idempotency key so a Twilio retry can never double-write. Absent for admin/test and
   *  internal recursion, where we fall back to a user+message hash. */
  sourceMessageId?: string;
  /** May this user's actions REALLY execute in `on` mode? True for coach + beta testers.
   *  Non-cohort users run dry (until ENGINE_ACTIONS_ALL=on), so `on` is safe to flip today. */
  actionsLive?: boolean;
}): Promise<string | null> {
  const { message, m, user, openai } = ctx;
  try {
    const snapshot = await buildClientSnapshot(user).catch(() => undefined);
    const prior = user?.id
      ? await loadUnderstanding(user.id, seedUnderstanding(user, snapshot))
      : seedUnderstanding(user, snapshot);

    // DOMAIN BOUNDARY GATE (Law 11) — keep Coach K a coaching platform, not a general
    // assistant. Out-of-domain gets a warm redirect (never runs the engine); a partial
    // (life stuff a coach can bridge) passes a note so the engine steers back to the journey.
    const domain = await classifyDomain(openai, message);
    if (domain.classification === "out-of-domain" && domain.redirectMessage) {
      await logChat(user.id, message, domain.redirectMessage, "DOMAIN_REDIRECT").catch(() => {});
      captureFriction("redirect", { userId: user.id, messageIn: message, detail: "cold domain redirect" });
      return domain.redirectMessage;
    }
    const bridgeNote = domain.classification === "partially-related"
      ? { role: "assistant" as const, content: "[COACH NOTE: this is a life topic — acknowledge it warmly, then gently connect it back to their health journey. Do not refuse it.]" }
      : null;

    const history = user?.id ? await recentTurns(user.id) : [];
    const actionMode = engineActionMode();
    // CODE-LEVEL INTENT BOUNCER (review Q1): a strategy/emotional turn gets NO action tools —
    // the model can only converse, so it can never over-fire a workout dump or a log.
    // HUNGER EVIDENCE — assembled HERE, where the DB reads already live, and handed to the engine
    // ready to serialise (2026-08-12). Gated on the hunger STATE, not today's wording: a client who
    // reported hunger for five days and today asks why the scale has not moved is still in that
    // state and the coach needs the numbers. With no signal, nothing is assembled and nothing is
    // injected — the symptom read is one indexed COUNT, and the heavier weekly aggregate is only
    // paid for when the gate opens. Fail-open throughout: no evidence is an honest prompt, an
    // exception is not.
    let hungerEvidence: HungerEvidence | undefined;
    if (user?.id) {
      try {
        const hunger = await symptomPersistence(user.id, "hunger", 7);
        if (hasRelevantHungerEvidence(hunger, reportsHunger(message))) {
          const d = await gatherReportData(user, "week");
          const inputs = progressInputsFrom(d, {
            proteinTarget: Number(user.proteinTarget) || 0,
            stepsTarget: Number(user.stepsTarget) || 0,
            plannedSessions: Number(user.trainingDaysPerWeek) || 0,
            goalType: String(user.goalType || "fat_loss"),
          });
          hungerEvidence = assembleHungerEvidence(computeProgressScore(inputs), hunger, {
            ...inputs, avgDailyKcal: d.avgKcal, calorieTarget: Number(user.calorieTarget) || null,
          });
          console.log(`[HUNGER_EVIDENCE] ${hungerEvidence.evidenceState} — ${hunger.distinctDays}d hunger, ${inputs.foodLogDays}d logged, confidence ${hungerEvidence.confidence}`);
        }
      } catch (e) {
        console.warn("[HUNGER_EVIDENCE] assembly failed — prompt proceeds without it:", (e as Error)?.message);
      }
    }

    // DEFICIT EVIDENCE — "why isn't the scale moving?" answered from what they actually ate, not
    // from a guess (2026-08-13). Gated on the question being asked, because it costs a weekly
    // aggregate plus a weigh-in read. The trend goes in ONLY if `weightTrendUsable` says so — the
    // same gate the nightly job uses — so a reply can never assert a trend the engine refused to
    // compute. Fail-open: no evidence is an honest prompt, an exception is not.
    let deficitEvidence: DeficitEvidence | undefined;
    if (user?.id && asksAboutWeightProgress(message)) {
      try {
        const d = await gatherReportData(user, "week");
        const rows = await db.select({ w: weightLogs.weight, at: weightLogs.loggedAt })
          .from(weightLogs)
          .where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, new Date(Date.now() - 28 * 86_400_000))))
          .orderBy(desc(weightLogs.loggedAt)).limit(12);
        let observedKgPerWeek: number | null = null;
        if (rows.length >= 2) {
          const newestAt = new Date(rows[0].at as Date).getTime();
          const oldestAt = new Date(rows[rows.length - 1].at as Date).getTime();
          const notes = String(user.profileNotes || "");
          const sickSince = notes.match(/sick_since:(\d{4}-\d{2}-\d{2})/)?.[1];
          const sickUntil = notes.match(/sick_until:(\d{4}-\d{2}-\d{2})/)?.[1];
          const verdict = weightTrendUsable({
            count: rows.length, newestAt, oldestAt, now: Date.now(),
            sickSince: sickSince ? new Date(sickSince).getTime() : undefined,
            sickUntil: sickUntil ? new Date(sickUntil).getTime() : undefined,
          });
          if (verdict.usable) {
            const span = Math.max(1, (newestAt - oldestAt) / 86_400_000);
            const newest = parseFloat(String(rows[0].w));
            const oldest = parseFloat(String(rows[rows.length - 1].w));
            if (Number.isFinite(newest) && Number.isFinite(oldest)) {
              observedKgPerWeek = Math.round(((newest - oldest) / span) * 7 * 100) / 100;
            }
          }
        }
        const ev = assembleDeficitEvidence({
          calorieTarget: Number(user.calorieTarget) || 0,
          avgKcal7d: d.avgKcal || null,
          loggedDays7d: d.distinctDaysLogged,
          goalType: String(user.goalType || "fat_loss"),
          provenance: d.provenance,
          observedKgPerWeek,
        });
        if (hasRelevantDeficitEvidence(ev)) {
          deficitEvidence = ev;
          console.log(`[DEFICIT_EVIDENCE] confidence ${ev.confidence} — intake ${ev.avgKcal7d ?? "?"}/${ev.calorieTarget} kcal over ${ev.loggedDays7d}d, expected ${ev.expectedKgPerWeek ?? "?"} vs observed ${ev.observedKgPerWeek ?? "?"} kg/wk, food-data ${ev.foodDataConfidence}`);
        }
      } catch (e) {
        console.warn("[DEFICIT_EVIDENCE] assembly failed — prompt proceeds without it:", (e as Error)?.message);
      }
    }

    const strategyTurn = isStrategyOrEmotional(message);
    if (strategyTurn) console.log(`[ENGINE] strategy/emotional turn — action tools withheld`);
    const result = await runMeaningEngine({ openai, user, message, prior, snapshot, hungerEvidence, deficitEvidence, history: bridgeNote ? [...history, bridgeNote] : history, emitActions: actionMode !== "off" && !strategyTurn });
    if (!result) return null; // fail-open → existing pipeline runs

    // Grow the client's durable memory (fail-open — a save miss never blocks the reply).
    if (user?.id) saveUnderstanding(user.id, result.state).catch(() => {});

    // THE INVERSION — Coach K decided on an action. Validate happened in the engine;
    // here we execute it (dry-run in shadow) and, in `on` mode, let the deterministic
    // executor's reply win. Fail-open: any miss falls back to the conversational reply.
    // DESTRUCTIVE-ACTION BOUNCER (2026-07-22, live disaster: "No fix it. Recalculate everything"
    // → the model emitted REMOVE_LAST_MEAL and silently DELETED a meal, dropping the day from
    // 2526 → 1971 kcal). A delete may ONLY run when the client's ACTUAL words ask to remove
    // something — never the model's reading of "fix it" / "recalculate" / "that's wrong". If the
    // words aren't there, veto the write and let the conversational reply stand.
    const EXPLICIT_REMOVE_RE = /\b(remove|delete|undo|scrap|erase|unlog|take (?:it|that|them|this) out|take out|get rid of|take (?:it|that) off|don'?t log|cancel (?:that|it|the last))\b/i;
    //
    // SLICE 2 WIDENED THIS, AND IT HAD TO BE. The check was `result.action?.type` — the FIRST
    // action only. The moment the engine could emit several, a REMOVE_LAST_MEAL sitting in
    // position two walked straight past the veto that exists because of a live disaster. The
    // test is now applied to every action in the message, not the head of the list.
    const destructiveVetoed = result.actions.some(a => a.type === "REMOVE_LAST_MEAL") && !EXPLICIT_REMOVE_RE.test(message);
    if (destructiveVetoed) {
      console.warn("[ENGINE_ACTION] VETOED REMOVE_LAST_MEAL — no explicit removal words:", message.slice(0, 60));
      // A CORRECTION IS NOT A REMOVAL REQUEST (2026-08-10, Work Order 3). The live Reality Test
      // showed Journey 5 dying right here: the model read "Actually no, that was yesterday. And it
      // wasn't rice, it was pap." as REMOVE_LAST_MEAL, the bouncer correctly refused the delete —
      // and then OWNED the turn with "nothing removed, tell me which meal is wrong". The client
      // had already said which meal and what was wrong. The veto was right; keeping the turn was
      // not, because the deterministic correction engine never got it.
      //
      // So the veto now hands the turn to the path that owns corrections instead of answering for
      // it. Existing predicate (planCorrection), existing handler, existing semantics: nothing in
      // planCorrection or applyCorrection changes, no new pattern, no new route. If it does not
      // claim the turn, the veto reply below stands exactly as it did.
      // WO5: WHY THE WO3 HAND-OFF COULD NEVER FIRE (2026-08-10, proven by WO4 in production).
      //
      // Live: HANDOFF_GATE=true, HANDOFF_RESULT=false, VETO_RETURNED=true. The gate was right and
      // the hand-off still failed, for a reason the code makes structural rather than incidental:
      //
      //   · handleFoodLogMgmt is a pure function of (user, m) — nothing else reaches it.
      //   · routes.ts already called it with the SAME user and the SAME m earlier in this turn.
      //     Its returning null is the only reason the engine is running at all.
      //   · So WO3 re-asked a question that had already been answered "no" seconds before, and
      //     could never get a different answer.
      //
      // And it asked it about the wrong text: the plan is derived from `message` (the client's
      // raw words, which is what makes it a valid correction) while the handler was handed `m`,
      // which upstream may have rewritten. A plan built from one text executed against another is
      // not a hand-off, it is a coincidence waiting to fail — and in production it failed.
      //
      // The repair is the argument, not the machinery: hand the correction path the SAME text the
      // plan came from. planCorrection, applyCorrection, the veto condition and EXPLICIT_REMOVE_RE
      // are untouched; this only changes which string the existing handler is given.
      const cPlan = planCorrection(message, isMealDateMove(message, isRetroactiveMeal(message)));
      if (cPlan.isCorrection && (cPlan.moves || cPlan.remove.length + cPlan.add.length >= 2)) {
        // Normalised exactly as handleMessage normalises an inbound message, so the handler sees
        // the same shape it would have seen had nothing rewritten the turn.
        const rawForHandler = String(message).toLowerCase().trim().replace(/[‘’“”]/g, "'").replace(/\s+/g, " ");
        const { handleFoodLogMgmt } = await import("../handlers/food-log-mgmt");
        const corrected = await handleFoodLogMgmt(user, rawForHandler).catch(() => null);
        console.log(`[ENGINE_ACTION] correction hand-off: rawDiffersFromM=${rawForHandler !== String(m || "").trim()} claimed=${corrected !== null}`);
        if (corrected !== null) {
          await logChat(user.id, message, corrected, "FOOD_CORRECTION").catch(() => {});
          return corrected;
        }
      }
      // Never relay the model's (likely "Removed…") reply — that would be a lie. "Fix it /
      // recalculate" means: show the honest total from everything logged, delete nothing.
      const { recomputeTodayFoodTotals } = await import("../handlers/food-scanner");
      const t = await recomputeTodayFoodTotals(user.id).catch(() => null);
      const nm = (user?.name || "").split(" ")[0];
      const hi = nm ? `${nm}, ` : "";
      const reply = t
        ? `${hi}nothing removed — I've recounted everything you logged today: *${Math.round(t.calories)} kcal | ${Math.round(t.protein)}g protein*. If one meal is wrong, tell me which and the right amount and I'll fix just that one.`
        : `${hi}nothing removed. Tell me which meal is wrong and the right amount, and I'll fix just that one.`;
      await logChat(user.id, message, reply, "REMOVE_VETO").catch(() => {});
      return reply;
    }

    if (actionMode !== "off" && result.actions.length > 0) {
      try {
        // Cohort gate: execute for real only in `on` mode AND when this user is allowed
        // (coach/beta-tester, or ENGINE_ACTIONS_ALL). Everyone else runs DRY — so flipping
        // ENGINE_ACTIONS=on can only touch a tester until the gate is deliberately opened.
        const cohortLive = ctx.actionsLive === true || engineActionsAll();
        const runDry = actionMode === "shadow" || !cohortLive;
        // EVERY transaction the client reported, in the order they said them (Slice 2).
        // Each write is independent: one failing must never swallow the others, because the
        // client said all of them and a half-logged day is worse than a visibly failed one.
        const toolResults: Array<Record<string, unknown>> = [];
        let anyPerformed = false;
        let firstConfirm: { action: CoachAction; reply: string } | null = null;
        let execReply = "";
        for (const action of result.actions) {
          const exec = await executeAction(action, {
            user, phone: ctx.phone,
            // Each action needs its OWN idempotency key, or the second write in a batch is
            // deduped as a retry of the first and the client silently loses a meal.
            sourceMessageId: `${ctx.sourceMessageId || deriveSourceId(user.id, message)}#${describeAction(action)}`,
            confidence: 0.9, // placeholder until replay calibrates the distribution
            clientMessage: message,
            engineReply: result.reply, // Guard #8: the engine authors; the tool only acts
            dryRun: runDry,
          });
          await logChat(user.id, message,
            `${describeAction(action)} → ${exec.performed ? "performed" : exec.confirmed ? "confirm" : exec.skipped ? "skip(dup)" : exec.error ? "error" : "noop"}`,
            runDry ? "ENGINE_ACTION_SHADOW" : "ENGINE_ACTION").catch(() => {});
          if (exec.performed) anyPerformed = true;
          if (exec.confirmed && !firstConfirm) firstConfirm = { action, reply: exec.reply };
          // The never-silent fallback: a tool's own words are only ever used when the engine
          // wrote nothing. Keep the FIRST one — concatenating them is how a batch turned into
          // three receipts in the first place.
          if (!execReply && (exec.performed || exec.confirmed) && exec.reply.trim()) execReply = exec.reply;
          toolResults.push(takeLastToolFacts());
        }
        // Confirmation asked ("reply yes to log it") — PARK the action so the client's next
        // "yes" has somewhere to land. resumeEngineConfirm (called early in the pipeline)
        // picks it up. Without this the "yes" looped forever (2026-07-23 live disaster).
        if (!runDry && firstConfirm) {
          setPendingConfirm(user.id, firstConfirm.action);
          await db.update(users).set({ awaitingInputType: "engine_confirm" }).where(eq(users.id, user.id)).catch(() => {});
        }
        // ONE REPLY (Slice 2). The engine's own sentence answers everything the client said;
        // it wins whenever it exists, and the tools stay silent underneath it.
        if (!runDry && (anyPerformed || firstConfirm)) {
          if (result.reply.trim()) return result.reply;
          // THE SECOND ROUND-TRIP (2026-08-05). The model returned tool calls, which means it
          // returned NO prose — that is how function calling works, and it is why every log
          // came back as a template while photos came back warm. Now it gets its turn: the
          // tools have run, their facts go back, and it writes the sentence knowing what
          // actually happened ("5,000 — a thousand to go") instead of guessing beforehand.
          //
          // Fail-open by construction: writeReplyAfterTools returns "" on any error, and the
          // never-silent line below speaks. A client can hear a plain sentence; not an exception.
          const afterTools = await writeReplyAfterTools({
            openai, user, message,
            priorMessages: result.priorMessages || [],
            toolCalls: result.toolCalls || [],
            results: toolResults,
          }).catch(() => "");
          if (afterTools.trim()) {
            const gate2 = await safetyGate(afterTools, user, message);
            let shaped = sanitizeCoachReply(gate2.response, message, user.weeklyFoodBudget, user.injuries);
            shaped = tellDontAsk(localiseSuggestion(shaped, { menu: !!matchRestaurant(message) || !!matchRestaurant(shaped) }), await computeNextMove(user));
            if (shaped.trim()) {
              await logChat(user.id, message, shaped, "ENGINE_AFTER_TOOLS").catch(() => {});
              return shaped;
            }
          }
          if (execReply.trim()) return execReply;
        }
      } catch (e) {
        console.warn("[ENGINE_ACTION] execute failed (deferring):", (e as any)?.message || e);
      }
    }

    if (!result.reply.trim()) return null; // no conversational reply → existing pipeline runs

    // Same guards production already trusts: safety gate → sanitize → number-free.
    const gate = await safetyGate(result.reply, user, message);
    let reply = sanitizeCoachReply(gate.response, message, user.weeklyFoodBudget, user.injuries);
    // TELL, DON'T ASK — a hand-back question becomes the computed instruction (2026-08-06).
    // The REPLY is checked as well as the message: on a follow-up ("what if I skip the chips?")
    // the client no longer names the place, but the coach still does ("Enjoy your time at Spur"),
    // so the reply is what carries the menu context through the rest of the conversation.
    reply = tellDontAsk(localiseSuggestion(reply, { menu: !!matchRestaurant(message) || !!matchRestaurant(reply) }), await computeNextMove(user));
    if (getNumbersMode(user) === "low") reply = stripNumbersFromProse(reply);
    if (!reply.trim()) return null;

    await logChat(user.id, message, reply, "ENGINE_LIVE").catch(() => {});
    return reply;
  } catch (e) {
    console.warn("[ENGINE_LIVE] failed (deferring to pipeline):", (e as any)?.message || e);
    return null; // fail-open
  }
}
