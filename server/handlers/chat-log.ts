import { db } from "../db";
import { users, chatHistory, escalations } from "../../shared/schema";
import { eq, and } from "drizzle-orm";
import twilio from "twilio";
import { classifyMediaFailure } from "../coach-guardrails";
import { detectEscalation, escalationSLA } from "../safety-detection";

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
