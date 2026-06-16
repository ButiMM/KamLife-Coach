/**
 * ElevenLabs text-to-speech integration.
 * Uses the coach's cloned voice to generate personalized audio messages.
 *
 * Required env vars:
 *   ELEVENLABS_API_KEY   — from elevenlabs.io → Profile → API Key
 *   ELEVENLABS_VOICE_ID  — from elevenlabs.io → Voices → Coach K → Voice ID
 */

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

/**
 * Emotional register for a spoken note. Drives the voice delivery so a comeback
 * after a lapse does not sound the same as a flat-out celebration.
 */
export type VoiceEmotion = "celebratory" | "comeback" | "firm" | "warm";

// Per-register voice settings. The old flat default (stability 0.5 / style 0.2)
// read like a script being recited. These are tuned for spoken delivery: lower
// stability + higher style give the cloned voice emotional range and flow.
// "firm" is the deliberate exception — it stays steady and weighty on purpose,
// for accountability rather than celebration.
const VOICE_SETTINGS: Record<VoiceEmotion, {
  stability: number; similarity_boost: number; style: number; use_speaker_boost: boolean;
}> = {
  celebratory: { stability: 0.35, similarity_boost: 0.85, style: 0.55, use_speaker_boost: true },
  comeback:    { stability: 0.45, similarity_boost: 0.88, style: 0.40, use_speaker_boost: true },
  firm:        { stability: 0.60, similarity_boost: 0.90, style: 0.20, use_speaker_boost: true },
  warm:        { stability: 0.40, similarity_boost: 0.85, style: 0.45, use_speaker_boost: true },
};

// Spoken delivery hates markdown and emoji — asterisks get read as "asterisk",
// emoji get mangled or skipped. Strip them before synthesis so the read is clean.
function sanitizeForSpeech(text: string): string {
  return text
    .replace(/[*_~`#]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function isElevenLabsConfigured(): boolean {
  return !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
}

/**
 * Convert text to speech using the coach's cloned voice.
 * `emotion` selects the delivery register (default "warm").
 * Returns audio as a Buffer (MP3), or null if ElevenLabs is not configured / fails.
 */
export async function textToSpeech(text: string, emotion: VoiceEmotion = "warm"): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    console.warn("[ELEVENLABS] Not configured — set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID");
    return null;
  }

  try {
    const response = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text: sanitizeForSpeech(text),
        model_id: "eleven_multilingual_v2",
        voice_settings: VOICE_SETTINGS[emotion] || VOICE_SETTINGS.warm,
      }),
      // Node's global fetch has no default timeout — a stalled TLS connection would
      // hang this voice job forever and wedge the rest of the batch. Cap it.
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`[ELEVENLABS] API error ${response.status} for voice ${voiceId}:`, err.slice(0, 400));
      throw new Error(`ElevenLabs ${response.status}: ${err.slice(0, 200)}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (e: any) {
    console.error("[ELEVENLABS] Request failed:", e.message);
    return null;
  }
}

/**
 * Transcribe audio using ElevenLabs Scribe v1.
 * Better WER than Whisper on SA languages (Afrikaans, Zulu, Xhosa, etc.).
 * Returns the transcribed text, or null if not configured / fails.
 */
export async function scribeTranscribe(
  audioBuffer: ArrayBuffer,
  ext: string,
  langHint?: string,
): Promise<string | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  try {
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: `audio/${ext}` });
    formData.append("file", blob, `audio.${ext}`);
    formData.append("model_id", "scribe_v1");
    if (langHint) formData.append("language_code", langHint);

    const response = await fetch(`${ELEVENLABS_BASE}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`[ELEVENLABS] Scribe error ${response.status}:`, err.slice(0, 200));
      return null;
    }

    const data = await response.json() as { text?: string };
    return data.text?.trim() || null;
  } catch (e: any) {
    console.error("[ELEVENLABS] Scribe failed:", e.message);
    return null;
  }
}

/**
 * Get remaining character quota for this billing period.
 */
export async function getElevenLabsQuota(): Promise<{ used: number; limit: number } | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`${ELEVENLABS_BASE}/user/subscription`, {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { character_count: number; character_limit: number };
    return { used: data.character_count, limit: data.character_limit };
  } catch {
    return null;
  }
}
