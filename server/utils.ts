const INVALID_NAMES = new Set(["HI", "HEY", "HELLO", "YES", "NO", "OK", "OKAY", "MENU", "HELP", "DONE", "USER", "THERE"]);


// Normalise any SA phone format to bare international digits, so a number entered in
// BETA_TESTERS ("0682002798", "+27 68 200 2798", "whatsapp:+27682002798") compares
// equal to the digits-only MSISDN we get off a WhatsApp webhook ("27682002798").
// Returns "" for empty/junk input so an empty allowlist entry never matches.
export function normaliseMsisdn(raw: string): string {
  let d = (raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10 && d.startsWith("0")) d = "27" + d.slice(1); // SA local 0XX… → 27XX…
  else if (d.length === 9) d = "27" + d;                            // bare 9-digit local, no leading 0
  return d;
}

// Twilio's Content API wants template variables as a JSON STRING keyed "1","2",…
// (matching the {{1}},{{2}} placeholders in the approved template). Returns undefined
// when there are no usable variables, so we never send an empty "{}" — which some
// template configs reject — and never send null/undefined values.
export function buildContentVariables(vars?: Record<string, string | number | null | undefined>): string | undefined {
  if (!vars) return undefined;
  const entries = Object.entries(vars).filter(([, v]) => v !== undefined && v !== null && String(v) !== "");
  if (entries.length === 0) return undefined;
  return JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k, String(v)])));
}

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

// Deterministic meal slot from the SAST hour — used to label a food log when the client
// doesn't say which meal it is. Total over all 24h (no gaps): the 15:00–17:00 and
// 22:00–05:00 windows with no obvious meal fall to "snack". Preserves the existing
// breakfast/lunch/dinner windows exactly — only the two former null gaps become "snack".
export function slotFromSastHour(date: Date = new Date()): "breakfast" | "lunch" | "dinner" | "snack" {
  const h = new Date(date.getTime() + 2 * 3_600_000).getUTCHours();
  if (h >= 5 && h < 11) return "breakfast";
  if (h >= 11 && h < 15) return "lunch";
  if (h >= 17 && h < 22) return "dinner";
  return "snack";
}

