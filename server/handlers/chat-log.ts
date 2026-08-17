import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db";
import { users, chatHistory, escalations, turnLedger } from "../../shared/schema";
import { eq, and } from "drizzle-orm";
import twilio from "twilio";
import { classifyMediaFailure } from "../coach-guardrails";
import { detectEscalation, escalationSLA, isSyntheticTestClient } from "../safety-detection";
import { currentRuntimeDecision } from "../understanding/state";

// Standalone escalation check — exported so handleMessage can call it early, before any handler
// returns. Does NOT create a chatHistory row; only creates the escalations record + coach alert.
export async function checkEscalation(userId: string, messageIn: string): Promise<void> {
  if (!messageIn || messageIn.length <= 2) return;
  const esc = detectEscalation(messageIn);
  if (!esc.should) return;
  try {
    const recent = await db.select({ id: escalations.id }).from(escalations)
      .where(and(eq(escalations.userId, userId), eq(escalations.status, "open")))
      .limit(1);
    if (recent.length === 0) {
      await db.insert(escalations).values({
        userId,
        reason: esc.reason,
        triggerMessage: messageIn.slice(0, 500),
        priority: esc.priority,
        slaDeadline: escalationSLA(esc.priority),
      });
      console.log(`[ESCALATION] Auto-created: ${esc.reason} (${esc.priority}) for user ${userId}`);

      if ((esc.priority === "urgent" || esc.priority === "high") && process.env.COACH_ALERT_PHONE && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_NUMBER) {
        const [client] = await db.select({ name: users.name, phoneNumber: users.phoneNumber }).from(users).where(eq(users.id, userId)).limit(1);
        const clientName = client?.name || "Client";
        const clientPhone = client?.phoneNumber || "unknown";
        // Never alert when the coach-alert number IS the client (test setup or
        // misconfig). Otherwise the internal "HIGH ESCALATION — open the dashboard"
        // message lands in the client's own chat, leaking tooling and a phone number.
        const normPhone = (p: string) => p.replace(/^whatsapp:/, "").replace(/\D/g, "");
        if (normPhone(clientPhone) === normPhone(process.env.COACH_ALERT_PHONE)) {
          console.log("[ESCALATION] Skipping coach alert — alert phone == client phone (recorded in inbox only)");
          return;
        }
        // Nobody is hurt: this is the Reality harness, not a client. Journey 4's "I missed gym
        // because my back was sore" paged the founder's real phone on every run, and a suite that
        // cries injury weekly is how a real one gets ignored. Row still written, alert withheld.
        if (isSyntheticTestClient(clientPhone)) {
          console.log("[ESCALATION] Skipping coach alert — synthetic test client (recorded in inbox only)");
          return;
        }
        const alertClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const fromNum = process.env.TWILIO_WHATSAPP_NUMBER.startsWith("whatsapp:") ? process.env.TWILIO_WHATSAPP_NUMBER : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
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
        if (!sent) console.error(`[ESCALATION] ⚠️ All alert attempts FAILED (${esc.priority}/${esc.reason}) — escalation still recorded in inbox`);
      }
    }
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
  try {
    await logChat(userId, `[MEDIA_FAIL:${stage}]`, payload, "MEDIA_FAILURE");
  } catch (e) {
    console.warn("[media-failure-log]", e);
  }
}

export async function logMediaSuccess(userId: string, flow: string, totalMs: number): Promise<void> {
  try {
    await logChat(userId, `[MEDIA_OK:${flow}]`, `total_ms=${totalMs}`, "MEDIA_SUCCESS");
  } catch (e) {
    console.warn("[media-success-log]", e);
  }
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
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


// ════════════════════════════════════════════════════════════════════════════════════════════
// TURN LEDGER (2026-08-10 directive, §6) — observability, not architecture.
//
// It lives here because this file already owns "record what happened this turn"; a separate
// module would be a second answer to a question that already has one. See shared/schema.ts for
// why a turn gets its own row rather than columns on chat_history.
//
// AsyncLocalStorage, not a Map keyed by user: two clients are served concurrently on one process,
// and a module-level Map would let one client's mutations be recorded against another's turn.
// That is exactly the class of bug this ledger exists to catch, so it must not ship inside it.
// ════════════════════════════════════════════════════════════════════════════════════════════

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

/** Run one turn inside its own ledger scope. Returns whatever the turn returns. */
export function inTurn<T>(inputType: string, inputText: string, fn: () => Promise<T>): Promise<T> {
  return turnStore.run({
    userId: null, inputType, inputText: (inputText || "").slice(0, 2000),
    resolvedDay: null, stateRead: {}, mutations: [], startedAt: Date.now(),
  }, fn);
}

/** Attribute the current turn to a client, once it is known. */
export function turnUser(userId: string): void {
  const t = turnStore.getStore();
  if (t) t.userId = userId;
}

/**
 * Record a WRITE the turn performed. Called by the writers themselves, in order.
 *
 * It also prints, because a mutation worth putting in the ledger is worth having in the logs and
 * a writer that has to say it twice will eventually say two different things.
 */
export function turnMutation(note: string, logPrefix?: string): void {
  const t = turnStore.getStore();
  if (t && t.mutations.length < 40) t.mutations.push(note);
  if (logPrefix) console.log(`${logPrefix} ${note}`);
}

/** Record facts the turn READ before deciding, and the day it resolved to. */
export function turnState(facts: Record<string, unknown>, resolvedDay?: string | null): void {
  const t = turnStore.getStore();
  if (!t) return;
  Object.assign(t.stateRead, facts);
  if (resolvedDay) t.resolvedDay = resolvedDay;
}

/**
 * Close the turn out. Fail-open and awaited nowhere near the client's reply — a ledger that can
 * delay or break an answer is worse than no ledger.
 */
export async function recordTurn(reply: string): Promise<void> {
  const t = turnStore.getStore();
  if (!t?.userId) return;
  try {
    const decision = currentRuntimeDecision();
    const stateRead = decision
      ? {
          ...t.stateRead,
          decisionState: decision.state,
          decisionEvidence: decision.evidence,
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
