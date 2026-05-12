// ============================================================
// COACH K TTS — voice note generation for milestone moments
// Generates MP3 via OpenAI TTS, serves via Express at /voice/:id.mp3
// Requires APP_BASE_URL env var to be set (e.g. https://yourapp.railway.app)
// ============================================================

import OpenAI from "openai";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-missing-key",
});

export const VOICE_DIR = join(process.cwd(), "tmp", "voice");

// Ensure voice directory exists on startup
mkdir(VOICE_DIR, { recursive: true }).catch(() => {});

/**
 * Generate a voice note from text.
 * Returns the public HTTPS URL for the audio file, or null if APP_BASE_URL is not set.
 */
export async function generateVoiceNote(text: string): Promise<string | null> {
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

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: "onyx",          // Deep, warm, authoritative voice
      input: text,
      response_format: "mp3",
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    await writeFile(filePath, buffer);

    const url = `${appUrl}/voice/${id}.mp3`;
    console.log(`[TTS] Generated voice note: ${url}`);
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
