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
import { textToSpeech as elevenLabsTTS, isElevenLabsConfigured } from "./elevenlabs";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-missing-key",
});

export const VOICE_DIR = join(process.cwd(), "tmp", "voice");

// Ensure voice directory exists on startup
mkdir(VOICE_DIR, { recursive: true }).catch(() => {});

/**
 * Generate a voice note from text.
 * Uses ElevenLabs cloned voice (Coach K) when configured; falls back to OpenAI TTS.
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

    // Use ElevenLabs cloned Coach K voice when configured
    if (isElevenLabsConfigured()) {
      const elevenBuf = await elevenLabsTTS(text);
      if (elevenBuf) {
        await writeFile(filePath, elevenBuf);
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
