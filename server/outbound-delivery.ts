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

/**
 * "substituted" (Cut 6, 2026-09-14) — the transport delivered SOMETHING, and it was not this
 * message. It exists for exactly one path: a proactive send rejected for being outside the
 * 24-hour window, recovered by the generic re-engagement template. That template says "Coach K
 * checking in"; it does not carry the morning plan, the weekly review or the payment alert that
 * was actually being sent. Reporting that as "fallback" told every caller the client had received
 * their message, so the morning job recorded a training move the client was never shown and the
 * weekly job recorded a review nobody read.
 */
export type DeliveryResult = "sent" | "dropped" | "fallback" | "substituted";

/**
 * A transport handoff exists only when THE INTENDED TEXT reached Twilio or its owned fallback.
 *
 * "substituted" is deliberately false here. SMS fallback carries the real words, and an approved
 * template that matches the message carries them too — both are the message arriving in another
 * shape. A generic check-in is a different message, and a caller asking "did they get this?" must
 * be told no.
 */
export function deliveryAccepted(result: DeliveryResult): boolean {
  return result === "sent" || result === "fallback";
}

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

/**
 * Where Twilio POSTs what happened to a message after it accepted it — the existing
 * /webhook/status route, derived from APP_URL rather than configured a second time.
 *
 * HTTPS ONLY, AND ABSENT RATHER THAN GUESSED. Twilio refuses a non-https callback, and a bad
 * value makes every send fail rather than merely going unreported — so an APP_URL that is unset,
 * local, or not https yields no callback at all and delivery behaves exactly as it does today.
 * The receipt is worth having; it is not worth risking the message for.
 */
export function statusCallbackUrl(): string {
  const base = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
  if (!base || !base.startsWith("https://")) return "";
  return `${base}/webhook/status`;
}

let _client: any = null;
let _clientKey = "";
let _clientOverride: any = null;

/**
 * TEST SEAM — the same shape as the `_reset*` helpers this codebase already exports from
 * production modules (_resetOutboundDedupe, _resetInteractionCorrelation, _resetReplyPaths).
 *
 * The 24-hour window recovery can only be graded by making Twilio REJECT a send with 63016, and
 * that is a fact about a live WhatsApp sender and a real client's last inbound message — not
 * something any fixture can arrange. Simulating the provider's answer is the only way to ask
 * "which template did we then send, and what did we tell the caller?" without a live number.
 *
 * Pass null to restore the real client. Nothing in the product calls this.
 */
export function _setTwilioClientForTests(c: any | null): void {
  _clientOverride = c;
  _client = null;
  _clientKey = "";
}

/** One client, rebuilt only if the credentials themselves change. */
function client(): any {
  if (_clientOverride) return _clientOverride;
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

  // DELIVERY RECEIPTS, ON BOTH DOORS (Cut 6, 2026-09-14). server/routes/payments.ts has carried a
  // signature-validated /webhook/status handler for months — it logs [DELIVERY FAIL] and writes a
  // DELIVERY_FAILED row so a send that Twilio ACCEPTED but never delivered leaves evidence. No
  // outbound call ever asked Twilio to POST there, so the handler could not fire and the row never
  // existed: "accepted by Twilio" was the last thing we knew about any message.
  //
  // Set HERE and only here, because this is the one function both the freeform and the template
  // door go through — the same reason the retry loop and the sender number live here.
  const payload: Record<string, unknown> = { ...params, from, to };
  const callback = statusCallbackUrl();
  if (callback) payload.statusCallback = callback;
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
