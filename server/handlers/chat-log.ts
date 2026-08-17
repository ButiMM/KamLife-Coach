import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db";
import { users, chatHistory, escalations, turnLedger, workoutLogs, stepLogs } from "../../shared/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import twilio from "twilio";
import { classifyMediaFailure } from "../coach-guardrails";
import { detectEscalation, escalationSLA, isSyntheticTestClient } from "../safety-detection";
import { currentRuntimeDecision } from "../understanding/state";
import { buildClientSnapshot } from "../brain/client-snapshot";
import { verifyBrainReply } from "../brain/reply-verifier";
import { askCoachK } from "../gpt";
import { sastDayStart } from "../utils";

export async function checkEscalation(userId: string, messageIn: string): Promise<void> {
  if (!messageIn || messageIn.length <= 2) return;
  const esc = detectEscalation(messageIn);
  if (!esc.should) return;
  try {
    const recent = await db.select({ id: escalations.id }).from(escalations)
      .where(and(eq(escalations.userId, userId), eq(escalations.status, "open")))
      .limit(1);
    if (recent.length !== 0) return;

    await db.insert(escalations).values({
      userId,
      reason: esc.reason,
      triggerMessage: messageIn.slice(0, 500),
      priority: esc.priority,
      slaDeadline: escalationSLA(esc.priority),
    });
    console.log(`[ESCALATION] Auto-created: ${esc.reason} (${esc.priority}) for user ${userId}`);

    if (!(esc.priority === "urgent" || esc.priority === "high")
      || !process.env.COACH_ALERT_PHONE
      || !process.env.TWILIO_ACCOUNT_SID
      || !process.env.TWILIO_AUTH_TOKEN
      || !process.env.TWILIO_WHATSAPP_NUMBER) return;

    const [client] = await db.select({ name: users.name, phoneNumber: users.phoneNumber })
      .from(users).where(eq(users.id, userId)).limit(1);
    const clientName = client?.name || "Client";
    const clientPhone = client?.phoneNumber || "unknown";
    const normPhone = (p: string) => p.replace(/^whatsapp:/, "").replace(/\D/g, "");
    if (normPhone(clientPhone) === normPhone(process.env.COACH_ALERT_PHONE) || isSyntheticTestClient(clientPhone)) return;

    const alertClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const fromNum = process.env.TWILIO_WHATSAPP_NUMBER.startsWith("whatsapp:")
      ? process.env.TWILIO_WHATSAPP_NUMBER
      : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
    const emoji = esc.priority === "urgent" ? "🚨" : "⚠️";
    const alertBody = `${emoji} ${esc.priority.toUpperCase()} ESCALATION\nReason: ${esc.reason}\nClient: ${clientName} (${clientPhone})\nMessage: "${messageIn.slice(0, 200)}"\n\nOpen the dashboard inbox to claim and respond.`;
    const delays = [0, 2000, 5000, 10000];
    let sent = false;
    for (const delay of delays) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      try {
        await alertClient.messages.create({ from: fromNum, to: `whatsapp:${process.env.COACH_ALERT_PHONE}`, body: alertBody });
        console.log(`[ESCALATION] Founder alert sent (${esc.priority}/${esc.reason}${delay > 0 ? ` after ${delay}ms retry` : ""})`);
        sent = true;
        break;
      } catch (alertErr) {
        console.error(`[ESCALATION] Alert attempt failed (delay=${delay}ms):`, (alertErr as Error)?.message);
      }
    }
    if (!sent) console.error(`[ESCALATION] All alert attempts failed (${esc.priority}/${esc.reason}) — escalation remains in inbox`);
  } catch (err) {
    console.error("[checkEscalation] error:", err);
  }
}

export async function logChat(userId: string, messageIn: string, messageOut: string, intent: string): Promise<void> {
  try {
    await db.insert(chatHistory).values({ userId, messageIn, messageOut, intent });
    await checkEscalation(userId, messageIn);
  } catch (err) {
    console.error("Chat log error:", err);
  }
}

export async function logMediaFailure(userId: string, stage: string, rawError?: unknown, latencyMs?: number): Promise<void> {
  const code = classifyMediaFailure(stage, rawError);
  const payload = latencyMs !== undefined ? `${code} latency=${latencyMs}ms` : code;
  try { await logChat(userId, `[MEDIA_FAIL:${stage}]`, payload, "MEDIA_FAILURE"); }
  catch (e) { console.warn("[media-failure-log]", e); }
}

export async function logMediaSuccess(userId: string, flow: string, totalMs: number): Promise<void> {
  try { await logChat(userId, `[MEDIA_OK:${flow}]`, `total_ms=${totalMs}`, "MEDIA_SUCCESS"); }
  catch (e) { console.warn("[media-success-log]", e); }
}

