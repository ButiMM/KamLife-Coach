import type { Express } from "express";
import twilio from "twilio";
import type { RouteDeps } from "./types";
import { requireAdminKey } from "./auth";
import { sendWhatsAppButtons } from "../twilio-interactive";

const TWILIO_FROM = () => process.env.TWILIO_WHATSAPP_NUMBER
  ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}`
  : "";

async function sendParts(
  phone: string,
  parts: string[],
  replyMediaUrl: string | null,
): Promise<void> {
  const fromNum = TWILIO_FROM();
  if (!fromNum) { console.error("[TEXT_ASYNC] TWILIO_WHATSAPP_NUMBER not set"); return; }
  const twilioC = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].trim()) continue;
    const params: Record<string, unknown> = { from: fromNum, to: phone, body: parts[i].trim() };
    if (i === 0 && replyMediaUrl) params.mediaUrl = [replyMediaUrl];
    const delays = [0, 2000, 5000, 10000];
    for (let d = 0; d < delays.length; d++) {
      if (delays[d] > 0) await new Promise(r => setTimeout(r, delays[d]));
      try { await twilioC.messages.create(params as unknown as Parameters<typeof twilioC.messages.create>[0]); break; }
      catch (e: any) { if (d === delays.length - 1) console.error(`[TEXT_ASYNC] part ${i + 1} failed: ${e.message}`); }
    }
  }
}

// ── Async text processor ──
// All text messages are handled async so Twilio gets an instant 200 and never times out.
// The real reply is delivered via outbound Twilio API once handleMessage resolves.
async function processTextAsync(
  phone: string,
  message: string,
  mediaUrl: string | null,
  mediaType: string | null,
  allImageUrls: string[],
  handleMessage: RouteDeps["handleMessage"],
): Promise<void> {
  const isImageMessage = !!(mediaUrl && mediaType?.startsWith("image/"));
  try {
    const reply = await handleMessage(phone, message, mediaUrl || undefined, mediaType || undefined, allImageUrls.length > 1 ? allImageUrls : undefined);

    // Strip [BUTTONS:...] — send numbered options inline via proven sendParts path.
    // Twilio Content API (used by sendWhatsAppButtons) requires Meta template approval
    // in production and silently drops unapproved messages with no error surfaced.
    const cleanedReply = reply.replace(/\s*\[BUTTONS:([^\]]+)\]/g, (_, opts) => {
      const labels = opts.split("|").map((b: string) => b.trim()).filter(Boolean);
      return `\n\n${labels.map((b: string, i: number) => `*${i + 1}.* ${b}`).join("\n")}`;
    });

    const mediaMarkerMatch = cleanedReply.match(/\[MEDIA:(https?:\/\/[^\]]+)\]/);
    const replyMediaUrl = mediaMarkerMatch ? mediaMarkerMatch[1] : null;
    const cleanReply = replyMediaUrl ? cleanedReply.replace(/\s*\[MEDIA:https?:\/\/[^\]]+\]/, "").trim() : cleanedReply;

    // Image messages without a GIF/media attachment go through the coalescing buffer
    // so that album bursts (N photos sent together) result in ONE combined reply.
    // Replies that include a media URL (equipment GIFs, etc.) are sent immediately.
    if (isImageMessage && !replyMediaUrl) {
      await resolveImageInflight(phone, cleanReply);
      return;
    }

    await sendParts(phone, splitMessage(cleanReply), replyMediaUrl);
  } catch (err: any) {
    console.error("[TEXT_ASYNC] failed:", err?.message || err);
    // For image messages: resolve inflight so the buffer doesn't hang, then send the error.
    if (isImageMessage) await resolveImageInflight(phone, null).catch(() => {});
    await sendParts(phone, ["Eish, something went wrong on my side. Give me a second and try again."], null).catch(() => {});
  }
}

// ── Async voice processor ──
// Twilio times out after 15s. Whisper takes 20-38s.
// Solution: ACK immediately, process in background, deliver via outbound API.
async function processVoiceAsync(
  phone: string,
  message: string,
  mediaUrl: string,
  mediaType: string,
  handleMessage: RouteDeps["handleMessage"],
): Promise<void> {
  try {
    const reply = await handleMessage(phone, message, mediaUrl, mediaType, undefined);
    const parts = reply.split(/\n\n---\n\n/).filter(Boolean);
    await sendParts(phone, parts, null);
    console.log(`[VOICE_ASYNC] delivered ${parts.length} part(s) to ${phone.slice(-6)}`);
  } catch (err: any) {
    console.error("[VOICE_ASYNC] failed:", err?.message || err);
  }
}

// ── WhatsApp message splitting ──

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function splitMessage(text: string, maxLen = 1500): string[] {
  if (/\n\n---\n\n/.test(text)) {
    const days = text.split(/\n\n---\n\n/);
    const result: string[] = [];
    for (const day of days) {
      if (day.trim()) result.push(...splitMessage(day.trim(), maxLen));
    }
    return result;
  }
  if (text.length <= maxLen) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? current + "\n" + line : line;
    if (candidate.length > maxLen) {
      if (current) chunks.push(current.trim());
      if (line.length > maxLen) {
        let remaining = line;
        while (remaining.length > maxLen) {
          const cutAt = remaining.lastIndexOf(" ", maxLen);
          const breakAt = cutAt > 0 ? cutAt : maxLen;
          chunks.push(remaining.slice(0, breakAt).trim());
          remaining = remaining.slice(breakAt).trim();
        }
        current = remaining;
      } else {
        current = line;
      }
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

// ── Per-phone album photo coalescing ──────────────────────────────────────────
// When a client picks several photos from their gallery and sends them together,
// WhatsApp fires N separate webhooks milliseconds apart — each with a distinct
// MessageSid and URL. Without coalescing, each generates its own bot reply, so
// 10 food photos = 10 separate WhatsApp messages, which is noisy and confusing.
//
// Design: before each image processTextAsync is fired, we bump an inflight counter
// for that phone. When a handler resolves, we push the reply into a buffer and
// decrement the counter. When the counter reaches 0 (all handlers for this burst
// are done), a 400ms timer fires to flush all replies as one combined message.
// The 400ms window lets any final DB writes (recomputeTodayFoodTotals) settle.
const photoReplyBuffer = new Map<string, {
  parts: string[];
  failedCount: number;
  inflight: number;
  timer: ReturnType<typeof setTimeout> | null;
}>();

function bumpImageInflight(phone: string): void {
  const e = photoReplyBuffer.get(phone);
  if (e) {
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    e.inflight++;
  } else {
    photoReplyBuffer.set(phone, { parts: [], failedCount: 0, inflight: 1, timer: null });
  }
}

async function resolveImageInflight(phone: string, reply: string | null): Promise<void> {
  const e = photoReplyBuffer.get(phone);
  if (!e) { if (reply) await sendParts(phone, splitMessage(reply), null); return; }
  if (reply) e.parts.push(reply); else e.failedCount++;
  e.inflight = Math.max(0, e.inflight - 1);
  if (e.inflight === 0) {
    e.timer = setTimeout(() => { flushPhotoBuffer(phone).catch(() => {}); }, 400);
  }
}

async function flushPhotoBuffer(phone: string): Promise<void> {
  const entry = photoReplyBuffer.get(phone);
  if (!entry) return;
  photoReplyBuffer.delete(phone);
  const { parts, failedCount } = entry;
  if (parts.length === 0) return; // all failed — errors already sent individually
  if (parts.length === 1 && failedCount === 0) {
    await sendParts(phone, splitMessage(parts[0]), null);
    return;
  }
  // Multiple parts: strip "Today so far" footer from all but the last (the last has
  // the most accurate totals since all meals have been inserted by then).
  const todayPattern = /\n\n_Today so far:[\s\S]*$/;
  const bodies = parts.map((p, i) => (i === parts.length - 1 ? p : p.replace(todayPattern, "").trim()));
  const batchNote = `\n\n_${parts.length} photo${parts.length > 1 ? "s" : ""} — all logged._`;
  const failNote = failedCount > 0 ? `\n_(${failedCount} unclear — resend in better light if needed)_` : "";
  const combined = bodies.join("\n\n") + batchNote + failNote;
  await sendParts(phone, splitMessage(combined), null);
}

export function registerWhatsAppRoutes(app: Express, deps: Pick<RouteDeps, "handleMessage" | "checkRateLimit">) {
  const { handleMessage, checkRateLimit } = deps;

  // URL-level dedup: same exact URL resent within 30s = accidental retry of one image, drop it.
  const mediaDedup = new Map<string, number>();

  // MessageSid dedup: Twilio retries the webhook if we don't respond within 15s.
  // Since we ACK immediately with empty TwiML, retries should be rare — but if they
  // happen (network glitch, slow response), we must not double-process the same message.
  const processedSids = new Map<string, number>(); // SID → timestamp

  // ── Main Twilio WhatsApp webhook ──
  app.post("/twilio/whatsapp", async (req, res) => {
    try {
      // Twilio signature verification
      const authToken = process.env.TWILIO_AUTH_TOKEN || "";
      if (authToken) {
        const signature = (req.headers["x-twilio-signature"] as string) || "";
        const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
        const fullUrl = `${proto}://${req.get("host")}${req.originalUrl}`;
        const valid = twilio.validateRequest(authToken, signature, fullUrl, req.body);
        if (!valid) {
          console.warn(`[SECURITY] Twilio signature validation failed from ${req.ip}`);
          return res.status(403).end();
        }
      } else if (process.env.NODE_ENV === "production") {
        console.error("[SECURITY] TWILIO_AUTH_TOKEN not set in production — rejecting request");
        return res.status(503).end();
      } else {
        console.warn("[SECURITY] TWILIO_AUTH_TOKEN not set — signature validation skipped (dev only)");
      }

      // Rate limiter
      const rawPhoneEarly = (req.body.From || "") as string;
      const phoneKey = rawPhoneEarly.replace(/^(whatsapp:)\s+/, "$1+");
      if (!await checkRateLimit(phoneKey)) {
        return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Too many messages. Wait 60 seconds.</Message></Response>`);
      }

      // MessageSid dedup — drop retries that arrive after we already ACK'd
      const msgSid = (req.body.MessageSid || "") as string;
      if (msgSid) {
        const now = Date.now();
        if (processedSids.has(msgSid)) {
          console.warn(`[WEBHOOK] Duplicate MessageSid ${msgSid} — dropping retry`);
          return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
        }
        processedSids.set(msgSid, now);
        // Evict entries older than 24h to prevent unbounded growth
        if (processedSids.size > 2000) {
          for (const [k, v] of processedSids) {
            if (now - v > 86_400_000) processedSids.delete(k);
          }
        }
      }

      const rawPhone = phoneKey;
      // Guard: malformed or missing From field — Twilio always sends this
      if (!rawPhone || !rawPhone.startsWith("whatsapp:")) {
        console.warn(`[WEBHOOK] Invalid From field: ${JSON.stringify(rawPhone)}`);
        return res.status(400).end();
      }
      const rawMsg = ((req.body.Body || "") as string).trim();
      const numMedia = Number(req.body.NumMedia || 0);
      const mediaItems = Array.from({ length: Math.max(0, numMedia) }, (_, idx) => ({
        url: (req.body[`MediaUrl${idx}`] || "") as string,
        type: (req.body[`MediaContentType${idx}`] || "") as string,
      })).filter(item => item.url);

      // Prefer audio/video first (voice note takes priority), then first image
      const audioMedia = mediaItems.find(item => /^audio\//i.test(item.type));
      const selectedMedia = audioMedia
        || mediaItems.find(item => /^(image|video)\//i.test(item.type))
        || mediaItems[0]
        || null;
      const mediaUrl = selectedMedia?.url || null;
      const mediaType = selectedMedia?.type || null;

      // Collect ALL image URLs for multi-photo handling (collages, meal albums)
      // Audio/video items are excluded — only food/step/progress images need multi-processing
      const allImageUrls = !audioMedia
        ? mediaItems.filter(item => /^image\//i.test(item.type)).map(item => item.url)
        : [];

      const message = rawMsg;
      // Allow empty text when media exists so downstream handler can detect "no caption" correctly.
      if (!message && !mediaUrl) {
        return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
      }

      // Dedup for media-only messages (no text caption).
      // We do NOT drop "album" photos by sender. When a client picks several meal photos
      // from their gallery and sends them together, WhatsApp delivers them as N separate
      // webhooks — distinct URLs + MessageSids, same sender, milliseconds apart. Each one is
      // a DISTINCT meal and must be logged. The previous phone-level drop ate every photo
      // after the first (one meal logged, the rest silently lost). Genuine duplicates are
      // still caught by the MessageSid dedup above and the same-URL dedup right here.
      if (mediaUrl && !message) {
        const now = Date.now();
        const lastSent = mediaDedup.get(mediaUrl);
        if (lastSent && now - lastSent < 30_000) {
          return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
        }
        mediaDedup.set(mediaUrl, now);
        // Evict stale entries to prevent unbounded growth
        if (mediaDedup.size > 500) {
          for (const [k, v] of mediaDedup) {
            if (now - v > 30_000) mediaDedup.delete(k);
          }
        }
      }

      // ── ASYNC VOICE: ACK immediately, process in background ──
      // Twilio hard-kills after 15s. Whisper takes 20-38s. We can never finish in time synchronously.
      if (audioMedia && mediaUrl) {
        res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>🎤 Coach K is listening... I'll reply in a moment.</Message></Response>`);
        processVoiceAsync(rawPhone, message, mediaUrl, mediaType || "audio/ogg", handleMessage).catch(() => {});
        return;
      }

      // ── ALL TEXT MESSAGES: ACK immediately, process in background ──
      // Twilio's 15s hard timeout is a real risk for GPT calls (5-15s each).
      // Respond instantly with empty TwiML, deliver the real reply via outbound API.
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
      // Register the inflight counter BEFORE firing async processing so all photos in
      // an album burst are counted before any handler resolves and flushes the buffer.
      if (mediaUrl && mediaType?.startsWith("image/")) bumpImageInflight(rawPhone);
      processTextAsync(rawPhone, message, mediaUrl, mediaType, allImageUrls, handleMessage).catch(() => {});
    } catch (err: any) {
      console.error("[WHATSAPP] Webhook error:", err.message);
      if (!res.headersSent) {
        res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Something went wrong. Try again in a moment.</Message></Response>`);
      }
    }
  });

  // ── Test webhook — admin only ──
  app.post("/api/admin/test-webhook", requireAdminKey, async (req, res) => {
    try {
      const { phone, message } = req.body;
      if (!phone || !message) return res.status(400).json({ error: "phone and message required" });
      const reply = await handleMessage(phone, message);
      res.json({ reply });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });
}
