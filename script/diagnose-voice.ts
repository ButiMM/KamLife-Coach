// One-shot voice-recap delivery diagnostic.
//   Run in the Railway shell:  npm run diagnose:voice
//
// Why this exists: Twilio's messages.create() resolves the moment Twilio ACCEPTS
// the message — it fetches the media URL afterwards, asynchronously. So when the
// audio URL is unreachable, the weekly recap "succeeds" in code but silently fails
// to deliver, and the text fallback never fires. This traces every step and then
// POLLS Twilio for the real delivery status — the only place a media-fetch failure
// actually surfaces.

import "dotenv/config";
import twilio from "twilio";
import { pool } from "../server/db";
import { textToSpeech, isElevenLabsConfigured, getElevenLabsQuota } from "../server/elevenlabs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s = "") => console.log(s);

async function main() {
  log("\n=== VOICE RECAP DELIVERY DIAGNOSTIC ===\n");

  // ── 1. Config ────────────────────────────────────────────────────────────
  log(`ElevenLabs configured : ${isElevenLabsConfigured()}  (key:${!!process.env.ELEVENLABS_API_KEY} voiceId:${!!process.env.ELEVENLABS_VOICE_ID})`);
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
  const rawUrl = (process.env.APP_URL || railwayDomain || "https://kamlifecoach.co.za").replace(/\/$/, "");
  const appUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const appUrlIsHttps = appUrl.startsWith("https://");
  log(`APP_URL (raw)         : ${process.env.APP_URL || "(unset)"}`);
  log(`RAILWAY_PUBLIC_DOMAIN : ${process.env.RAILWAY_PUBLIC_DOMAIN || "(unset)"}`);
  log(`Resolved media base   : ${appUrl}  (https: ${appUrlIsHttps})`);
  if (!appUrlIsHttps) log("  ⚠️  Not HTTPS — Twilio gets no media URL, so recaps go out as TEXT only.");

  // ── 2. Quota ──────────────────────────────────────────────────────────────
  const quota = await getElevenLabsQuota();
  if (quota) {
    const pct = quota.limit ? Math.round((quota.used / quota.limit) * 100) : 0;
    log(`\nElevenLabs quota      : ${quota.used.toLocaleString()} / ${quota.limit.toLocaleString()} chars (${pct}%)`);
    if (quota.used >= quota.limit) log("  ❌ OUT OF CREDITS — this alone stops every voice note. Top up / upgrade ElevenLabs.");
  } else {
    log(`\nElevenLabs quota      : could not fetch (bad key, or your plan has API access disabled)`);
  }

  // ── 3. Text-to-speech ─────────────────────────────────────────────────────
  log("\nCalling ElevenLabs textToSpeech()...");
  const audio = await textToSpeech("Sharp. Coach K here. This is your voice note delivery test.");
  if (!audio) {
    log("❌ textToSpeech returned NULL — see the [ELEVENLABS] error logged just above.");
    log("   That is why recaps arrive as text, not voice. Fix the ElevenLabs side, then re-run.");
    await pool.end();
    process.exit(1);
  }
  log(`✅ TTS OK — ${audio.length.toLocaleString()} bytes of MP3.`);

  // ── 4. Store + self-fetch the public audio URL (what Twilio will see) ──────
  const [u] = (await pool.query<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`)).rows;
  if (!u) { log("\nNo users in DB — cannot test the audio route. Stopping."); await pool.end(); process.exit(1); }

  const { rows: recRows } = await pool.query<{ id: string }>(
    `INSERT INTO voice_recap_logs (user_id, week_start, message_text, audio_base64, content_type)
     VALUES ($1, '1970-01-01', 'diagnostic', $2, 'audio/mpeg')
     ON CONFLICT (user_id, week_start) DO UPDATE SET audio_base64 = EXCLUDED.audio_base64
     RETURNING id`,
    [u.id, audio.toString("base64")]
  );
  const recapId = recRows[0].id;
  const mediaUrl = `${appUrl}/api/voice-recap/${recapId}/audio`;
  log(`\nMedia URL             : ${mediaUrl}`);

  log("Self-fetching that URL...");
  try {
    const r = await fetch(mediaUrl);
    const ct = r.headers.get("content-type") || "(none)";
    const body = await r.arrayBuffer();
    log(`  HTTP ${r.status} | content-type: ${ct} | ${body.byteLength.toLocaleString()} bytes`);
    if (r.status !== 200) log("  ❌ Not 200 — APP_URL points somewhere that can't serve this. Twilio will fail to fetch it.");
    else if (!ct.startsWith("audio/")) log(`  ❌ Wrong content-type (${ct}). Twilio needs audio/*. APP_URL is likely pointing at the wrong site (returning HTML).`);
    else log("  ✅ Serves real audio. Twilio should be able to fetch it.");
  } catch (e: any) {
    log(`  ❌ Fetch threw: ${e.message} — the resolved APP_URL is not reachable from the public internet.`);
  }

  // ── 5. Real Twilio send + delivery-status poll ────────────────────────────
  const coachRaw = (process.env.COACH_ALERT_PHONE || "").replace(/^whatsapp:/, "").trim();
  const fromNum = process.env.TWILIO_WHATSAPP_NUMBER ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}` : "";
  if (!coachRaw || !fromNum) {
    log(`\nSkipping live send — need COACH_ALERT_PHONE (${coachRaw || "unset"}) and TWILIO_WHATSAPP_NUMBER (${fromNum ? "set" : "unset"}).`);
  } else {
    const to = `whatsapp:${coachRaw}`;
    log(`\nSending a REAL test voice note: ${fromNum} → ${to}`);
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    try {
      const msg = await client.messages.create({ from: fromNum, to, body: "🎧 Voice note delivery test — Coach K", mediaUrl: [mediaUrl] });
      log(`  Created SID ${msg.sid} | initial status: ${msg.status}`);
      log("  Polling Twilio for delivery status...");
      let final = msg.status;
      for (let i = 0; i < 8; i++) {
        await sleep(3000);
        const m = await client.messages(msg.sid).fetch();
        final = m.status;
        const errPart = m.errorCode ? ` | errorCode=${m.errorCode} (${m.errorMessage || ""})` : "";
        log(`    [${(i + 1) * 3}s] status: ${m.status}${errPart}`);
        if (["delivered", "read", "failed", "undelivered"].includes(m.status)) break;
      }
      log("");
      if (final === "failed" || final === "undelivered") {
        log("❌ Twilio could NOT deliver the media. The errorCode above is the root cause:");
        log("   11200 / 11750  → Twilio couldn't fetch the media URL (APP_URL wrong/unreachable, or route 404).");
        log("   12300          → media content-type not supported by WhatsApp.");
        log("   63016 / 63005  → outside the 24h WhatsApp window — message the bot from your phone, then re-run.");
      } else {
        log(`✅ Twilio accepted it (status: ${final}). Check WhatsApp — the voice note should arrive.`);
        log("   If it lands here but NOT in the weekly recap, the path is fine and the original miss was credits/transient.");
      }
    } catch (e: any) {
      log(`  ❌ messages.create threw: ${e.code || ""} ${e.message}`);
    }
  }

  // ── 6. Cleanup ────────────────────────────────────────────────────────────
  await pool.query(`DELETE FROM voice_recap_logs WHERE week_start = '1970-01-01'`);
  log("\n=== DONE ===\n");
  await pool.end();
  process.exit(0);
}

main().catch((e) => { console.error("diagnose-voice failed:", e); process.exit(1); });
