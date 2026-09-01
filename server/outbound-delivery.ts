/**
 * outbound-delivery.ts — THE LOW-LEVEL DELIVERY OWNER (Cut B2, 2026-09-01).
 *
 * Cut B1 gave every customer-facing message one PREPARATION contract: what may be said, checked
 * once, for the reply path and the scheduler alike. It said plainly what it did not do — the
 * transport authority was still split — and this is that half.
 *
 * THREE CALL SITES CARRIED A CLIENT'S MESSAGE TO TWILIO, each with its own everything:
 *
 *     routes/whatsapp.ts   sendParts            own client, own FROM, own 4-step retry
 *     scheduler/shared.ts  sendOneWhatsApp      module client, module FROM, own 3-step retry
 *     scheduler/shared.ts  sendWhatsAppTemplate module client, module FROM, own 3-step retry
 *
 * The third one's own comment said it "mirrors sendWhatsApp's resilience". A mirror is a copy,
 * and this codebase has already paid for that sentence once: logStepsForUser carries a note
 * explaining that the routes.ts step upsert "mirrored the inline upsert exactly", drifted, and
 * told a client who had walked 9 000 steps that they had walked 3 000. Three copies of a retry
 * loop is the same bet, on the path where losing means the client hears nothing at all.
 *
 * WHAT THIS OWNS, for every caller, with no way to opt out:
 *   - one Twilio client and one FROM number, resolved in one place
 *   - refusing to call Twilio at all without a sender configured
 *   - the retry loop, and a structured failure line naming the door, the attempt and the code
 *   - saying, once, when a message was given up on
 *
 * WHAT STAYS WITH THE CALLER, because these genuinely differ and B1 settled the principle that
 * failure policy is the one thing that should:
 *   - the backoff schedule (a client is holding their phone; a 06:00 job is not)
 *   - the send-rate gate, which is proactive-only ON PURPOSE — throttling a reply would make a
 *     client wait to protect a burst window they are not part of
 *   - the circuit breaker, and SMS/template recovery, which only make sense outside a live turn
 *   - whether a terminal failure throws (a scheduler job records it) or is swallowed (a webhook
 *     has already returned 200 and there is nobody left to tell)
 *
 * NOT IN THIS CUT, AND NAMED RATHER THAN LEFT TO BE DISCOVERED: the alert, admin, dashboard,
 * payments and interactive-button senders each still build their own Twilio client. They do not
 * carry coaching replies, and payments in particular is on the "never touch without full
 * understanding" list, so they are a separate inventory rather than a silent extension of this.
 */
import twilio from "twilio";

export type DeliveryResult = "sent" | "dropped" | "fallback";

export interface DeliveryPolicy {
  /** Which door sent this. Appears in every failure line so a log names its origin. */
  label: string;
  /** Backoff before each attempt. Its LENGTH is the attempt count — [0] means one try, no retry. */
  retryDelaysMs: number[];
  /** Proactive only: the send-rate gate. Awaited before the first attempt. */
  beforeSend?: () => Promise<void>;
  /** Proactive only: drop rather than pile onto a provider that is already failing. */
  circuitOpen?: () => boolean;
  onSuccess?: () => void;
  /** Called once per terminal failure, not once per attempt. */
  onFailure?: () => void;
  /**
   * Proactive only: a WhatsApp channel error that a retry cannot fix — outside the 24-hour
   * window, not opted in, region blocked — where a template or an SMS can still land the message.
   * Returning a result ends delivery with it; returning null lets the normal retry logic decide.
   */
  onChannelError?: (err: any) => Promise<DeliveryResult | null>;
  /** Scheduler jobs record a throw. A webhook reply has nobody left to tell, so it swallows. */
  throwOnTerminal?: boolean;
}

/**
 * ONE SENDER NUMBER. Read at call time rather than at import: the scheduler captured
 * TWILIO_WHATSAPP_NUMBER into a module constant at load, so a process that set it afterwards had
 * a permanently empty sender, and every suite that sets env before driving a door had to import
 * in a particular order to be believed.
 */
export function whatsappFrom(): string {
  const raw = process.env.TWILIO_WHATSAPP_NUMBER;
  return raw ? `whatsapp:${raw.replace(/^whatsapp:/, "")}` : "";
}

let _client: any = null;
let _clientKey = "";
/** One client, rebuilt only if the credentials themselves change. */
function client(): any {
  const key = `${process.env.TWILIO_ACCOUNT_SID || ""}:${process.env.TWILIO_AUTH_TOKEN || ""}`;
  if (!_client || _clientKey !== key) {
    _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    _clientKey = key;
  }
  return _client;
}

/** Transient: worth another attempt. Anything else is the provider telling us the message is bad. */
function isTransient(e: any): boolean {
  return !e?.status || e.status === 429 || e.status >= 500 || e.code === "ECONNRESET" || e.code === "ETIMEDOUT";
}

/**
 * Hand one already-prepared message to Twilio. `params` is the Twilio payload minus `from`, which
 * this function owns; `to` is passed separately because every log line is keyed on it.
 *
 * THIS IS NOT WHERE "MAY WE SAY THIS" IS DECIDED. That question has an owner — prepareOutbound —
 * and it is asked before the reply is split into bubbles, because a claim can straddle a split
 * and because a refusal there can still become a sentence the client reads. By the time a message
 * reaches this function it has been cleared; the only thing left to get wrong is delivery.
 */
export async function deliverTwilioMessage(
  to: string,
  params: Record<string, unknown>,
  policy: DeliveryPolicy,
): Promise<DeliveryResult> {
  const from = whatsappFrom();
  if (!from) {
    console.error(`[DELIVERY] ${policy.label} — TWILIO_WHATSAPP_NUMBER not set, nothing sent to ${to.slice(-8)}`);
    policy.onFailure?.();
    return "dropped";
  }
  if (policy.beforeSend) await policy.beforeSend();
  if (policy.circuitOpen?.()) {
    console.warn(`[CIRCUIT] Twilio circuit open — dropping ${policy.label} send to ${to.slice(-8)}`);
    policy.onFailure?.();
    return "dropped";
  }

  const payload = { ...params, from, to };
  const bodyLen = typeof params.body === "string" ? (params.body as string).length : 0;
  const hasMedia = Array.isArray(params.mediaUrl) && (params.mediaUrl as unknown[]).length > 0;
  const delays = policy.retryDelaysMs.length ? policy.retryDelaysMs : [0];

  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
    try {
      await client().messages.create(payload as any);
      policy.onSuccess?.();
      return "sent";
    } catch (err: any) {
      if (policy.onChannelError) {
        const recovered = await policy.onChannelError(err);
        if (recovered) { policy.onFailure?.(); return recovered; }
      }
      // Twilio error code + body length make a silent drop diagnosable. 21617 = body over 1600
      // chars; 63016/63021 = window closed / media rejected.
      console.error(`[DELIVERY] ${policy.label} attempt ${i + 1}/${delays.length} to ${to.slice(-8)} failed — `
        + `code=${err?.code ?? "?"} status=${err?.status ?? "?"} bodyLen=${bodyLen} media=${hasMedia} `
        + `msg="${String(err?.message || "").slice(0, 160)}"`);
      const lastAttempt = i === delays.length - 1;
      if (!isTransient(err) || lastAttempt) {
        policy.onFailure?.();
        console.error(`[DELIVERY] ${policy.label} GAVE UP after ${i + 1} attempt(s) to ${to.slice(-8)} — NOT delivered`);
        if (policy.throwOnTerminal) throw err;
        return "dropped";
      }
    }
  }
  policy.onFailure?.();
  return "dropped";
}
