import type { Express } from "express";
import twilio from "twilio";
import type { RouteDeps } from "./types";
import { requireAdminKey } from "./auth";

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

export function registerWhatsAppRoutes(app: Express, deps: Pick<RouteDeps, "handleMessage" | "checkRateLimit">) {
  const { handleMessage, checkRateLimit } = deps;

  // Dedup map for WhatsApp album spam: one reply per phone per 10s window for media-only messages.
  // WhatsApp albums arrive as N separate webhooks — we reply to the first, drop the rest silently.
  const mediaDedup = new Map<string, number>();

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

      // WhatsApp albums arrive as separate webhooks — one per photo. Deduplicate: if this phone
      // already got a reply for a media-only message within the last 10 seconds, drop silently.
      if (mediaUrl && !message) {
        const lastSent = mediaDedup.get(rawPhone);
        const now = Date.now();
        if (lastSent && now - lastSent < 10_000) {
          return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
        }
        mediaDedup.set(rawPhone, now);
        // Evict stale entries to prevent unbounded growth
        if (mediaDedup.size > 500) {
          for (const [k, v] of mediaDedup) {
            if (now - v > 30_000) mediaDedup.delete(k);
          }
        }
      }

      const reply = await handleMessage(rawPhone, message, mediaUrl || undefined, mediaType || undefined, allImageUrls.length > 1 ? allImageUrls : undefined);

      // Extract [MEDIA:url] marker injected by handlers (exercise GIFs, portion plate images)
      const mediaMarkerMatch = reply.match(/\[MEDIA:(https?:\/\/[^\]]+)\]/);
      const replyMediaUrl = mediaMarkerMatch ? mediaMarkerMatch[1] : null;
      const cleanReply = replyMediaUrl ? reply.replace(/\s*\[MEDIA:https?:\/\/[^\]]+\]/, "").trim() : reply;

      const parts = splitMessage(cleanReply);

      if (parts.length <= 1) {
        if (replyMediaUrl) {
          const safe = escapeXml(cleanReply);
          const safeMedia = escapeXml(replyMediaUrl);
          return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message><Body>${safe}</Body><Media>${safeMedia}</Media></Message></Response>`);
        }
        const safe = escapeXml(cleanReply);
        return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`);
      }

      // Multi-part: TwiML can only send one reply, send extra via API
      const firstPart = escapeXml(parts[0]);
      if (replyMediaUrl) {
        const safeMedia = escapeXml(replyMediaUrl);
        res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message><Body>${firstPart}</Body><Media>${safeMedia}</Media></Message></Response>`);
      } else {
        res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${firstPart}</Message></Response>`);
      }

      const twilioC = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
      const fromNum = process.env.TWILIO_WHATSAPP_NUMBER
        ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}`
        : "";
      if (fromNum) {
        for (let i = 1; i < parts.length; i++) {
          const delays = [0, 2000, 5000];
          let sent = false;
          for (let d = 0; d < delays.length; d++) {
            if (delays[d] > 0) await new Promise(r => setTimeout(r, delays[d]));
            try {
              await twilioC.messages.create({ from: fromNum, to: rawPhone, body: parts[i] });
              sent = true;
              break;
            } catch (e: any) {
              if (d === delays.length - 1) console.error(`[MULTI-MSG] Part ${i + 1} failed after ${d + 1} attempts: ${e.message}`);
            }
          }
          if (!sent) console.error(`[MULTI-MSG] Part ${i + 1} permanently dropped for ${rawPhone.slice(-6)}`);
        }
      }
    } catch (err: any) {
      console.error("[WHATSAPP] Webhook error:", err.message);
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Something went wrong. Try again in a moment.</Message></Response>`);
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
