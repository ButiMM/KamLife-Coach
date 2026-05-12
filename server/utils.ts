const INVALID_NAMES = new Set(["HI", "HEY", "HELLO", "YES", "NO", "OK", "OKAY", "MENU", "HELP", "DONE", "USER", "THERE"]);

export function sastToday(): string {
  const sast = new Date(Date.now() + 2 * 3_600_000);
  return sast.toISOString().slice(0, 10);
}

// SAST = UTC+2, no DST. Returns the UTC Date representing SAST midnight of the given date
// (or today if omitted). Use this everywhere instead of new Date(); setHours(0,0,0,0) which
// resolves to UTC midnight = 2am SAST, causing meals logged at midnight–2am to be misattributed.
export function sastDayStart(date?: Date): Date {
  const SAST_OFFSET = 2 * 3_600_000;
  const base = date ? date.getTime() : Date.now();
  const inSAST = new Date(base + SAST_OFFSET);
  const sastDateStr = inSAST.toISOString().slice(0, 10); // "YYYY-MM-DD" in SAST
  return new Date(`${sastDateStr}T00:00:00+02:00`); // back to real UTC
}

// Parse time references from food log messages and return the appropriate loggedAt date.
// Handles: "yesterday", "last night", "this morning", "earlier", "2 days ago"
// Returns a Date set to a reasonable SAST-anchored time for that meal.
export function parseMealDate(message: string): Date {
  const m = message.toLowerCase();
  const nowSAST = Date.now() + 2 * 3_600_000; // ms in SAST equivalent

  // "2 days ago", "two days ago"
  const daysAgoMatch = m.match(/\b(\d+|one|two|three)\s+days?\s+ago\b/);
  if (daysAgoMatch) {
    const n = { one: 1, two: 2, three: 3 }[daysAgoMatch[1] as string] || parseInt(daysAgoMatch[1]);
    return new Date(Date.now() - n * 86_400_000);
  }

  // "last night" → yesterday at 8pm SAST
  if (/\b(last night|tonight|yesterday.?night|previous night)\b/.test(m)) {
    const d = new Date(Date.now() - 86_400_000);
    d.setUTCHours(18, 0, 0, 0); // 8pm SAST = 6pm UTC
    return d;
  }

  // "yesterday" → yesterday at noon SAST
  if (/\byesterday\b/.test(m)) {
    const d = new Date(Date.now() - 86_400_000);
    d.setUTCHours(10, 0, 0, 0); // noon SAST = 10am UTC
    return d;
  }

  // "this morning" / "for breakfast" → today at 8am SAST (only if current SAST time is past 11am)
  const sastHour = new Date(nowSAST).getUTCHours();
  if (/\b(this morning|had.*breakfast|breakfast.*was|morning meal)\b/.test(m) && sastHour >= 11) {
    const d = new Date();
    d.setUTCHours(6, 0, 0, 0); // 8am SAST = 6am UTC
    return d;
  }

  // "earlier today" / "earlier" → 3 hours ago
  if (/\b(earlier today|earlier|a few hours ago|hours ago)\b/.test(m)) {
    return new Date(Date.now() - 3 * 3_600_000);
  }

  return new Date(); // default to now
}

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
