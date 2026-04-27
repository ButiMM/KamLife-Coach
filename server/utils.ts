const INVALID_NAMES = new Set(["HI", "HEY", "HELLO", "YES", "NO", "OK", "OKAY", "MENU", "HELP", "DONE", "USER", "THERE"]);

export function getDisplayName(user: any): string {
  if (!user.name || user.name.length < 2 || INVALID_NAMES.has((user.name || "").toUpperCase())) return "";
  return user.name;
}

// Per-user GPT rate limiter — sliding window, 10 calls per 60 seconds
const gptCallTimestamps = new Map<string, number[]>();

export function checkGptRateLimit(userId: string, maxCalls = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const timestamps = (gptCallTimestamps.get(userId) || []).filter(t => now - t < windowMs);
  if (timestamps.length >= maxCalls) {
    return false;
  }
  timestamps.push(now);
  gptCallTimestamps.set(userId, timestamps);
  return true;
}

// Twilio circuit breaker — opens after 5 consecutive failures, resets after 60s
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_RESET_MS = 60_000;

let twilioFailures = 0;
let twilioOpenedAt: number | null = null;

export function isTwilioCircuitOpen(): boolean {
  if (twilioOpenedAt !== null && Date.now() - twilioOpenedAt > CIRCUIT_RESET_MS) {
    twilioFailures = 0;
    twilioOpenedAt = null;
    console.log("[CIRCUIT] Twilio circuit reset — half-open, allowing next attempt");
  }
  return twilioOpenedAt !== null;
}

export function recordTwilioSuccess(): void {
  twilioFailures = 0;
  twilioOpenedAt = null;
}

export function recordTwilioFailure(): void {
  twilioFailures++;
  if (twilioFailures >= CIRCUIT_FAILURE_THRESHOLD && twilioOpenedAt === null) {
    twilioOpenedAt = Date.now();
    console.error(`[CIRCUIT] Twilio circuit OPEN after ${twilioFailures} consecutive failures — suppressing sends for ${CIRCUIT_RESET_MS / 1000}s`);
  }
}