// Parse time references from food log messages and return the appropriate loggedAt date.
// Handles: "yesterday", "last night", "this morning", "earlier", "2 days ago",
// day-of-week names ("Saturday", "on Sunday"), and time-of-day hints within those.
// Returns a Date set to a reasonable SAST-anchored time for that meal.
export function parseMealDate(message: string): Date {
  const m = message.toLowerCase();
  const nowSAST = Date.now() + 2 * 3_600_000; // ms in SAST equivalent

  // Relative days are anchored to the SAST calendar day, not UTC-now. The old
  // "now minus 24h" versions were wrong in the 00:00–02:00 SAST window: at 01:25
  // SAST, "yesterday" resolved to TWO SAST days back, logging the meal to the
  // wrong day and corrupting totals/streaks (caught live by routing-audit,
  // 2026-07-06 23:25 UTC). sastDayStart() is the UTC instant of SAST midnight.
  const todayStartSAST = sastDayStart();

  // "2 days ago", "two days ago" → noon SAST on that day
  const daysAgoMatch = m.match(/\b(\d+|one|two|three)\s+days?\s+ago\b/);
  if (daysAgoMatch) {
    const n = { one: 1, two: 2, three: 3 }[daysAgoMatch[1] as string] || parseInt(daysAgoMatch[1]);
    return new Date(todayStartSAST.getTime() - n * 86_400_000 + 12 * 3_600_000);
  }

  // "last night" → yesterday at 8pm SAST
  if (/\b(last night|tonight|yesterday.?night|previous night)\b/.test(m)) {
    return new Date(todayStartSAST.getTime() - 86_400_000 + 20 * 3_600_000);
  }

  // "yesterday" → yesterday at noon SAST
  if (/\byesterday\b/.test(m)) {
    return new Date(todayStartSAST.getTime() - 86_400_000 + 12 * 3_600_000);
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

  // "forgot to log dinner" / "missed logging lunch" with no explicit day: decide today vs
  // yesterday by whether the named meal's time has passed yet. Dinner asked in the morning =
  // yesterday's dinner; breakfast asked in the afternoon = today's (forgotten earlier today).
  if (/\b(forgot|missed|didn.?t|did\s*not|never)\b/.test(m)
      && /\b(log|logs|logg(?:ed|ing)|add|added|adding|track|tracked|tracking|record|recorded|enter|entered|capture)\b/.test(m)
      && !/\b(today|this\s+morning|this\s+afternoon|this\s+evening|tonight|just\s+now|now)\b/.test(m)) {
    const mealHour = /\b(breakfast|brekkie|morning)\b/.test(m) ? 8
      : /\b(lunch|midday|noon)\b/.test(m) ? 13
      : /\b(dinner|supper|evening|night)\b/.test(m) ? 19
      : null;
    if (mealHour !== null) {
      const base = sastHour < mealHour ? Date.now() - 86_400_000 : Date.now(); // not happened yet today → yesterday
      const d = new Date(base);
      d.setUTCHours(Math.max(0, mealHour - 2), 0, 0, 0); // mealHour SAST → UTC
      return d;
    }
  }

  return new Date(); // default to now
}

// Returns true if the message contains a clear retroactive date reference (not today).
export function isRetroactiveMeal(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(yesterday|last night|days? ago|on\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|last\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|had this (saturday|sunday|monday|tuesday|wednesday|thursday|friday)|saturday|sunday)\b/.test(m);
}

// Retro-date hallucination brake for the normalizer. The intent classifier
// (gpt-4o-mini) sometimes adds "yesterday" to a WORKOUT_LOG canonical when the
// client never said it — e.g. "Hack squat 25kg, 6 reps" → "workout done
// yesterday". That invented date makes the workout handler fire its retroactive
// branch and reply "already got yesterday's workout logged" instead of crediting
// today's session. This strips any retro-date token from `canonical` that does
// NOT appear in `original`, so a real "...yesterday" is preserved and an invented
// one is removed. Pure + unit-tested (production bug 2026-06-24).
const RETRO_DATE_RE = /\b(yesterday|last night|last\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d+\s+days?\s+ago)\b/gi;
export function stripInventedRetroDate(canonical: string, original: string): string {
  const orig = original.toLowerCase();
  // Only strip tokens the client did not actually write.
  const cleaned = canonical.replace(RETRO_DATE_RE, (match) =>
    orig.includes(match.toLowerCase()) ? match : "");
  return cleaned.replace(/\s{2,}/g, " ").trim();
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

// Canonical "is this phrased as a QUESTION?" check — the single source of truth a
// side-effect handler consults before it logs, flips training mode, removes a meal,
// charges, or dumps a workout/chart. Reinventing this per-handler is exactly how the
// guard drifts and a question slips through into an irreversible action, so new gates
// should call this rather than hand-rolling another regex.
// Deliberately CONSERVATIVE on leading words: it matches interrogatives and modals
// (what/why/how/where/which/who + should/can/is/are/do/does/will/would) but NOT
// past-tense statement leads (did/done/had/was/were/trained) — because "did legs
// yesterday", "was on the treadmill 30 min", "had chicken and rice" are LOGS, not
// questions. A trailing "?" anywhere always counts.
export function looksLikeQuestion(message: string): boolean {
  const t = (message || "").trim();
  if (t.includes("?")) return true;
  return /^(what|what.?s|whats|why|how|when|where|which|who|whose|can|could|should|shall|would|will|do|does|don.?t|doesn.?t|is|isn.?t|are|aren.?t|shouldn.?t)\b/i.test(t);
}

// Canonical "the activity was NOT actually done" check — the negation sibling of
// looksLikeQuestion, and the second guard every activity logger needs. A user saying
// "I couldn't run 5km", "missed my 5km", "didn't hit 8000 steps", "skipped today" is
// reporting a MISS; logging it as a completed session/step count and advancing the
// programme is the single most damaging form of the intent-blind-routing bug.
// Kept to UNAMBIGUOUS miss words: it must not swallow real logs like "I only ran 5km"
// (humble-brag — genuinely ran) or "5km instead of my usual 3km" (genuinely 5km), so
// "only" and "instead of" are deliberately excluded.
export function mentionsNotDone(message: string): boolean {
  const m = (message || "").toLowerCase();
  return /\b(didn.?t|did\s+not|couldn.?t|could\s+not|can.?t|cannot|won.?t|will\s+not|haven.?t|hasn.?t|wasn.?t|weren.?t|missed?|skip(?:ped|ping)?|forgot|failed\s+to|unable\s+to|never\s+got\s+to|couldn.?t\s+manage|didn.?t\s+manage)\b/i.test(m);
}

// Deterministic backstop against the GPT food estimator FABRICATING a composite
// item. Demonstrated production failures:
//   - Client lists "rice / chicken livers / mixed veggies" → model logs phantom
//     "rice and chicken (home cooked)", double-counting protein and hitting target.
//   - Client lists "Lunch / Lentils / Rice / Chicken breast" → normalizer rewrites
//     to "i had lentils, rice and chicken breast for lunch" → model logs "Chicken
//     breast", "Lentils", AND "Chicken and rice" (580 kcal / 56g) — the composite
//     steals chicken from the already-logged item and silently drops rice.
//
// Two independent checks, both required to be wrong before a composite leaks through:
//
//   CHECK 1 (list mode): fires when the message looks like an enumerated list.
//     A returned name with a joiner that wasn't in the original message is fabricated.
//
//   CHECK 2 (cross-output contamination): fires regardless of message format.
//     A returned name with a joiner that SHARES a significant word with another item
//     in the SAME response is a composite of already-logged items — fabricated.
//     This catches the normalizer-rewrite case where CHECK 1 can't fire because the
//     list structure was flattened into prose ("i had lentils, rice and chicken breast
//     for lunch" has shortShare 0.5, below the 0.6 threshold).
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

  const shortShare = segs.length >= 2
    ? segs.filter(s => s.split(/\s+/).length <= 4).length / segs.length
    : 0;
  const isListMessage = segs.length >= 2 && shortShare >= 0.6;

  // Canonicalise so every food-joiner becomes "and" in both strings — a client's
  // "mac n cheese" / "eggs & bacon" then matches the model's "mac and cheese".
  const canon = (s: string) => s.toLowerCase()
    .replace(/[&+]/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(?:and|with|n)\b/g, "and")
    .replace(/\s+/g, " ")
    .trim();
  const hay = canon(userMessage);

  // Significant content words from a food name (excludes stopwords and very short words).
  // Used for CHECK 2 cross-output matching.
  const STOP_WORDS = new Set(["and", "with", "the", "for", "a", "an", "of", "in", "i", "had", "have"]);
  const sigWords = (name: string): Set<string> => {
    const n = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    return new Set(n.split(" ").filter(w => w.length >= 3 && !STOP_WORDS.has(w)));
  };

  const fabricated: string[] = [];
  const allWordSets = foods.map(f => sigWords((f.name || "").replace(/\([^)]*\)/g, " ")));

  for (let i = 0; i < foods.length; i++) {
    const f = foods[i];
    const rawName = (f.name || "").replace(/\([^)]*\)/g, " "); // drop "(home cooked)" etc.
    const hasJoiner = /\b(?:and|with|n)\b/i.test(rawName) || /[&+]/.test(rawName);
    if (!hasJoiner) continue;
    const core = canon(rawName);
    if (core.split(" ").length < 3) continue; // need a real "X and Y" composite

    // CHECK 1 (list mode): composite phrase not verbatim in an enumerated input
    if (isListMessage && !hay.includes(core)) {
      fabricated.push(f.name);
      continue;
    }

    // CHECK 2 (cross-output): composite shares a significant word with another item
    // in the same response — it's combining things already logged separately.
    const myWords = allWordSets[i];
    const sharesWordWithOther = allWordSets.some((otherWords, j) => {
      if (j === i) return false;
      for (const w of myWords) {
        if (otherWords.has(w)) return true;
      }
      return false;
    });
    if (sharesWordWithOther) {
      fabricated.push(f.name);
    }
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

// ── WhatsApp bubble splitting (scheduler send path) ────────────────────────────
// \n\n---\n\n is the codebase-wide "separate WhatsApp bubbles" convention. The
// reactive webhook path honors it (routes/whatsapp.ts splitMessage); the scheduler
// send path historically did NOT — proactive messages built with --- rendered as
// one crammed bubble with literal "---" lines, and any body over Twilio's 1600-char
// hard cap was rejected outright (error 21617), silently killing the Sunday meal
// plan. Every scheduler send must go through this.
export function splitWhatsAppBody(text: string, maxLen = 1500): string[] {
  const bubbles = text.split(/\n\n---\n\n/).map(b => b.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const bubble of bubbles) {
    if (bubble.length <= maxLen) { parts.push(bubble); continue; }
    let current = "";
    for (const line of bubble.split("\n")) {
      const candidate = current ? current + "\n" + line : line;
      if (candidate.length > maxLen) {
        if (current.trim()) parts.push(current.trim());
        let remaining = line;
        while (remaining.length > maxLen) {
          const cutAt = remaining.lastIndexOf(" ", maxLen);
          const breakAt = cutAt > 0 ? cutAt : maxLen;
          parts.push(remaining.slice(0, breakAt).trim());
          remaining = remaining.slice(breakAt).trim();
        }
        current = remaining;
      } else {
        current = candidate;
      }
    }
    if (current.trim()) parts.push(current.trim());
  }
  return parts.length ? parts : [text.trim()].filter(Boolean);
}

// ============================================================
// QUANTITY CORRECTION PARSER — "2 eggs not 3", "it was 2 slices not 4".
// Without this, a count correction fell through the mgmt handler and the food
// scanner logged the corrected text as a brand-NEW meal — the correction became
// a double-count (2026-07-06 audit). Pure — unit-tested in script/unit-tests.ts.
// Returns null unless the message contains an unambiguous "N <food> … not M"
// contrast with sane counts; unit-like words (kg, steps, ml…) never match.
// ============================================================
const NON_FOOD_UNIT_RE = /^(kgs?|kilograms?|grams?|ml|mls|litres?|liters?|kms?|kilometers?|kilometres?|steps?|reps?|sets?|kcal|cals?|calories|min|mins|minutes?|hrs?|hours?|days?|weeks?|percent|%)\b/i;

export function parseQuantityCorrection(m: string): { count: number; food: string; oldCount: number } | null {
  const match = m.match(/\b(\d+(?:\.\d+)?)\s+([a-z][a-z ]{2,24}?)\s*[,.!]?\s+not\s+(\d+(?:\.\d+)?)\b/i)
    || m.match(/\bnot\s+(\d+(?:\.\d+)?)\s*[,.]?\s*(?:it was|i had|just)\s+(\d+(?:\.\d+)?)\s+([a-z][a-z ]{2,24}?)\b/i);
  if (!match) return null;
  // First pattern: [new, food, old]; second: [old, new, food]
  const firstForm = /^\d/.test(match[1]) && !/^\d/.test(match[2]);
  const count = parseFloat(firstForm ? match[1] : match[2]);
  const oldCount = parseFloat(firstForm ? match[3] : match[1]);
  const food = (firstForm ? match[2] : match[3]).trim().toLowerCase();
  if (!Number.isFinite(count) || !Number.isFinite(oldCount)) return null;
  if (count <= 0 || count > 50 || oldCount <= 0 || oldCount > 50 || count === oldCount) return null;
  if (NON_FOOD_UNIT_RE.test(food)) return null;
  return { count, food, oldCount };
}