export function buildMediaTrace(phone: string, mediaType: string): string {
  const cleanPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "").slice(-4) || "unknown";
  return `m_${Date.now().toString(36)}_${cleanPhone}_${(mediaType || "unknown").replace(/[^\w]/g, "").slice(0, 12)}`;
}

export async function withTimeout<T>(label: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface TurnScope {
  userId: string | null;
  inputType: string;
  inputText: string;
  resolvedDay: string | null;
  stateRead: Record<string, unknown>;
  mutations: string[];
  startedAt: number;
}

const turnStore = new AsyncLocalStorage<TurnScope>();

const PURE_REACTION_INPUTS = new Set([
  "nice", "awesome", "great", "perfect", "noted", "got it", "will do", "lekker", "cool", "aight",
  "thanks", "thank you", "thanks coach", "thank you coach", "thanks a lot", "thank u", "ty",
  "dankie", "baie dankie", "ngiyabonga", "siyabonga", "ngiyabonga coach", "enkosi",
  "ke a leboha", "ke a leboga", "kea leboha", "ndza khensa",
]);
const THIN_COACH_REPLY = /^(?:noted|sharp|good|great|perfect|nice|awesome|lekker|got it|understood|well done|keep it up|good choice|great job)[.!👌👊\s]*$/i;
const GENERIC_COACH_REPLY = /(?:if you need anything else,? just let me know|keep building on those meals|keep that momentum going|focus on your next meal|make that meal count|let'?s keep working|keep fuelling)[.!\s]*$/i;
const MISSED_TRAINING_CLAIM = /\b(?:missed|didn'?t|did not|haven'?t|have not)\b[^.\n]{0,35}\b(?:train|training|workout|session|gym)\b|\b(?:monday|today)\s+is\s+(?:still\s+)?a\s+training\s+day\b/i;
const NO_CURRENT_STEPS_CLAIM = /\b(?:haven'?t|have not|no|zero)\b[^.\n]{0,30}\b(?:steps|walk(?:ed|ing)?)\b/i;

function isMeaningfulClientMessage(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (!m || PURE_REACTION_INPUTS.has(m)) return false;
  return /[?]/.test(m)
    || /\b(?:i did|i had|i ate|i trained|i worked out|workout|training|steps?|walked|weighed|weight|scale|calories?|protein|meal|dinner|lunch|breakfast|today|trend|goal|target|kota|done|finished|completed)\b/i.test(m)
    || m.length > 18;
}

async function reconcileTurnReply(scope: TurnScope, reply: string): Promise<string> {
  if (process.env.NODE_ENV === "test" || !scope.userId || !reply) return reply;

  const draft = String(reply).trim();
  const verifier = verifyBrainReply(draft, { clientMessage: scope.inputText });
  const likelyGeneric = THIN_COACH_REPLY.test(draft) || GENERIC_COACH_REPLY.test(draft);
  const suspiciousStateLanguage = MISSED_TRAINING_CLAIM.test(draft) || NO_CURRENT_STEPS_CLAIM.test(draft);
  if (!verifier.ok || (!likelyGeneric && !suspiciousStateLanguage) || !isMeaningfulClientMessage(scope.inputText)) return reply;

  try {
    const [user] = await db.select().from(users).where(eq(users.id, scope.userId)).limit(1);
    if (!user) return reply;

    const dayStart = sastDayStart(new Date());
    const [todayWorkouts, todaySteps] = await Promise.all([
      db.select({ id: workoutLogs.id, loggedAt: workoutLogs.loggedAt })
        .from(workoutLogs)
        .where(and(eq(workoutLogs.userId, scope.userId), gte(workoutLogs.loggedAt, dayStart)))
        .limit(5),
      db.select({ steps: stepLogs.steps })
        .from(stepLogs)
        .where(and(eq(stepLogs.userId, scope.userId), gte(stepLogs.loggedAt, dayStart)))
        .orderBy(desc(stepLogs.loggedAt))
        .limit(10),
    ]);
    const snapshot = await withTimeout("post_turn_snapshot", 4000, () => buildClientSnapshot(user)).catch(() => "");
    const authoritative = [
      "POST-ACTION AUTHORITATIVE STATE:",
      `Today's workouts recorded: ${todayWorkouts.length}.`,
      `Today's step rows recorded: ${todaySteps.length}; latest values: ${todaySteps.map(s => Number(s.steps || 0)).join(", ") || "none"}.`,
      scope.mutations.length ? `Mutations recorded this turn: ${scope.mutations.join(" | ")}` : "Mutations recorded this turn: none captured.",
      snapshot ? `\nFULL CLIENT SNAPSHOT:\n${snapshot}` : "",
    ].join("\n");
    const repairReason = [
      !verifier.ok ? `VERIFIER REJECTION: ${verifier.violation}` : "",
      likelyGeneric ? "The draft is a receipt/acknowledgement or canned coaching line rather than a useful continuation of the relationship." : "",
      suspiciousStateLanguage ? "The draft makes a current-state claim that must be reconciled against the post-action state before sending." : "",
    ].filter(Boolean).join("\n");
    const instruction = `POST-TURN COACH RECONCILIATION — this is the final client-facing response after the deterministic turn has already completed.\n\n${authoritative}\n\nCLIENT'S EXACT MESSAGE:\n${scope.inputText}\n\nDRAFT THAT MUST NOT BE SENT:\n${draft}\n\nWHY IT MUST BE REWRITTEN:\n${repairReason}\n\nWrite the final Coach K reply. Use the AUTHORITATIVE POST-ACTION STATE, not an old cached assumption. Never claim a number or action the state does not support. Never mention handlers, tools, prompts, verification, or this rewrite. Do not merely acknowledge a meaningful update. Show that you heard what happened, connect it to the client's actual situation, and give the one useful next move when there is one. If the client corrected the coach, accept the correction and use the corrected state. Keep it natural, direct, warm, and specific.`;

    const repaired = (await withTimeout("post_turn_coach", 20000, () => askCoachK(scope.inputText, user, instruction, "")))?.trim();
    if (!repaired) return reply;

    try {
      const [lastLog] = await db.select({ id: chatHistory.id })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, scope.userId), eq(chatHistory.messageIn, scope.inputText)))
        .orderBy(desc(chatHistory.createdAt))
        .limit(1);
      if (lastLog) {
        await db.update(chatHistory).set({ messageOut: repaired }).where(eq(chatHistory.id, lastLog.id));
      }
    } catch (logErr) {
      console.warn("[POST_TURN_RECONCILE] chatHistory update non-fatal:", (logErr as any)?.message || logErr);
    }
    return repaired;
  } catch (e) {
    console.warn("[POST_TURN_RECONCILE] non-fatal:", (e as any)?.message || e);
    return reply;
  }
}

