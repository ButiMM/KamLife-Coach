import { db } from "../db";
import { users, chatHistory, escalations } from "../../shared/schema";
import { eq, and } from "drizzle-orm";
import twilio from "twilio";
import { classifyMediaFailure } from "../coach-guardrails";
import { detectEscalation, escalationSLA } from "../safety-detection";

export async function logChat(userId: string, messageIn: string, messageOut: string, intent: string): Promise<void> {
  try {
    await db.insert(chatHistory).values({ userId, messageIn, messageOut, intent });

    if (messageIn && messageIn.length > 2) {
      const esc = detectEscalation(messageIn);
      if (esc.should) {
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
            try {
              const [client] = await db.select({ name: users.name, phoneNumber: users.phoneNumber }).from(users).where(eq(users.id, userId)).limit(1);
              const clientName = client?.name || "Client";
              const clientPhone = client?.phoneNumber || "unknown";
              const alertClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
              const fromNum = process.env.TWILIO_WHATSAPP_NUMBER.startsWith("whatsapp:") ? process.env.TWILIO_WHATSAPP_NUMBER : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
              const emoji = esc.priority === "urgent" ? "🚨" : "⚠️";
              await alertClient.messages.create({
                from: fromNum,
                to: `whatsapp:${process.env.COACH_ALERT_PHONE}`,
                body: `${emoji} ${esc.priority.toUpperCase()} ESCALATION\nReason: ${esc.reason}\nClient: ${clientName} (${clientPhone})\nMessage: "${messageIn.slice(0, 200)}"\n\nOpen the dashboard inbox to claim and respond.`,
              });
              console.log(`[ESCALATION] Founder alert sent (${esc.priority}/${esc.reason})`);
            } catch (alertErr) {
              console.error(`[ESCALATION] ⚠️ Founder alert send FAILED (${esc.priority}/${esc.reason}) — inbox still has the record:`, alertErr);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("Chat log error:", err);
  }
}

export async function logMediaFailure(userId: string, stage: string, rawError?: unknown): Promise<void> {
  const code = classifyMediaFailure(stage, rawError);
  try {
    await logChat(userId, `[MEDIA_FAIL:${stage}]`, code, "MEDIA_FAILURE");
  } catch (e) {
    console.warn("[media-failure-log]", e);
  }
}

export function buildMediaTrace(phone: string, mediaType: string): string {
  const cleanPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "").slice(-6) || "unknown";
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
