/**
 * Twilio interactive message helpers for WhatsApp buttons and lists.
 *
 * WhatsApp via Twilio Content API supports:
 *   - Quick Reply buttons (up to 3, session-initiated — no Meta approval needed)
 *   - Call-to-Action buttons (URL / phone)
 *
 * Usage: sendWhatsAppButtons(to, body, ["Option A", "Option B", "Option C"])
 * Users tap a button and their reply comes in as the button title text — existing
 * text parsing handles it transparently (no changes to intent logic required).
 *
 * Falls back to inline text options if Content API fails.
 */

import twilio from "twilio";

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const FROM_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER
  ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}`
  : "";

// Re-use the same Twilio client (does not create a new TCP connection)
const twilioClient = twilio(ACCOUNT_SID, AUTH_TOKEN);

// Cache ContentSids by button set — survives the process lifetime, avoids
// recreating the same template on every message.
const _templateCache = new Map<string, string>();
// Track button sets that permanently failed so we don't retry them endlessly
const _templateFailed = new Set<string>();

function _cacheKey(buttons: string[]): string {
  return buttons.slice(0, 3).join("|||");
}

async function _getOrCreateTemplate(buttons: string[]): Promise<string | null> {
  const key = _cacheKey(buttons);
  if (_templateCache.has(key)) return _templateCache.get(key)!;
  if (_templateFailed.has(key)) return null;

  try {
    const limited = buttons.slice(0, 3);
    const created = await (twilioClient as any).content.v1.contents.create({
      friendlyName: `kamlife_${key.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}_${Date.now()}`,
      language: "en",
      variables: { "1": "placeholder" },
      types: {
        "twilio/quick-reply": {
          body: "{{1}}",
          actions: limited.map((title, i) => ({ title, id: `opt_${i}` })),
        },
      },
    });
    const sid: string = created.sid;
    _templateCache.set(key, sid);
    console.log(`[BUTTONS] Template created ${sid}: ${limited.join(" | ")}`);
    return sid;
  } catch (err: unknown) {
    const msg = (err as Error)?.message || String(err);
    console.warn("[BUTTONS] Content API template creation failed:", msg);
    // Only mark as permanently failed for auth/permission errors, not transient ones
    if (/authentication|permission|not.*found|invalid|forbidden/i.test(msg)) {
      _templateFailed.add(key);
    }
    return null;
  }
}

/**
 * Send a WhatsApp message with up to 3 quick-reply buttons.
 * Always attempts the Twilio Content API first; falls back to inline text if it fails.
 */
export async function sendWhatsAppButtons(
  to: string,
  body: string,
  buttons: string[]
): Promise<void> {
  if (!FROM_NUMBER) return;

  if (buttons.length > 0) {
    const contentSid = await _getOrCreateTemplate(buttons.slice(0, 3));
    if (contentSid) {
      try {
        await (twilioClient as any).messages.create({
          from: FROM_NUMBER,
          to,
          contentSid,
          contentVariables: JSON.stringify({ "1": body }),
        });
        return;
      } catch (err: unknown) {
        console.warn("[BUTTONS] ContentSid send failed, using text fallback:", (err as Error)?.message);
      }
    }
  }

  // Text fallback: show options inline, clearly labelled
  const opts = buttons.map((b, i) => `*${i + 1}.* ${b}`).join("\n");
  const fullBody = buttons.length > 0 ? `${body}\n\n${opts}` : body;
  await twilioClient.messages.create({ from: FROM_NUMBER, to, body: fullBody } as any);
}

/**
 * Send a WhatsApp button message for a yes/no or binary choice.
 */
export async function sendWhatsAppYesNo(
  to: string,
  body: string,
  yesLabel = "Yes, done ✅",
  noLabel = "Not yet"
): Promise<void> {
  return sendWhatsAppButtons(to, body, [yesLabel, noLabel]);
}

/**
 * Encode a button reply for use in webhook reply handlers.
 * Returns a [BUTTONS:...] marker that whatsapp.ts strips and sends via REST API.
 */
export function replyWithButtons(body: string, buttons: string[]): string {
  const limited = buttons.slice(0, 3).join("|");
  return `${body}\n[BUTTONS:${limited}]`;
}
