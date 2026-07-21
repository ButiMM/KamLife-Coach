import type { Express } from "express";
import twilio from "twilio";
import type { RouteDeps } from "./types";
import { requireAdminKey } from "./auth";
import { sendWhatsAppButtons } from "../twilio-interactive";
import { db } from "../db";
import { processedWebhooks, users } from "../../shared/schema";
import { eq } from "drizzle-orm";
import { captureQualitySignal } from "../quality-signals";
import { recordMediaJob, completeMediaJob } from "../media-jobs";

// COMEBACK RECOGNITION (2026-07-13 retention P0): when a client messages after ≥3 days
// of silence, their FIRST reply back opens with a warm welcome — the return must feel
// like a win, not a walk of shame. Self-deduping: that first message resets
// lastActiveAt, so only one reply per comeback ever carries the line. Read the gap
// BEFORE handleMessage runs (which updates lastActiveAt).
async function comebackPrefix(phone: string): Promise<string> {
  try {
    const [u] = await db.select({ lastActiveAt: users.lastActiveAt, onboardingState: users.onboardingState })
      .from(users).where(eq(users.phoneNumber, phone)).limit(1);
    if (!u || u.onboardingState !== "COMPLETE" || !u.lastActiveAt) return "";
    const gapDays = (Date.now() - new Date(u.lastActiveAt).getTime()) / 86_400_000;
    if (gapDays < 3) return "";
    return `You came back — that's the real streak. 💛 No catch-up needed, we start from today.\n\n`;
  } catch { return ""; }
}

