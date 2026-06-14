/**
 * ElevenLabs text-to-speech integration.
 * Uses the coach's cloned voice to generate personalized audio messages.
 *
 * Required env vars:
 *   ELEVENLABS_API_KEY   — from elevenlabs.io → Profile → API Key
 *   ELEVENLABS_VOICE_ID  — from elevenlabs.io → Voices → Coach K → Voice ID
 */

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

export function isElevenLabsConfigured(): boolean {
  return !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
}

/**
 * Convert text to speech using the coach's cloned voice.
 * Returns audio as a Buffer (MP3), or null if ElevenLabs is not configured / fails.
 */
export async function textToSpeech(text: string): Promise<Buffer | null> {
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
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.85,
          style: 0.2,
          use_speaker_boost: true,
        },
      }),
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
    });
    if (!res.ok) return null;
    const data = await res.json() as { character_count: number; character_limit: number };
    return { used: data.character_count, limit: data.character_limit };
  } catch {
    return null;
  }
}