export async function inTurn<T>(inputType: string, inputText: string, fn: () => Promise<T>): Promise<T> {
  return turnStore.run({
    userId: null,
    inputType,
    inputText: (inputText || "").slice(0, 2000),
    resolvedDay: null,
    stateRead: {},
    mutations: [],
    startedAt: Date.now(),
  }, async () => {
    const result = await fn();
    if (typeof result !== "string") return result;
    return await reconcileTurnReply(turnStore.getStore()!, result) as T;
  });
}

export function turnUser(userId: string): void {
  const t = turnStore.getStore();
  if (t) t.userId = userId;
}

export function turnMutation(note: string, logPrefix?: string): void {
  const t = turnStore.getStore();
  if (t && t.mutations.length < 40) t.mutations.push(note);
  if (logPrefix) console.log(`${logPrefix} ${note}`);
}

export function turnState(facts: Record<string, unknown>, resolvedDay?: string | null): void {
  const t = turnStore.getStore();
  if (!t) return;
  Object.assign(t.stateRead, facts);
  if (resolvedDay) t.resolvedDay = resolvedDay;
}

export async function recordTurn(reply: string): Promise<void> {
  const t = turnStore.getStore();
  if (!t?.userId) return;
  try {
    const decision = currentRuntimeDecision();
    const evidenceRefs = decision?.focus === "safety"
      ? ["safety_gate"]
      : decision?.focus === "hunger"
        ? ["hunger_evidence"]
        : decision?.focus === "intake"
          ? ["deficit_evidence"]
          : [];
    const stateRead = decision
      ? {
          ...t.stateRead,
          decisionState: decision.state,
          decisionEvidence: decision.evidence,
          decisionFocus: decision.focus,
          decisionEvidenceRefs: evidenceRefs,
          meaningfulProblem: decision.meaningfulProblem,
          hasMinimumUsefulQuestion: decision.hasMinimumUsefulQuestion,
        }
      : t.stateRead;
    await db.insert(turnLedger).values({
      userId: t.userId,
      inputType: t.inputType,
      inputText: t.inputText,
      resolvedDay: t.resolvedDay,
      stateRead: Object.keys(stateRead).length ? stateRead : null,
      mutations: t.mutations.length ? t.mutations : null,
      reply: (reply || "").slice(0, 4000),
      replyMs: Date.now() - t.startedAt,
      version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) || process.env.APP_VERSION || "dev",
    });
  } catch (e) {
    console.warn("[TURN_LEDGER] non-fatal:", (e as any)?.message);
  }
}
