// ============================================================
// COACH K TTS — voice note generation for milestone moments
// Uses ElevenLabs cloned voice (Coach K) when configured,
// falls back to OpenAI TTS (onyx). Serves via Express at /voice/:id.mp3
// Requires APP_BASE_URL env var to be set (e.g. https://yourapp.railway.app)
// ============================================================

import OpenAI from "openai";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { textToSpeech as elevenLabsTTS, isElevenLabsConfigured, type VoiceEmotion } from "./elevenlabs";
import { recordServiceCost, voiceCostUsd } from "./cost-tracking";
import { allowExpensiveOp } from "./usage-governor";
import { wantsVoiceReplies, worthSpeaking, speechText } from "./numbers-mode";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-missing-key",
});

export const VOICE_DIR = join(process.cwd(), "tmp", "voice");

// Ensure voice directory exists on startup
mkdir(VOICE_DIR, { recursive: true }).catch(() => {});

/**
 * Generate a voice note from text.
 * Uses ElevenLabs cloned voice (Coach K) when configured; falls back to OpenAI TTS.
 * `emotion` selects the ElevenLabs delivery register (default "warm").
 * Returns the public HTTPS URL for the audio file, or null if APP_BASE_URL is not set.
 */
export async function generateVoiceNote(text: string, emotion: VoiceEmotion = "warm", userId?: string | null): Promise<string | null> {
  // COST CIRCUIT-BREAKER (external review Q5): TTS is already reserved for milestone/emotional
  // moments (never routine logs), but ElevenLabs is the one line item that can spike the R199
  // margin. TTS=off kills all voice generation instantly from Railway — replies fall back to
  // text, nothing breaks — so a cost spike is a one-env-var fix, not a deploy.
  if (process.env.TTS === "off") { console.log("[TTS] disabled via killswitch (TTS=off) — text only"); return null; }
  // AUTOMATIC DAILY CAP: past today's voice budget → return null so the caller sends TEXT instead.
  // Protects margin against a runaway loop without a human watching; normal use never hits it.
  if (!(await allowExpensiveOp(userId, "voice"))) return null;
  let appUrl = (process.env.APP_BASE_URL || process.env.APP_URL || "").replace(/\/$/, "");
  if (!appUrl) {
    console.warn("[TTS] APP_BASE_URL / APP_URL not set — voice notes disabled");
    return null;
  }
  if (!appUrl.startsWith("http")) appUrl = `https://${appUrl}`;

  try {
    await mkdir(VOICE_DIR, { recursive: true });
    const id = randomUUID();
    const filePath = join(VOICE_DIR, `${id}.mp3`);

    // Use ElevenLabs cloned Coach K voice when configured
    if (isElevenLabsConfigured()) {
      const elevenBuf = await elevenLabsTTS(text, emotion);
      if (elevenBuf) {
        await writeFile(filePath, elevenBuf);
        recordServiceCost({ userId, feature: "voice", costUsd: voiceCostUsd(text.length) }); // whale tracking
        const url = `${appUrl}/voice/${id}.mp3`;
        console.log(`[TTS] Generated voice note (ElevenLabs Coach K): ${url}`);
        return url;
      }
      console.warn("[TTS] ElevenLabs failed — falling back to OpenAI TTS");
    }

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: "onyx",
      input: text,
      response_format: "mp3",
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    await writeFile(filePath, buffer);

    const url = `${appUrl}/voice/${id}.mp3`;
    console.log(`[TTS] Generated voice note (OpenAI): ${url}`);
    return url;
  } catch (err) {
    console.error("[TTS] Generation failed:", err);
    return null;
  }
}

export function getVoiceFilePath(id: string): string {
  return join(VOICE_DIR, `${id}.mp3`);
}

export function voiceFileExists(id: string): boolean {
  return existsSync(getVoiceFilePath(id));
}

/**
 * VOICE REPLY FOR AN OPTED-IN CLIENT (2026-08-03) — the one call site that turns a
 * normal coaching reply into audio as well as text.
 *
 * Deliberately ordered cheapest-check-first: worthSpeaking() is a pure string test and
 * rejects the short acknowledgements that make up most replies, so the DB is never
 * touched for a "Noted 👌". Only a substantial reply costs a lookup, and only an
 * opted-in client costs a generation. Every existing brake still applies underneath —
 * TTS=off, the daily voice budget, the ElevenLabs→OpenAI fallback.
 *
 * Returns null for everyone else, and on any failure. The caller sends the text
 * regardless: audio is additive, never a substitute. A silent TTS failure must never
 * become a silent coach.
 */
export async function voiceReplyFor(phone: string, text: string): Promise<string | null> {
  try {
    if (!worthSpeaking(text)) return null;
    const { db } = await import("./db");
    const { users } = await import("../shared/schema");
    const { eq } = await import("drizzle-orm");
    const [u] = await db.select({ id: users.id, profileNotes: users.profileNotes })
      .from(users).where(eq(users.phoneNumber, phone)).limit(1);
    if (!u || !wantsVoiceReplies(u)) return null;
    // The voice says the headline only. Reading a whole coaching message aloud costs twice
    // and cannot be scrolled back through; the text underneath carries the detail.
    const { firstSentence } = await import("./reply-hygiene");
    return await generateVoiceNote(firstSentence(speechText(text)), "warm", u.id);
  } catch (e) {
    console.warn("[TTS] voice reply skipped:", (e as Error)?.message || e);
    return null;
  }
}