const TWILIO_FROM = () => process.env.TWILIO_WHATSAPP_NUMBER
  ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}`
  : "";

async function sendParts(
  phone: string,
  parts: string[],
  replyMedia: string | string[] | null,
): Promise<void> {
  const fromNum = TWILIO_FROM();
  if (!fromNum) { console.error("[TEXT_ASYNC] TWILIO_WHATSAPP_NUMBER not set"); return; }
  const twilioC = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
  const mediaUrls = Array.isArray(replyMedia) ? replyMedia.filter(Boolean) : (replyMedia ? [replyMedia] : []);
  const sendOne = async (params: Record<string, unknown>, label: string) => {
    const delays = [0, 2000, 5000, 10000];
    const bodyLen = typeof params.body === "string" ? (params.body as string).length : 0;
    const hasMedia = Array.isArray(params.mediaUrl) && (params.mediaUrl as unknown[]).length > 0;
    for (let d = 0; d < delays.length; d++) {
      if (delays[d] > 0) await new Promise(r => setTimeout(r, delays[d]));
      try {
        await twilioC.messages.create(params as unknown as Parameters<typeof twilioC.messages.create>[0]);
        return;
      } catch (e: any) {
        // Structured failure log: Twilio error code + body length make silent drops diagnosable.
        // Code 21617 = body over 1600 chars; 63016/63021 = media fetch/format rejected.
        console.error(`[TWILIO_SEND] ${label} attempt ${d + 1}/${delays.length} failed — code=${e?.code ?? "?"} status=${e?.status ?? "?"} bodyLen=${bodyLen} media=${hasMedia} msg="${(e?.message || "").slice(0, 160)}"`);
        if (d === delays.length - 1) console.error(`[TWILIO_SEND] ${label} GAVE UP after ${delays.length} attempts — reply NOT delivered`);
      }
    }
  };
  // Hard safety net: never hand Twilio a body over the 1600 limit even if a caller
  // forgot to splitMessage. Re-split any oversized part here so text always lands.
  // Uses the single TWILIO_WHATSAPP_BODY_LIMIT constant — same value splitMessage defaults to.
  const textParts = parts
    .filter(p => p.trim())
    .flatMap(p => (p.length > TWILIO_WHATSAPP_BODY_LIMIT ? splitMessage(p, TWILIO_WHATSAPP_BODY_LIMIT) : [p]));
  // Text is ALWAYS sent standalone; media ALWAYS follows as its own message(s).
  // We deliberately do NOT ride text as a media caption. Twilio rejects the WHOLE
  // message — text included — if it cannot fetch/validate the media URL (bad GIF host,
  // 404, wrong content-type) OR if the caption exceeds WhatsApp's caption cap (~1600
  // chars, which a full workout blows past). That silently swallowed entire workout
  // replies — "Today's workout" returned nothing — while text-only menus delivered fine.
  // Decoupling guarantees the reply text always lands; a failed image only loses the image.
  for (let i = 0; i < textParts.length; i++) {
    await sendOne({ from: fromNum, to: phone, body: textParts[i].trim() }, `part ${i + 1}`);
  }
  for (let k = 0; k < mediaUrls.length; k++) {
    await sendOne({ from: fromNum, to: phone, mediaUrl: [mediaUrls[k]] }, `media ${k + 1}`);
  }
}

// ── Bot marker rendering ──
// handleMessage replies can embed two bot-only markers:
//   [BUTTONS:A|B|C]   — quick-reply options
//   [MEDIA:https://…] — one or more images (workout GIFs, portion guides)
//
// Buttons are NOT sent as real WhatsApp interactive buttons: the Twilio Content API
// requires Meta template approval and silently drops unapproved sends. We used to render
// them as a numbered list ("1. Today's workout"), but the global single-digit shortcuts
// (1=workout, 2=steps, 3=food…) are FIXED and don't match each menu's button order — so a
// rendered "3. My progress" actually fired food logging, and "1. Log food" on a rest day
// delivered a workout. Every button label has a working text handler, so we render them as
// type-able keyword prompts and let the client reply with the word — which always routes right.
//
// Shared by the text AND voice paths so neither leaks raw markers (voice replies that carry
// a workout GIF + buttons previously sent the literal "[MEDIA:…][BUTTONS:…]" text).
function renderReplyMarkers(reply: string): { text: string; media: string[] } {
  const withButtons = reply.replace(/\s*\[BUTTONS:([^\]]+)\]/g, (_, opts) => {
    const labels = opts.split("|").map((b: string) => b.trim()).filter(Boolean);
    return labels.length ? `\n\n${labels.map((b: string) => `▸ *${b}*`).join("\n")}` : "";
  });
  const media = [...withButtons.matchAll(/\[MEDIA:(https?:\/\/[^\]]+)\]/g)].map(mm => mm[1]);
  const text = media.length ? withButtons.replace(/\s*\[MEDIA:https?:\/\/[^\]]+\]/g, "").trim() : withButtons;
  return { text, media };
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
  sourceMessageId?: string,
): Promise<void> {
  const isImageMessage = !!(mediaUrl && mediaType?.startsWith("image/"));
  try {
    const welcomeBack = await comebackPrefix(phone);
    const reply = await handleMessage(phone, message, mediaUrl || undefined, mediaType || undefined, allImageUrls.length > 1 ? allImageUrls : undefined, sourceMessageId);

    // Render bot markers: buttons → keyword prompts, media extracted for separate sends.
    const { text: rawReply, media: replyMediaUrls } = renderReplyMarkers(reply);
    // NEVER-SILENT GUARANTEE (2026-07-13): an empty reply used to send NOTHING — a
    // tester's 38s form-check video got dead air ("And it has still not replied").
    // Whatever failed upstream, the client always hears back.
    const cleanReply = rawReply && rawReply.trim().length > 0
      ? welcomeBack + rawReply
      : (mediaType?.startsWith("video/")
        ? `I got your video but couldn't process it — likely too long. Send a shorter clip (under 30 seconds, one set from the side) and I'll check your form.`
        : `I got your message but hit a snag processing it. Try sending it again, or type it differently — I'm here.`);
    if (!rawReply || rawReply.trim().length === 0) {
      console.error(`[NEVER_SILENT] empty reply for ${phone.slice(-4)} — media=${mediaType || "none"} msg="${(message || "").slice(0, 60)}"`);
      // Turn the fumble into product improvement material instead of a dead log line.
      captureQualitySignal("never_silent", { phone, messageIn: message, messageOut: cleanReply, detail: `media=${mediaType || "none"}` });
    }

    // Image messages without a GIF/media attachment go through the coalescing buffer
    // so that album bursts (N photos sent together) result in ONE combined reply.
    // Replies that include a media URL (equipment GIFs, etc.) are sent immediately.
    if (isImageMessage && !replyMediaUrls.length) {
      await resolveImageInflight(phone, cleanReply);
      return;
    }

    await sendParts(phone, splitMessage(cleanReply), replyMediaUrls);
  } catch (err: any) {
    console.error("[TEXT_ASYNC] failed:", err?.message || err);
    // For image messages: resolve inflight so the buffer doesn't hang, then send the error.
    if (isImageMessage) await resolveImageInflight(phone, null).catch(() => {});
    await sendParts(phone, ["Eish, something went wrong on my side. Give me a second and try again."], null).catch(() => {});
  } finally {
    // Media crash-safety net: the client was replied to (or got a handled error) → close the job.
    if (mediaUrl) await completeMediaJob(sourceMessageId).catch(() => {});
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
  sourceMessageId?: string,
): Promise<void> {
  try {
    const welcomeBack = await comebackPrefix(phone);
    const reply = await handleMessage(phone, message, mediaUrl, mediaType, undefined, sourceMessageId);
    // Render markers too — a voice note can trigger a workout (GIF + buttons) or a menu,
    // and previously those markers were sent to the client as literal text.
    const { text: rawVoiceText, media } = renderReplyMarkers(reply);
    // Never-silent guarantee (2026-07-13) — see processTextAsync.
    const text = rawVoiceText && rawVoiceText.trim().length > 0
      ? welcomeBack + rawVoiceText
      : `I heard your voice note but couldn't work out what to do with it — say it once more, or type it.`;
    const parts = splitMessage(text);
    await sendParts(phone, parts, media);
    console.log(`[VOICE_ASYNC] delivered ${parts.length} part(s) to ${phone.slice(-4)}`);
  } catch (err: any) {
    console.error("[VOICE_ASYNC] failed:", err?.message || err);
    await sendParts(phone, ["I got your voice note but had a moment — please send it again or type your message."], null).catch(() => {});
  } finally {
    await completeMediaJob(sourceMessageId).catch(() => {});
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

// Twilio HARD-CAPS the WhatsApp message body at 1600 characters. A body over 1600
// is rejected outright with error 21617 — the message never sends. A full workout is
// ~2200+ chars, so at the old 3800 limit the workout text was ONE oversized part that
// Twilio silently rejected, while the separate image still delivered — producing the
// "Today's workout returns a photo and no text" bug. 1500 leaves margin under 1600.
const TWILIO_WHATSAPP_BODY_LIMIT = 1500;
function splitMessage(text: string, maxLen = TWILIO_WHATSAPP_BODY_LIMIT): string[] {
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
  // DB-backed (processed_webhooks table) so restarts and multi-replica deployments don't
  // allow re-processing. In-memory Map kept as fast fallback when DB is unavailable.
  const processedSids = new Map<string, number>(); // SID → timestamp (fallback only)

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

      // MessageSid dedup — drop Twilio retries. DB-backed so cross-replica + restart-safe.
      const msgSid = (req.body.MessageSid || "") as string;
      if (msgSid) {
        const now = Date.now();
        try {
          const inserted = await db.insert(processedWebhooks)
            .values({ messageSid: msgSid })
            .onConflictDoNothing()
            .returning({ sid: processedWebhooks.messageSid });
          if (!inserted.length) {
            console.warn(`[WEBHOOK] Duplicate MessageSid ${msgSid} — dropping retry`);
            return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
          }
          processedSids.set(msgSid, now); // mirror in-memory for fast same-instance checks
        } catch {
          // DB unavailable — fall back to in-memory dedup only
          if (processedSids.has(msgSid)) {
            console.warn(`[WEBHOOK] Duplicate MessageSid ${msgSid} (in-memory fallback) — dropping retry`);
            return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
          }
          processedSids.set(msgSid, now);
        }
        // Evict stale in-memory entries to prevent unbounded growth
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
        res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
        // No "I'll reply in a moment" — the coach must never sound like it might go
        // quiet or promise a future message (a real reply IS seconds away).
        sendParts(rawPhone, ["🎤 Coach K is listening…"], null).catch(() => {});
        if (msgSid) recordMediaJob(msgSid, rawPhone, null, mediaType || "audio/ogg").catch(() => {}); // crash-safety net
        processVoiceAsync(rawPhone, message, mediaUrl, mediaType || "audio/ogg", handleMessage, msgSid || undefined).catch(() => {});
        return;
      }

      // ── ALL TEXT MESSAGES: ACK immediately, process in background ──
      // Twilio's 15s hard timeout is a real risk for GPT calls (5-15s each).
      // Respond instantly with empty TwiML, deliver the real reply via outbound API.
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
      // Register the inflight counter BEFORE firing async processing so all photos in
      // an album burst are counted before any handler resolves and flushes the buffer.
      // On the FIRST image of a burst, send an immediate ACK so the user doesn't see
      // 20-30 seconds of silence while vision processes.
      if (mediaUrl && mediaType?.startsWith("image/")) {
        const isFirstInBurst = !photoReplyBuffer.has(rawPhone);
        bumpImageInflight(rawPhone);
        if (isFirstInBurst) {
          sendParts(rawPhone, ["📸 Got your photo, one sec…"], null).catch(() => {});
        }
      }
      if (mediaUrl && msgSid) recordMediaJob(msgSid, rawPhone, null, mediaType).catch(() => {}); // crash-safety net for photo/video
      processTextAsync(rawPhone, message, mediaUrl, mediaType, allImageUrls, handleMessage, msgSid || undefined).catch(() => {});
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
