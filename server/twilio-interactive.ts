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
 * Falls back to formatted numbered text if Content API fails or is not configured.
 * Set TWILIO_ENABLE_BUTTONS=true in Railway env to activate live buttons.
 */

import twilio from "twilio";

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const FROM_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER
  ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}`
  : "";

const BUTTONS_ENABLED = process.env.TWILIO_ENABLE_BUTTONS === "true";

// Re-use the same Twilio client (does not create a new TCP connection)
const twilioClient = twilio(ACCOUNT_SID, AUTH_TOKEN);

// Cache ContentSids by button set — avoids recreating templates on every call
const _templateCache = new Map<string, string>();

function _cacheKey(buttons: string[]): string {
  return buttons.slice(0, 3).join("|||");
}

async function _getOrCreateTemplate(buttons: string[]): Promise<string | null> {
  const key = _cacheKey(buttons);
  if (_templateCache.has(key)) return _templateCache.get(key)!;

  try {
    const limited = buttons.slice(0, 3);
    // Content API: create a quick-reply template.
    // Body uses {{1}} variable — we inject the actual message at send time.
    const created = await (twilioClient as any).content.v1.contents.create({
      friendlyName: `kamlife_btn_${Date.now()}`,
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
    console.log(`[BUTTONS] Created template ${sid} for: ${limited.join(" | ")}`);
    return sid;
  } catch (err: unknown) {
    console.warn("[BUTTONS] Content API template creation failed:", (err as Error)?.message);
    return null;
  }
}

/**
 * Send a WhatsApp message with up to 3 quick-reply buttons.
 * Falls back to formatted numbered text automatically.
 */
export async function sendWhatsAppButtons(
  to: string,
  body: string,
  buttons: string[]
): Promise<void> {
  if (!FROM_NUMBER) return;

  if (BUTTONS_ENABLED && buttons.length > 0) {
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

  // Text fallback: format as a clear numbered menu
  const menu = buttons.map((b, i) => `*${i + 1}.* ${b}`).join("\n");
  const fullBody = buttons.length > 0 ? `${body}\n\n${menu}` : body;
  await twilioClient.messages.create({ from: FROM_NUMBER, to, body: fullBody } as any);
}

/**
 * Send a WhatsApp button message for a yes/no or binary choice.
 * The two options are always rendered as buttons (or "Yes / No" text).
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
 * Returns a string with a [BUTTONS:...] marker that whatsapp.ts detects and
 * sends as interactive tap buttons via REST API (bypasses TwiML limitation).
 *
 * Usage in any handler:
 *   return replyWithButtons("Gym or home training?", ["Gym", "Home", "No equipment"]);
 */
export function replyWithButtons(body: string, buttons: string[]): string {
  const limited = buttons.slice(0, 3).join("|");
  return `${body}\n[BUTTONS:${limited}]`;
}
