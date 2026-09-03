/**
 * VOICE LENGTH LIMIT — the guard that actually matches what we tell the client.
 *
 * (2026-07-28, from the CFO review: "an unbounded voice note is an unbounded bill.") The old
 * guard let through 16MB — roughly two hours of WhatsApp audio — while the refusal message said
 * "keep it under about 90 seconds". A limit the copy contradicts is not a limit; it is a
 * surprise waiting for the client who hits it and a cost nobody budgeted for.
 *
 * Voice is the primary input for a big part of this market, so the cap is generous: three
 * minutes. That is a long message from someone talking about their day, and it is still bounded.
 *
 * Pure — no DB, no model. Unit-tested.
 */

/** Past this, a voice note stops being a message and starts being a podcast. */
export const VOICE_MAX_SECONDS = 180;

// Repeated transcription failures should stop consuming retries and offer a typed fallback.
// This is in-process only: it protects the media boundary without treating a delivery failure
// as client behaviour or persisting an inferred fact.
const voiceFailureMap = new Map<string, { count: number; lastAt: number }>();
const VOICE_FAILURE_RESET_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of voiceFailureMap.entries()) {
    if (now - val.lastAt > VOICE_FAILURE_RESET_MS) voiceFailureMap.delete(key);
  }
}, 15 * 60 * 1000);

export function bumpVoiceFailure(userId: string): number {
  const now = Date.now();
  const prev = voiceFailureMap.get(userId);
  const count = prev && (now - prev.lastAt) < VOICE_FAILURE_RESET_MS ? prev.count + 1 : 1;
  voiceFailureMap.set(userId, { count, lastAt: now });
  return count;
}

export function clearVoiceFailure(userId: string): void {
  voiceFailureMap.delete(userId);
}

// Rough bitrates by container (bits/sec). WhatsApp sends Opus in Ogg at ~16kbps; the others are
// only reached when a client forwards a file, so a conservative guess is fine — we only need the
// right order of magnitude to tell a 40-second note from a 20-minute one.
const BITRATE: Array<[RegExp, number]> = [
  [/ogg|opus|webm/i, 16_000],
  [/amr/i, 12_200],
  [/aac|mp4|m4a/i, 64_000],
  [/mpeg|mp3/i, 128_000],
  [/wav/i, 256_000],
];

/** Best-effort duration in seconds from the encoded size. Never throws. */
export function estimateVoiceSeconds(bytes: number, contentType = ""): number {
  const n = Number(bytes) || 0;
  if (n <= 0) return 0;
  const hit = BITRATE.find(([re]) => re.test(contentType));
  const bps = (hit ? hit[1] : 32_000) / 8;
  return n / bps;
}

export interface VoiceLimit { ok: boolean; seconds: number; reply?: string }

/**
 * Is this voice note within the cap? The refusal names the real limit and gives them the way
 * through — never a dead end, and never a number that contradicts the guard above it.
 */
export function checkVoiceLength(bytes: number, contentType = "", maxSeconds = VOICE_MAX_SECONDS): VoiceLimit {
  const seconds = estimateVoiceSeconds(bytes, contentType);
  if (seconds <= maxSeconds) return { ok: true, seconds };
  return {
    ok: false,
    seconds,
    reply: `That voice note is longer than ${Math.round(maxSeconds / 60)} minutes — too long for me to handle in one go.\n\nSend me the main part in a shorter note, or just type it. Either way I'll pick it up from there.`,
  };
}
