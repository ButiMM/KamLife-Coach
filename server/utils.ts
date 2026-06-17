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
// Handles: "yesterday", "last night", "this morning", "earlier", "2 days ago",
// day-of-week names ("Saturday", "on Sunday"), and time-of-day hints within those.
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

  // Day-of-week references: "on Saturday", "had this Saturday", "Sunday morning", etc.
  // Maps to the most recent past occurrence of that day (never future).
  const DOW_NAMES_MAP: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  const dowMatch = m.match(/\b(on\s+)?(last\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (dowMatch) {
    const targetDow = DOW_NAMES_MAP[dowMatch[3]];
    const nowSASTDate = new Date(nowSAST);
    const currentDow = nowSASTDate.getUTCDay();
    let daysBack = (currentDow - targetDow + 7) % 7;
    if (daysBack === 0) daysBack = 7; // same day name = last week's occurrence
    const mealDate = new Date(Date.now() - daysBack * 86_400_000);

    // Try to extract an explicit HH:MM time from the message
    const timeMatch = m.match(/\b(\d{1,2})[:.h](\d{2})\b/);
    if (timeMatch) {
      const hour = parseInt(timeMatch[1]);
      const min = parseInt(timeMatch[2]);
      // Convert SAST (UTC+2) to UTC for storage
      mealDate.setUTCHours(Math.max(0, hour - 2), min, 0, 0);
    } else if (/\b(morning|breakfast|after gym)\b/.test(m)) {
      mealDate.setUTCHours(6, 0, 0, 0); // 8am SAST
    } else if (/\b(lunch|midday|afternoon|around noon)\b/.test(m)) {
      mealDate.setUTCHours(10, 0, 0, 0); // noon SAST
    } else if (/\b(night|dinner|supper|evening)\b/.test(m)) {
      mealDate.setUTCHours(18, 0, 0, 0); // 8pm SAST
    } else {
      mealDate.setUTCHours(10, 0, 0, 0); // default noon SAST
    }
    return mealDate;
  }

  // "this morning" / "for breakfast" early in message → today at 8am SAST (only if current SAST time is past 11am)
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

// Returns true if the message contains a clear retroactive date reference (not today).
export function isRetroactiveMeal(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(yesterday|last night|days? ago|on\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|last\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|had this (saturday|sunday|monday|tuesday|wednesday|thursday|friday)|saturday|sunday)\b/.test(m);
}

// Future-intent / hypothetical detector — stops PLANNED actions ("I'll walk 10k
// tomorrow", "going to run 5km", "want to do yoga") from being logged as if already
// done. Used by the step and cardio loggers, which match the activity + number
// regardless of tense. Note: i'll requires the apostrophe so "ill"/"I feel ill"
// does not match; voice transcripts that drop it are covered by tomorrow/going to.
export function isFutureIntent(message: string): boolean {
  const m = message.toLowerCase();
  return /\bi'll\b|\bi\s+will\b|\b(?:wanna|gonna)\b|\bgoing\s+to\b|\bplann?ing\s+to\b|\bplan\s+to\b|\babout\s+to\b|\bhoping\s+to\b|\bwant\s+to\b|\btomorrow\b|\bnext\s+week\b|\blater\s+today\b/i.test(m);
}

// Deterministic backstop against the GPT food estimator FABRICATING a composite
// item. Demonstrated production failure: a client listed "rice / chicken livers /
// mixed veggies" as separate items and the model logged a phantom "rice and chicken
// (home cooked)" — inventing a second protein and inflating the meal's calories and
// protein, then declaring the protein target hit. A prompt rule against this already
// exists and the model ignores it, so this does NOT trust the model — it returns the
// names of any fabricated composites so the caller can drop them rather than log a
// wrong number.
//
// Fires ONLY when BOTH hold (keeps false positives near zero):
//   1. The client's message is an ENUMERATED LIST (foods one-per-line / comma /
//      slash separated, mostly short segments) — never a flowing sentence, where a
//      model legitimately joins "rice with grilled chicken".
//   2. A returned item NAME joins two foods (and / with / & / +) AND that joined
//      phrase is NOT what the client wrote — joiners are normalised, so a faithful
//      "mac n cheese" → "mac and cheese" is kept; only invented merges are dropped.
export function findFabricatedComposites(
  userMessage: string,
  foods: Array<{ name: string }>,
): string[] {
  if (!userMessage || !foods || foods.length === 0) return [];

  const segs = userMessage
    .split(/[\n\/;•·]|,(?!\d)/) // split on line/slash/semicolon/bullet/comma (not "1,000")
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !/^(breakfast|lunch|dinner|supper|snack|brunch)\s*:?\s*$/i.test(s));
  if (segs.length < 2) return []; // not an enumerated list — leave flowing prose alone
  const shortShare = segs.filter(s => s.split(/\s+/).length <= 4).length / segs.length;
  if (shortShare < 0.6) return [];

  // Canonicalise so every food-joiner becomes "and" in both strings — a client's
  // "mac n cheese" / "eggs & bacon" then matches the model's "mac and cheese".
  const canon = (s: string) => s.toLowerCase()
    .replace(/[&+]/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(?:and|with|n)\b/g, "and")
    .replace(/\s+/g, " ")
    .trim();
  const hay = canon(userMessage);

  const fabricated: string[] = [];
  for (const f of foods) {
    const rawName = (f.name || "").replace(/\([^)]*\)/g, " "); // drop "(home cooked)" etc.
    const hasJoiner = /\b(?:and|with|n)\b/i.test(rawName) || /[&+]/.test(rawName);
    if (!hasJoiner) continue;
    const core = canon(rawName);
    if (core.split(" ").length < 3) continue; // need a real "X and Y" composite
    if (hay.includes(core)) continue;          // client wrote it verbatim — trust it
    fabricated.push(f.name);
  }
  return fabricated;
}

