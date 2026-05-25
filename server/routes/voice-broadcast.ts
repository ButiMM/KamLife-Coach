import type { Express } from "express";
import { pool } from "../db";
import { sendWhatsApp } from "../scheduler";
import { requireAdminKey } from "./auth";
import { isElevenLabsConfigured, getElevenLabsQuota, textToSpeech } from "../elevenlabs";

const ALLOWED_AUDIO_TYPES = new Set([
  "audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm",
  "audio/wav", "audio/x-m4a", "audio/aac", "audio/opus",
]);

export function registerVoiceBroadcastRoutes(app: Express) {

  // ── Upload a voice broadcast (stores base64 audio in DB) ──
  app.post("/api/admin/voice-broadcast/upload", requireAdminKey, async (req: any, res: any) => {
    try {
      const { base64, contentType = "audio/ogg", label = "Voice Broadcast", durationSecs } = req.body || {};
      if (!base64) return res.status(400).json({ error: "base64 audio data required" });
      if (!ALLOWED_AUDIO_TYPES.has(contentType)) {
        return res.status(415).json({ error: "Unsupported audio type. Use ogg, mp3, mp4, webm, or wav." });
      }
      const cleaned = base64.replace(/^data:[^;]+;base64,/, "");
      const sizeBytes = Buffer.byteLength(cleaned, "base64");
      if (sizeBytes > 8 * 1024 * 1024) return res.status(413).json({ error: "Audio must be under 8MB" });

      const { rows } = await pool.query<{ id: string; label: string; created_at: string }>(
        `INSERT INTO voice_broadcasts (label, audio_base64, content_type, duration_secs)
         VALUES ($1, $2, $3, $4)
         RETURNING id, label, created_at`,
        [label.slice(0, 120), cleaned, contentType, durationSecs ?? null]
      );
      return res.status(201).json({ broadcast: rows[0] });
    } catch (e: any) {
      console.error("[VOICE_BROADCAST] Upload error:", e.message);
      return res.status(500).json({ error: "Upload failed" });
    }
  });

  // ── Serve audio publicly — no auth, Twilio must be able to fetch this URL ──
  app.get("/api/voice-broadcast/:id/audio", async (req: any, res: any) => {
    try {
      const { rows } = await pool.query<{ audio_base64: string; content_type: string }>(
        `SELECT audio_base64, content_type FROM voice_broadcasts WHERE id = $1`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).end();
      const buf = Buffer.from(rows[0].audio_base64, "base64");
      res.set("Content-Type", rows[0].content_type);
      res.set("Content-Length", String(buf.length));
      res.set("Cache-Control", "public, max-age=86400");
      return res.send(buf);
    } catch (e: any) {
      console.error("[VOICE_BROADCAST] Serve error:", e.message);
      return res.status(500).end();
    }
  });

  // ── Send a broadcast to all active clients ──
  app.post("/api/admin/voice-broadcast/:id/send", requireAdminKey, async (req: any, res: any) => {
    try {
      const { id } = req.params;
      const { caption = "" } = req.body || {};

      // Check broadcast exists
      const { rows: bRows } = await pool.query<{ id: string; sent_at: string | null }>(
        `SELECT id, sent_at FROM voice_broadcasts WHERE id = $1`, [id]
      );
      if (!bRows.length) return res.status(404).json({ error: "Broadcast not found" });
      if (bRows[0].sent_at) return res.status(409).json({ error: "Already sent — upload a new recording to send again" });

      // Get all active subscribers
      const { rows: users } = await pool.query<{ phone_number: string; name: string | null }>(
        `SELECT phone_number, name FROM users WHERE subscription_status = 'active' ORDER BY created_at`
      );
      if (!users.length) return res.status(200).json({ sent: 0, message: "No active clients to send to" });

      const appUrl = (process.env.APP_URL || "").replace(/\/$/, "");
      if (!appUrl) return res.status(400).json({ error: "APP_URL env var not set — needed to generate media URL for Twilio" });
      const audioUrl = `${appUrl}/api/voice-broadcast/${id}/audio`;

      // Send to each client with a small delay to avoid Twilio rate limits
      let sent = 0;
      let failed = 0;
      for (const user of users) {
        try {
          await sendWhatsApp(user.phone_number, caption, audioUrl);
          sent++;
          // Brief pause every 10 messages — Twilio recommends no more than 1 msg/sec sustained
          if (sent % 10 === 0) await new Promise(r => setTimeout(r, 1000));
        } catch (e: any) {
          failed++;
          console.error(`[VOICE_BROADCAST] Failed to send to ${user.phone_number.slice(-6)}:`, e.message);
        }
      }

      // Mark as sent
      await pool.query(
        `UPDATE voice_broadcasts SET sent_at = NOW(), sent_count = $1 WHERE id = $2`,
        [sent, id]
      );

      console.log(`[VOICE_BROADCAST] Broadcast ${id} sent: ${sent} ok, ${failed} failed`);
      return res.json({ sent, failed, total: users.length });
    } catch (e: any) {
      console.error("[VOICE_BROADCAST] Send error:", e.message);
      return res.status(500).json({ error: "Send failed" });
    }
  });

  // ── List all broadcasts (history) ──
  app.get("/api/admin/voice-broadcasts", requireAdminKey, async (_req: any, res: any) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, label, content_type, duration_secs, sent_count, sent_at, created_at
         FROM voice_broadcasts
         ORDER BY created_at DESC
         LIMIT 50`
      );
      return res.json({ broadcasts: rows });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Delete a broadcast ──
  app.delete("/api/admin/voice-broadcast/:id", requireAdminKey, async (req: any, res: any) => {
    try {
      await pool.query(`DELETE FROM voice_broadcasts WHERE id = $1`, [req.params.id]);
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Serve recap audio publicly — no auth, Twilio must fetch this ──
  app.get("/api/voice-recap/:id/audio", async (req: any, res: any) => {
    try {
      const { rows } = await pool.query<{ audio_base64: string; content_type: string }>(
        `SELECT audio_base64, content_type FROM voice_recap_logs WHERE id = $1`,
        [req.params.id]
      );
      if (!rows.length || !rows[0].audio_base64) return res.status(404).end();
      const buf = Buffer.from(rows[0].audio_base64, "base64");
      res.set("Content-Type", rows[0].content_type);
      res.set("Content-Length", String(buf.length));
      res.set("Cache-Control", "public, max-age=604800");
      return res.send(buf);
    } catch (e: any) {
      return res.status(500).end();
    }
  });

  // ── ElevenLabs status + quota ──
  app.get("/api/admin/voice-recap/status", requireAdminKey, async (_req: any, res: any) => {
    const configured = isElevenLabsConfigured();
    const quota = configured ? await getElevenLabsQuota() : null;
    const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
    const rawUrl = (process.env.APP_URL || railwayDomain || "https://kamlifecoach.co.za").replace(/\/$/, "");
    const appUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const appUrlIsHttps = appUrl.startsWith("https://");
    return res.json({ configured, quota, appUrl, appUrlIsHttps });
  });

  // ── ElevenLabs live test — actually calls the API with a short phrase ──
  app.post("/api/admin/voice-recap/test-tts", requireAdminKey, async (_req: any, res: any) => {
    try {
      const audio = await textToSpeech("Sharp. Coach K here. Audio is working.");
      if (!audio) return res.status(500).json({ ok: false, error: "ElevenLabs returned null — check voiceId and API key in Railway" });
      return res.json({ ok: true, bytes: audio.length });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Preview the script that would be sent to a specific user ──
  app.get("/api/admin/voice-recap/preview/:userId", requireAdminKey, async (req: any, res: any) => {
    try {
      const { previewRecapScript } = await import("../weekly-recap");
      const result = await previewRecapScript(req.params.userId);
      if (!result) return res.status(404).json({ error: "User not found or no data" });
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Force re-run: clears this week's recap logs then re-runs ──
  app.post("/api/admin/voice-recap/force-rerun", requireAdminKey, async (_req: any, res: any) => {
    try {
      const d = new Date();
      const day = d.getUTCDay();
      const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
      const weekStart = monday.toISOString().slice(0, 10);
      await pool.query(`DELETE FROM voice_recap_logs WHERE week_start = $1`, [weekStart]);
      console.log(`[VOICE_RECAP] Force re-run: cleared all recap logs for week ${weekStart}`);
      const { runWeeklyRecaps } = await import("../weekly-recap");
      runWeeklyRecaps().then(r => {
        console.log(`[VOICE_RECAP] Force re-run complete:`, r);
      }).catch(e => {
        console.error(`[VOICE_RECAP] Force re-run error:`, e.message);
      });
      return res.json({ message: `Cleared recaps for week ${weekStart} — regenerating now. Check back in 30 seconds.` });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Manually trigger weekly recaps (for testing) ──
  app.post("/api/admin/voice-recap/run", requireAdminKey, async (_req: any, res: any) => {
    try {
      const { runWeeklyRecaps } = await import("../weekly-recap");
      // Run async — don't block the HTTP response
      runWeeklyRecaps().then(r => {
        console.log(`[VOICE_RECAP] Manual run complete:`, r);
      }).catch(e => {
        console.error(`[VOICE_RECAP] Manual run error:`, e.message);
      });
      return res.json({ message: "Weekly recap run started — check server logs for progress" });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── List recent recap logs ──
  app.get("/api/admin/voice-recap/logs", requireAdminKey, async (req: any, res: any) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "50"), 200);
      const { rows } = await pool.query(
        `SELECT r.id, r.user_id, u.name, r.week_start, r.message_text,
                r.sent_at, r.created_at,
                (r.audio_base64 IS NOT NULL) AS has_audio
         FROM voice_recap_logs r
         JOIN users u ON u.id = r.user_id
         ORDER BY r.created_at DESC
         LIMIT $1`,
        [limit]
      );
      return res.json({ logs: rows });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });
}