// Returns a human-readable label for the date, e.g. "Saturday" or "yesterday".
export function mealDateLabel(date: Date): string {
  const nowSAST = new Date(Date.now() + 2 * 3_600_000);
  const mealSAST = new Date(date.getTime() + 2 * 3_600_000);
  const diffDays = Math.round((nowSAST.setUTCHours(0,0,0,0) - mealSAST.setUTCHours(0,0,0,0)) / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  return days[mealSAST.getUTCDay()] || `${diffDays} days ago`;
}

export function getDisplayName(user: any): string {
  if (!user.name || user.name.length < 2 || INVALID_NAMES.has((user.name || "").toUpperCase())) return "";
  return user.name;
}

// Per-user GPT rate limiter — sliding window, 10 calls per 60 seconds
const gptCallTimestamps = new Map<string, number[]>();

// Returns a varied SA protein suggestion based on budget tier, dietary restrictions, and day of week.
// Call with the full user/client object — fields are optional so callers without the full object still work.
type ProteinUser = { budgetLevel?: string | null; weeklyFoodBudget?: string | null; profileNotes?: string | null };
type _ProteinOption = { label: string; portion: string };

const _PROTEIN_POOLS: Record<string, _ProteinOption[]> = {
  low: [
    { label: "eggs", portion: "3 boiled eggs" },
    { label: "tinned tuna", portion: "1 tin tuna" },
    { label: "sugar beans", portion: "1 cup cooked beans" },
    { label: "chicken thighs", portion: "150g chicken" },
  ],
  medium: [
    { label: "chicken thighs", portion: "150g chicken" },
    { label: "eggs", portion: "3 boiled eggs" },
    { label: "tinned tuna", portion: "1 tin tuna" },
    { label: "beef mince", portion: "100g mince" },
    { label: "sugar beans", portion: "1 cup beans" },
  ],
  high: [
    { label: "chicken breast", portion: "150g chicken breast" },
    { label: "eggs", portion: "3 boiled eggs" },
    { label: "beef mince", portion: "150g mince" },
    { label: "cottage cheese", portion: "200g cottage cheese" },
    { label: "tinned tuna", portion: "1 tin tuna" },
  ],
};

// Vegetarian pools (no meat, no fish — eggs and dairy OK)
const _VEG_PROTEIN_POOLS: Record<string, _ProteinOption[]> = {
  low:    [{ label: "eggs", portion: "4 boiled eggs" }, { label: "cottage cheese", portion: "200g cottage cheese" }, { label: "sugar beans", portion: "1 cup cooked beans" }],
  medium: [{ label: "eggs", portion: "4 boiled eggs" }, { label: "cottage cheese", portion: "200g cottage cheese" }, { label: "sugar beans", portion: "1 cup beans" }, { label: "tofu", portion: "150g firm tofu" }],
  high:   [{ label: "cottage cheese", portion: "200g cottage cheese" }, { label: "eggs", portion: "4 boiled eggs" }, { label: "firm tofu", portion: "150g tofu" }, { label: "Greek yoghurt", portion: "200g Greek yoghurt" }],
};

// Vegan pools (no animal products — plant only)
const _VEGAN_PROTEIN_POOLS: Record<string, _ProteinOption[]> = {
  low:    [{ label: "sugar beans", portion: "1 cup cooked beans" }, { label: "cooked lentils", portion: "1 cup cooked lentils" }, { label: "soya mince", portion: "50g dry soya mince" }],
  medium: [{ label: "firm tofu", portion: "150g tofu" }, { label: "cooked lentils", portion: "1 cup cooked lentils" }, { label: "sugar beans", portion: "1 cup beans" }, { label: "soya mince", portion: "80g dry soya mince" }],
  high:   [{ label: "firm tofu", portion: "200g tofu" }, { label: "cooked lentils", portion: "1 cup cooked lentils" }, { label: "soya mince", portion: "100g dry soya mince" }, { label: "sugar beans", portion: "1 cup beans" }],
};

function _budgetTier(user: ProteinUser): "low" | "medium" | "high" {
  const b = (user.budgetLevel || "").toLowerCase();
  const wfb = user.weeklyFoodBudget || "";
  if (b === "high" || wfb.includes("600") || wfb.includes("woolworths")) return "high";
  if (b === "medium" || wfb.includes("300")) return "medium";
  return "low";
}

function _getPool(user: ProteinUser): _ProteinOption[] {
  const notes = (user.profileNotes || "").toLowerCase();
  const tier = _budgetTier(user);
  if (notes.includes("diet:vegan")) return _VEGAN_PROTEIN_POOLS[tier];
  if (notes.includes("diet:vegetarian")) return _VEG_PROTEIN_POOLS[tier];
  const noFish = /fish allergy/i.test(user.profileNotes || "") || notes.includes("diet:vegetarian");
  let pool = _PROTEIN_POOLS[tier];
  if (noFish) pool = pool.filter(o => !o.label.includes("tuna"));
  return pool.length ? pool : _PROTEIN_POOLS.low.filter(o => !o.label.includes("tuna"));
}

export function proteinHint(user: ProteinUser, gap: number): string {
  const dow = new Date(Date.now() + 2 * 3_600_000).getUTCDay(); // 0–6 SAST
  const pool = _getPool(user);
  const primary = pool[dow % pool.length];
  const secondary = pool[(dow + 2) % pool.length];
  if (gap > 50) {
    return `Add ${primary.label} and ${secondary.label} to every meal today.`;
  }
  return `${primary.portion} today closes that gap.`;
}

// Returns two varied protein label strings (comma-separated) for use in coaching messages.
export function proteinOptions(user: ProteinUser): string {
  const dow = new Date(Date.now() + 2 * 3_600_000).getUTCDay();
  const pool = _getPool(user);
  const a = pool[dow % pool.length].label;
  const b = pool[(dow + 1) % pool.length].label;
  const c = pool[(dow + 3) % pool.length].label;
  return `${a}, ${b}, or ${c}`;
}

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
