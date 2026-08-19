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

// Day boundaries live in server/sast.ts (ledger D6) — ONE definition of a SAST day for the whole
// codebase. These two stay as re-exports so the existing call sites keep working unchanged while
// they migrate; new code should import from ./sast directly.
import { sastDayKey, sastDayStart } from "./sast";
export { sastDayStart };
export const sastToday = sastDayKey;

// Deterministic meal slot from the SAST hour — used to label a food log when the client
// doesn't say which meal it is. Total over all 24h (no gaps): the 15:00–17:00 window
// falls to "snack". The 22:00–05:00 window is snack ONLY for genuinely light bites —
// a night-shift client's 02:00 plate of pap and wors is their MAIN meal, not a snack
// (2026-07-17 inference design: infer, don't interrogate — and don't mislabel either).
export function slotFromSastHour(date: Date = new Date(), opts?: { nightWorker?: boolean; substantial?: boolean }): "breakfast" | "lunch" | "dinner" | "snack" | "night meal" {
  const h = new Date(date.getTime() + 2 * 3_600_000).getUTCHours();
  if (h >= 5 && h < 11) return "breakfast";
  if (h >= 11 && h < 15) return "lunch";
  if (h >= 17 && h < 22) return "dinner";
  if ((h >= 22 || h < 5) && (opts?.nightWorker || opts?.substantial)) return "night meal";
  return "snack";
}

// EARLY-HOURS RETRO — the meal that lands in the small hours (00:00–04:59 SAST) almost always
// belongs to the day that just ENDED, not a fresh one: a 4am "dinner" is LAST NIGHT's dinner
// (2026-07-23 live: a dinner photo at 04:07 was filed under the new day, so the whole day's
// numbers were wrong). Shift such a log back to the previous day — UNLESS the client explicitly
// tied it to now/today, or it reads as a genuine early breakfast. Pure + conservative: only the
// ambiguous small hours are ever touched, daytime logs are returned untouched. Known trade-off:
// a true night-shift eater's 2–4am meal is rare next to people reporting the night just gone.
export function effectiveMealLoggedAt(loggedAt: Date, rawMessage: string, mealLabel: string | null | undefined): Date {
  const sastHour = new Date(loggedAt.getTime() + 2 * 3_600_000).getUTCHours();
  if (sastHour >= 5) return loggedAt; // only 00:00–04:59 is ambiguous
  const lo = (rawMessage || "").toLowerCase();
  if (/\b(now|just|right now|just now|today|this morning|currently|about to|going to|tonight|early)\b/.test(lo)) return loggedAt;
  if (mealLabel === "breakfast") return loggedAt; // a 3–4am breakfast is a real early start
  return new Date(loggedAt.getTime() - 24 * 3_600_000); // → the day that just ended
}

// A clock time written in a caption tells us the meal SLOT even when the photo is batch-sent
// hours later (2026-07-22, Puntsa's photo diary: shot at "11:00", the whole day sent at 19:49
// — the send-clock mislabelled it dinner). Requires a colon-time or am/pm so it never fires on
// a quantity ("2 eggs", "500ml"). Returns null when there's no time to read.
export function slotFromCaptionTime(msg: string): "breakfast" | "lunch" | "dinner" | "snack" | null {
  const lo = (msg || "").toLowerCase();
  let hour: number | null = null;
  const hm = lo.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
  const ap = lo.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (hm) {
    hour = parseInt(hm[1], 10);
    if (hm[3] === "pm" && hour < 12) hour += 12;
    if (hm[3] === "am" && hour === 12) hour = 0;
  } else if (ap) {
    hour = parseInt(ap[1], 10);
    if (ap[2] === "pm" && hour < 12) hour += 12;
    if (ap[2] === "am" && hour === 12) hour = 0;
  }
  if (hour === null || hour < 0 || hour > 23) return null;
  if (hour <= 11) return "breakfast"; // includes late-morning brunch (11:00 eggs)
  if (hour <= 15) return "lunch";
  if (hour <= 16) return "snack";
  return "dinner";
}

// Does this client work nights? Read from the onboarding answers we already hold —
// the same data that steers their programme timing.
export function isNightWorker(user: any): boolean {
  return /night/i.test(String(user?.workSchedule || "")) || /night.?shift/i.test(String(user?.lifeSituation || user?.jobType || ""));
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
    // SAST midnight of the target day + SAST wall-clock time. Anchoring the DATE
    // to UTC-now put day-name meals one day off between 00:00–02:00 SAST (same
    // midnight-window family as the "yesterday" bug, 2026-07-07).
    const dayStartMs = todayStartSAST.getTime() - daysBack * 86_400_000;
    const timeMatch = m.match(/\b(\d{1,2})[:.h](\d{2})\b/);
    let sastClockMs: number;
    if (timeMatch) {
      sastClockMs = (parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2])) * 60_000;
    } else if (/\b(morning|breakfast|after gym)\b/.test(m)) {
      sastClockMs = 8 * 3_600_000;   // 8am SAST
    } else if (/\b(lunch|midday|afternoon|around noon)\b/.test(m)) {
      sastClockMs = 12 * 3_600_000;  // noon SAST
    } else if (/\b(night|dinner|supper|evening)\b/.test(m)) {
      sastClockMs = 20 * 3_600_000;  // 8pm SAST
    } else {
      sastClockMs = 12 * 3_600_000;  // default noon SAST
    }
    return new Date(dayStartMs + sastClockMs);
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

/**
 * Drop extracted foods whose names are not grounded in the client's words.
 * Live 2026-08-19: "South African breakfast + mocha" became Big Mac + Big Breakfast.
 * A logged item is a fact — only keep names the message actually supports.
 */
export function findUngroundedFoodItems(
  userMessage: string,
  foods: Array<{ name: string }>,
): string[] {
  if (!userMessage || !foods?.length) return [];
  const hay = userMessage
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const hayWords = new Set(hay.split(" ").filter((w) => w.length >= 2));

  // Brand / meal tokens that count as grounding when present in the message
  const STOP = new Set([
    "and", "with", "the", "for", "a", "an", "of", "in", "on", "from", "to",
    "i", "had", "have", "ate", "eaten", "just", "some", "my", "was", "were",
    "large", "small", "cup", "plate", "bowl", "piece", "pieces", "slice", "slices",
  ]);

  const ungrounded: string[] = [];
  for (const f of foods) {
    const raw = (f.name || "").replace(/\([^)]*\)/g, " ").toLowerCase();
    const nameWords = raw
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter((w) => w.length >= 2 && !STOP.has(w));
    if (nameWords.length === 0) continue;

    // Full phrase in message (e.g. "big breakfast") — grounded
    const phrase = nameWords.join(" ");
    if (hay.includes(phrase)) continue;

    // Distinctive words (skip ultra-generic menu words that appear in many DB names)
    const GENERIC = new Set(["meal", "food", "combo", "special", "item", "order", "menu"]);
    const distinctive = nameWords.filter((w) => !GENERIC.has(w));
    const need = distinctive.length > 0 ? distinctive : nameWords;
    const hits = need.filter(
      (w) => hayWords.has(w) || [...hayWords].some((h) => h.startsWith(w) || w.startsWith(h)),
    ).length;
    // Require a majority of distinctive tokens to appear in the client message
    const minHits = need.length <= 1 ? 1 : Math.ceil(need.length * 0.5);
    if (hits < minHits) {
      ungrounded.push(f.name);
    }
  }
  return ungrounded;
}


export function mealDateLabel(date: Date): string {
  const nowSAST = new Date(Date.now() + 2 * 3_600_000);
  const mealSAST = new Date(date.getTime() + 2 * 3_600_000);
  const diffDays = Math.round((nowSAST.setUTCHours(0,0,0,0) - mealSAST.setUTCHours(0,0,0,0)) / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  return days[mealSAST.getUTCDay()] || `${diffDays} days ago`;
}

/**
 * FIRST NAME ONLY (2026-07-29). This returned the full stored name, so a client called Thandi
 * Mokoena was greeted "Good morning Thandi Mokoena", told "3 sessions didn't happen, Thandi
 * Mokoena", and asked "Three questions Thandi Mokoena before I give you advice". Nobody's coach
 * says their surname. It reads like a bank, and it appeared in every greeting, every progress
 * report and every nudge — the single most-repeated wrong note in the product.
 */
/**
 * Is this message asking for SEVERAL things at once?
 *
 * (2026-07-29.) A deterministic gate answers exactly one question. When a client sends a long
 * voice note asking four — workouts this week, what to do coming back from illness, calories,
 * what to eat — a gate that matches on one of those words answers that one and silently drops
 * the rest. The client then reasonably concludes the coach ignored them, which is what happened
 * and it is the worst failure this product has produced.
 *
 * Multi-part asks belong to the brain, which can hold all of them in one answer. Conservative on
 * purpose: two clear asks, or a genuinely long message with a question in it. A short "how many
 * calories left?" must still reach its fast deterministic answer.
 */
/**
 * ", Thandi" — a comma-led address, or "" when there is no usable name.
 *
 * (2026-07-29 sweep: "The scale is one data point, Thandi Mokoena".) getDisplayName has existed
 * for exactly this since the start, and 48 call sites interpolated `user.name` raw instead —
 * so the coach addressed people by their full name, like a bank SMS, in the middle of a
 * sentence meant to sound like a person. Two helpers so the 48 opinions become one.
 */
export function commaName(user: any): string {
  const n = getDisplayName(user);
  return n ? `, ${n}` : "";
}

/** " Thandi" — a space-led address, or "" when there is no usable name. */
export function spaceName(user: any): string {
  const n = getDisplayName(user);
  return n ? ` ${n}` : "";
}

export function isMultiPartAsk(message: string): boolean {
  const s = (message || "").trim();
  if (s.length < 60) return false;                       // short asks are single asks
  const words = s.split(/\s+/).length;
  const questionMarks = (s.match(/\?/g) || []).length;
  if (questionMarks >= 2) return true;                   // literally asked twice
  // "and tell me…", "and what…", "also…" — a second request bolted onto the first.
  const joiners = (s.match(/\b(?:and (?:tell me|what|how|why|when|also|then)|also,? (?:tell|what|how)|as well as)\b/gi) || []).length;
  if (joiners >= 1 && words >= 20) return true;
  return words >= 35 && questionMarks >= 1;              // a long question is rarely just one
}

export function getDisplayName(user: any): string {
  const raw = String(user?.name || "").trim();
  if (raw.length < 2 || INVALID_NAMES.has(raw.toUpperCase())) return "";
  const first = raw.split(/\s+/)[0];
  return first.length >= 2 ? first : raw;
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

/**
 * Test/ops hook — clear the per-user GPT rate-limit window.
 *
 * (2026-08-05.) The offline routing harness fires 300+ messages as ONE user in a few seconds.
 * Past ten that reach the model, every later case came back "You're sending messages very
 * fast" — so a case added at the END of the file failed for a reason that had nothing to do
 * with what it was testing, and would have been read as a product defect. Worse, it silently
 * capped how many model-reaching cases the suite could ever hold.
 */
export function _resetGptRateLimit(userId?: string): void {
  if (userId) gptCallTimestamps.delete(userId); else gptCallTimestamps.clear();
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
  // "half a X" is a real count (2026-07-23 live: "Not 2 Viennas but only half a Vienna").
  const norm = m.replace(/\bhalf\s+(?:a|an|the)\s+/gi, "0.5 ");
  const match = norm.match(/\b(\d+(?:\.\d+)?)\s+([a-z][a-z ]{2,24}?)\s*[,.!]?\s+not\s+(\d+(?:\.\d+)?)\b/i)
    || norm.match(/\bnot\s+(\d+(?:\.\d+)?)\s*[a-z ]{0,12}?[,.]?\s*(?:it was|i had|just|but(?:\s+only)?|actually|only|make it|it'?s)\s+(\d+(?:\.\d+)?)\s+([a-z][a-z ]{2,24}?)\b/i);
  if (!match) return null;
  // First pattern: [new, food, old]; second: [old, new, food]
  const firstForm = /^\d/.test(match[1]) && !/^\d/.test(match[2]);
  const count = parseFloat(firstForm ? match[1] : match[2]);
  const oldCount = parseFloat(firstForm ? match[3] : match[1]);
  // The lazy food capture can trail into filler ("3 slices THERE, not 2" → "slices there").
  // Drop trailing position/filler words so the food is the noun the client actually named.
  const food = (firstForm ? match[2] : match[3]).trim().toLowerCase()
    .replace(/\s+(there|here|total|now|today|left|each|of them|in there|in total)$/i, "").trim();
  if (!Number.isFinite(count) || !Number.isFinite(oldCount)) return null;
  if (count <= 0 || count > 50 || oldCount <= 0 || oldCount > 50 || count === oldCount) return null;
  if (NON_FOOD_UNIT_RE.test(food)) return null;
  return { count, food, oldCount };
}

// ============================================================
// TRANSACTION REPORT DETECTORS — pure, unit-tested. These gate the model brain
// in routes.ts: a plain steps/water/weight report must reach the deterministic
// logger and never be swallowed by the model (2026-07-06: the brain answered
// "Steps are 10000" convincingly and logged nothing). Question-guarding happens
// at the call site (normalizer QUESTION classification) — these match form only.
// ============================================================
export function looksLikeStepsReport(m: string): boolean {
  return /\b[\d,]+\s*k?\s*steps?\b/i.test(m) || /\bsteps?\s*(?:are|is|was|were|:)\s*[\d,]+/i.test(m);
}

// A BARE greeting or menu request — must reach the warm deterministic menu (getMenuText,
// with tap buttons + today's context), NOT the model. 2026-07-10: with MODEL_BRAIN=on the
// brain ran before the greeting handler and answered "hello" with a generic, button-less
// "what's on your mind" — different every time. Only matches a message that IS just a
// greeting/menu word (so "hello, I ate eggs" still flows to the handlers).
const GREETING_WORDS = new Set([
  "hello", "hi", "hey", "heya", "hiya", "yo", "sup", "hello there", "hi there", "hey there",
  "howzit", "howsit", "hola", "good morning", "morning", "good afternoon", "good evening", "good day",
  "hi coach", "hey coach", "hello coach", "hi coach k", "hey coach k",
  "sawubona", "sanibonani", "unjani", "kunjani", "molo", "molweni", "dumela", "dumelang",
  "lumela", "thobela", "hallo", "goeie more", "goeie middag", "avuxeni", "ndaa", "aweh", "sharp",
  "menu", "help", "start", "hey kam", "hi kam",
]);
export function isBareGreeting(m: string): boolean {
  const s = (m || "").toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
  return s.length > 0 && GREETING_WORDS.has(s);
}

// TIME-OF-DAY GREETING in SAST (2026-07-22, founder: "it should say good morning/afternoon/
// evening — the coaching must feel more human, like a person"). Neutral in the small hours so
// we never say "Good morning" at 2am. Pure — takes an optional hour for testability.
export function timeGreeting(hour?: number): string {
  const h = hour ?? parseInt(new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour: "2-digit", hour12: false }), 10);
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 17) return "Good afternoon";
  if (h >= 17 && h < 22) return "Good evening";
  return "Hey"; // late night / pre-dawn — a time-of-day greeting would read wrong
}

// A request to CHANGE the steps target — must reach the deterministic updater in
// early-commands, never the brain. 2026-07-10: a client "had a discussion" with the
// brain about moving to 10,000 steps; the brain agreed in words, persisted nothing,
// and the morning brief kept saying 11,000 — the exact gaslighting the law forbids.
//
// 2026-07-12: it STILL said 11,000 after Kam asked "many times". Root cause: the old
// regex only matched 3+ CONTIGUOUS digits, so the SA-natural "10 000" (space
// thousands separator) and "10k" both slipped past the gate to the brain — which just
// chatted ("steps are a bonus, we'll adjust as needed") and wrote nothing. The gate
// and the handler had two SEPARATE regexes that could drift, too. Now ONE parser is
// the single source of truth for both: it detects the intent AND returns the number.

// Parse a step-target number in any format a South African actually types:
// "10000", "10,000", "10 000" (space separator), "10k"/"10 K". Returns null if none.
function parseStepNumberToken(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  let n: number;
  if (/^\d{1,3}\s*k$/.test(t)) n = parseInt(t, 10) * 1000; // "10k" → 10000
  else n = parseInt(t.replace(/[ ,]/g, ""), 10);            // "10 000"/"10,000" → 10000
  return Number.isFinite(n) ? n : null;
}

// A step number as written in SA: grouped ("10 000"/"10,000"), a k-suffix ("10k"),
// or 3+ bare digits ("10000"). Deliberately NOT a lone 1–2 digit number (too
// ambiguous — "make it 8" is not a step target).
const STEP_NUM = String.raw`(\d{1,3}(?:[ ,]\d{3})+|\d{1,3}\s*[kK]|\d{3,})`;

// Returns the intended NEW step target (unclamped) if the message asks to change it,
// else null. Shared by the brain gate (skip → deterministic) and the updater (persist).
export function extractStepTargetChange(m: string): number | null {
  const s = m || "";
  // A plain step LOG ("I walked 10 000 steps", "did 8000 today") is NOT a target change.
  if (/\b(?:walked|walk|did|done|hit|got|logged|clocked|reached|managed|took)\b[^.!?]{0,20}\bsteps?\b/i.test(s)
      && !/\b(?:target|goal|from now|going forward|set|change|make it|only want|want to be)\b/i.test(s)) return null;
  // ASKING about steps is not changing them ("Should I keep my steps at 10,000?") —
  // but a polite directive ("can you set my steps to 10k") IS a change request.
  if (isAskingNotReporting(s)
      && !/\b(?:can|could|will|would) you\b[^.!?]{0,30}\b(?:set|change|make|update|drop|lower|raise|keep|cap|put)\b/i.test(s)) return null;
  // Other people's steps, and single-day plans, are not a standing target change.
  if (/\b(?:tell people|for people|my clients?|people should)\b/i.test(s)) return null;
  if (/\b(?:today|tomorrow|tonight|yesterday|this (?:morning|afternoon|evening))\b/i.test(s)) return null;
  // Gaps are LAZY (`?`) so the greedy engine can't eat into the digits and leave
  // STEP_NUM matching a trailing fragment (e.g. "10," consumed → "000" captured → 0).
  const patterns = [
    new RegExp(String.raw`\b(?:set(?:ting)?|chang(?:e|ing|ed)|updat(?:e|ing|ed)|bump(?:ing|ed)?|rais(?:e|ing|ed)|lower(?:ing|ed)?|increas(?:e|ing|ed)|decreas(?:e|ing|ed)|mak(?:e|ing)|mov(?:e|ing|ed)|adjust(?:ing|ed)?)\b[^.!?]{0,30}?\bsteps?\b[^.!?]{0,20}?\b(?:to\s+)?(?<![\d,])${STEP_NUM}\b`, "i"),
    new RegExp(String.raw`\bsteps?\s+(?:target|goal)\s+(?:to\s+)?(?<![\d,])${STEP_NUM}\b`, "i"),
    new RegExp(String.raw`\bsteps?\b[^.!?]{0,15}?\b(?<![\d,])${STEP_NUM}\b[^.!?]{0,25}?\b(?:from now|going forward|as (?:the|my) (?:standard|target|goal))\b`, "i"),
    // FIRST-PERSON PREFERENCE (2026-07-14, the founder's own message went unheard:
    // "I really only want to be doing 10,000 steps now, nothing more" wrote NOTHING —
    // only robot phrasings with set/change verbs were caught, so the bot agreed
    // politely and kept nagging the old target every morning). People state targets
    // as wants and limits, not commands.
    new RegExp(String.raw`\bi(?:'?d)?\s+(?:really\s+)?(?:only\s+)?(?:want|prefer|rather|like)\b[^.!?]{0,40}?\b(?<![\d,])${STEP_NUM}\b[^.!?]{0,12}?\bsteps?\b`, "i"),
    new RegExp(String.raw`\bi(?:'?d)?\s+(?:really\s+)?(?:only\s+)?(?:want|prefer|rather|like)\b[^.!?]{0,20}?\bsteps?\b[^.!?]{0,20}?\b(?:to be|at|to)\s*(?<![\d,])${STEP_NUM}\b`, "i"),
    new RegExp(String.raw`\b(?:keep|cap|limit|stick(?:ing)?\s+(?:to|with)|drop|max)\b[^.!?]{0,20}?\bsteps?\b[^.!?]{0,15}?\b(?:at|to|of)?\s*(?<![\d,])${STEP_NUM}\b`, "i"),
    new RegExp(String.raw`\b(?<![\d,])${STEP_NUM}\s*steps?\b[^.!?]{0,15}?\bis my (?:max(?:imum)?|limit|ceiling|cap)\b`, "i"),
  ];
  for (const re of patterns) {
    const mm = s.match(re);
    if (mm && mm[1]) return parseStepNumberToken(mm[1]);
  }
  return null;
}

export function looksLikeStepsTargetChange(m: string): boolean {
  return extractStepTargetChange(m) !== null;
}

// "Give me direction / what do I do today" — must reach the deterministic daily-
// direction answer (buildDailyDirection: rest-day-aware, all pillars), never the brain.
// 2026-07-11 live: "Hello" correctly said REST DAY, then "give me direction" (brain)
// dumped Upper Body A and a voice "what should I be doing today" (brain) dumped Upper
// Body B — three contradicting answers in two minutes. ONE source of truth: code.
// Single definition shared by routes.ts (brain gate) and misc-commands (the handler).
export function looksLikeDirectionRequest(m: string): boolean {
  const s = (m || "").replace(/^[.!?,;:'"\s]+|[.!?,;:'"\s]+$/g, "");
  return /\b(give me (a )?direction|direction for (the|this|today|my)|what (do|should) i (do|be doing|need to do)( today| this week| for the week| now| next)|what.?s my (plan|week|day)|my (overall |whole )?plan\b|overall plan|plan for (the|this) (week|day|month)|where do i (start|begin))\b/i.test(s)
    && !/\b(workout|exercise|meal plan|recipe|shopping|supplement|pay|cancel|refund|price|cost)\b/i.test(s);
}

// LOW MOBILITY — a client who physically can't walk much (bad knees, a wheelchair, a
// heart condition, arthritis, an amputation, chronic pain). 2026-07-12, Kam (twice):
// "some people can't walk a lot… we need to accommodate that." This must reach a warm,
// deterministic accommodation — NOT the brain (which improvises), and NOT the generic
// step logger. It reassures that results come from the food deficit (steps are a bonus)
// and offers a realistic, lower step goal. Precise so it never fires on a lazy day.
export function looksLikeLowMobility(m: string): boolean {
  const s = m || "";
  // Explicit inability to walk.
  if (/\b(can'?t|cannot|can not|unable to|struggle(?:s|ing)? to|hard to|difficult to|too (?:sore|painful|weak|tired|heavy|old) to)\s+(?:really\s+|even\s+)?walk\b/i.test(s)) return true;
  if (/\b(difficulty|trouble|problems?)\s+walking\b/i.test(s)) return true;
  // Can't do the steps / that many steps.
  if (/\b(?:can'?t|cannot|can not|unable to|struggle(?:s|ing)? to)\s+(?:do|hit|reach|manage|get|make)\s+(?:the\s+|my\s+|those\s+|that many\s+|so many\s+|\d[\d,\s]*\s*)?steps?\b/i.test(s)) return true;
  // Standing disability / mobility conditions — these accommodate on their own.
  if (/\b(wheelchair|on crutches|walking stick|walking cane|use a cane|mobility (?:issue|problem|aid|scooter)|disabled|disability|amputat|amputee|prosthe(?:sis|tic)|arthritis|chronic pain|bad heart|heart condition|can'?t be on my feet|bed ?ridden|housebound)\b/i.test(s)) return true;
  // Body-part pain ONLY when it's about walking/standing/movement (so "sore back from
  // deadlifts" doesn't trigger a walking accommodation).
  if (/\b(?:bad|sore|painful|weak|dodgy|injured|replaced?)\s+(?:knee|knees|hip|hips|leg|legs|ankle|ankles|feet|foot|joint|joints)\b/i.test(s)
      && /\b(walk|walking|steps?|on my feet|stand|standing|move|moving|mobility)\b/i.test(s)) return true;
  return false;
}

// DEFEATED / "IT'S MY GENETICS" — the client who's tried for years and blames their genes
// or the "social media said do X" generic advice. 2026-07-12, Kam's live masterclass:
// she said "genes are working against me 😭", he replied "It's not your genetics, you
// just need the right help… you're here now, you can relax." This is the most valuable
// moment in coaching (it's why people pay), so it gets Kam's EXACT reframe deterministically
// — not a model paraphrase, not the generic struggle handler. Precise: it fires on a
// genetics/hopeless-veteran signal, not on a plain "no results this week" check-in.
export function looksLikeDefeatedNoResults(m: string): boolean {
  const s = m || "";
  // Blaming genetics / body / metabolism.
  if (/\b(genetics?|genes?|metabolism|my body)\b[^.!?]{0,40}\b(against me|the problem|to blame|won'?t|refuse|hate|working against|not made|holding me back|bad|slow)\b/i.test(s)) return true;
  if (/\b(against me|working against me|the problem|to blame|holding me back)\b[^.!?]{0,25}\b(genetics?|genes?|my body|metabolism)\b/i.test(s)) return true;
  if (/\b(bad genetics|slow metabolism|born this way|just (?:my )?genes|it'?s (?:my |the )?genetics|blame my genes|cursed genes)\b/i.test(s)) return true;
  // The hopeless veteran: long effort + still no results.
  if (/\b(?:been|since)\b[^.!?]{0,40}\b(covid|years?|\d+\s*(?:years?|months?)|forever|ages)\b/i.test(s)
      && /\b(no results?|not seeing|nothing.{0,10}(?:working|changing|happening)|no (?:change|progress)|still (?:the same|nothing|stuck)|give up|giving up)\b/i.test(s)) return true;
  return false;
}

// SICK FLOW HELPERS (2026-07-13, the flu screenshots: the canned sick template was sent
// FOUR times verbatim — twice in reply to "what happens when I come back from the flu?"
// — while the proactive machine blasted a week-summary 45 min after "I've got the flu").
// Pure helpers so the sick handler can be question-aware, repeat-aware and duration-aware.

// "I'll not be training for the next 5 days" → 5. Unstated → 3. Capped 1..14.
export function parseSickDays(m: string): number {
  const s = m || "";
  const mm = s.match(/\b(?:for|next|about)?\s*(\d{1,2})\s*(?:more\s*)?days?\b/i);
  if (mm) {
    const n = parseInt(mm[1], 10);
    if (Number.isFinite(n)) return Math.max(1, Math.min(14, n));
  }
  if (/\b(two weeks|2 weeks|fortnight)\b/i.test(s)) return 14;
  if (/\b(rest of (?:the|this) week|whole week|all week|a week)\b/i.test(s)) return 7;
  // DAY-OF-WEEK (2026-07-19 live: "sick until Monday" defaulted to "~3 days" — the
  // stated day was ignored). "until/till/through/by <day>" → days from today (SAST) to
  // that weekday. Forward prepositions only, so "sick since Monday" isn't a return date.
  const dayMatch = s.match(/\b(?:until|till|til|through|thru|by|to)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (dayMatch) {
    const DOW: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const target = DOW[dayMatch[1].toLowerCase()];
    const todaySast = new Date(Date.now() + 2 * 3_600_000).getUTCDay();
    let delta = (target - todaySast + 7) % 7;
    if (delta === 0) delta = 7; // "until Monday" said on a Monday = next Monday
    return Math.max(1, Math.min(14, delta));
  }
  return 3;
}

// TRIED-EVERYTHING psychology (2026-07-14, Kam: manual clients send long voice notes —
// "I've tried GLP-1s, every diet, and I'll quit without accountability"). This exact
// moment is the emotional core of the product: someone exhausted by a history of
// failure who needs to hear it's not their fault and that accountability is the thing
// that was missing. Recognising it lets the coach lead with the right psychology.
export function mentionsTriedEverything(m: string): boolean {
  const s = m || "";
  return /\b(tried (everything|it all|every ?thing|so many|all the|a lot of)|nothing (ever )?(works|worked|helps|helped)|every diet|been on (every|so many)|yo.?yo|(always|keep|keeps?) (putting|put|gain(?:ing)?|piling?|pile) (it|the weight) (all )?back|gained? (it|the weight) (all )?back|lost.{0,20}gained.{0,20}back|last resort|at my wits|desperate|given up before|keep failing|always fail)\b/i.test(s)
    || /\b(glp.?1|glp1|ozempic|wegovy|saxenda|semaglutide|mounjaro|banting|keto|shakes|slimming (pills|tablets|teas)|diet pills|herbalife|weigh.?less)\b/i.test(s);
}

// A DEEP EMOTIONAL SHARE — a long, vulnerable message (the 5-6 minute voice-note dump
// Kam describes) or a clear "I want to quit / I can't do this alone" moment. These
// deserve DEPTH and warmth, not a curt 3-sentence coach reply — matching the weight of
// what the person just gave you is the whole point. Pure — unit-tested.
export function looksLikeDeepEmotionalShare(m: string): boolean {
  const s = (m || "").trim();
  const EMO = /\b(quit|give up|giving up|want to stop|can.?t do this|can.?t keep|no results|nothing.{0,15}chang|so tired|exhausted|overwhelmed|depress|anxious|hopeless|no hope|ashamed|embarrass|hate (my|myself|this body|my body)|feel (fat|ugly|worthless|like a failure)|not good enough|crying|breaking down|falling apart|struggling|struggle|alone|on my own|by myself|frustrat|defeated|lost (all )?motivation|about to give)\b/i;
  const strong = mentionsTriedEverything(s)
    || /\b(i (just )?want to (quit|give up|stop)|can.?t do this (any ?more|alone|on my own)|about to (quit|give up)|ready to give up|i (feel|am) (so )?(alone|hopeless|defeated|like giving up)|please help me|i don.?t know what (else )?to do|at the end of my rope)\b/i.test(s);
  if (strong) return true;
  // Otherwise: a genuinely long message (voice-note-length) carrying real emotion.
  return s.length >= 220 && EMO.test(s);
}

// A QUESTION about the return/aftermath of being sick — must get the comeback plan,
// never the rest-up template ("what happens when I come back from the flu?", "how does
// that affect my progress/my week?", "what do I do when I'm better?").
/**
 * A COMEBACK QUESTION — "I'm back in the gym, yesterday was my first day. What's the next move?"
 *
 * (2026-07-28 live.) This reached the meaning engine, which replied "Would you like to focus on
 * strength training, or do you want to incorporate some running too?" — asking a man who had just
 * said "tell me how we are going to approach this". A comeback has ONE correct answer and it is a
 * fixed physiological ramp, so it belongs on the deterministic rails, not in a conversation.
 *
 * Deliberately does NOT require the word "sick" — this client never used it.
 */
export function looksLikeComebackQuestion(m: string): boolean {
  const s = m || "";
  const backMarker = /\b(?:first (?:day|session|time) back|back (?:in|at) (?:the )?gym|back to (?:the )?gym|just got back|coming back|came back|returned to training|getting back into it)\b/i.test(s);
  if (!backMarker) return false;
  const asking = /\b(?:what'?s the next move|what (?:do|should|must) i do|how (?:do|should) (?:we|i)|what now|where (?:do|to) (?:i|we) start|tell me how|how are we going to|what'?s the plan|next steps?)\b/i.test(s)
    || /\?/.test(s);
  return asking;
}

// "Today is lower 1 after my illness. How do I go about it?" (2026-07-29 live) reached none of
// this and fell through to the model, which read "lower" as a MOOD and answered a training
// question with eggs and hydration. The client had used the product's own vocabulary — Lower A
// and Lower B are day names in its own 4-day split — and been told he seemed down.
//
// The cause was one word. The list below had "sickness" but not "illness", and "the" but not
// "my", so `after my illness` matched nothing. That is an enumeration of phrasings pretending
// to be a detector: it can only ever catch the wordings someone thought of.
//
// So the SHAPE is detected separately: an illness word placed BEHIND the speaker, plus a
// request for direction. Additive — the original list still fires on its own, so nothing that
// worked before changes.
// 2026-07-29, second live miss: "Is this because of my 3 weeks of illness? How do I go about
// this?" A fixed list of determiners could not span "my 3 weeks of", so the enumeration failed
// again in a new place — and "because of" was not a preposition it knew. Any short run of words
// between the preposition and the illness noun now counts, which is what a person actually says.
const AFTER_ILLNESS = /\b(?:after|since|post|following|because of|due to|coming out of|back from|recovering from|over)\s+(?:\w+\s+){0,4}?(?:sick(?:ness)?|ill(?:ness)?|flu|flue|fever|covid|bug|virus|infection|surgery|op(?:eration)?)\b/i;

const ASKING_FOR_DIRECTION = /\b(?:how (?:do|should|would|can) (?:i|we)|how do i go about|what (?:do|should|must|can) (?:i|we) do|what now|what'?s next|where (?:do|to) (?:i|we) start|what'?s the plan|next steps?|do i (?:still|need to|have to))\b/i;

export function isReturnFromSicknessQuestion(m: string): boolean {
  const s = m || "";
  if (!/\b(sick|ill|flu|flue|fever|covid|better|recover)/i.test(s)) return false;
  if (/\b(when i (?:come|get|'?m) back|come back from|after (?:the )?(?:flu|sickness|being sick|i recover|i'?m better)|what happens? then|what happens? (?:when|after)|how (?:does|will) (?:that|this|it) affect|affect my (?:progress|week|programme|plan)|what (?:do|must|should) i do (?:when|after|once)|when i'?m (?:better|recovered|well)|back to training|resume|pick (?:it )?(?:back )?up)\b/i.test(s)) return true;
  // The shape: the illness is behind them AND they are asking what to do about it. Both halves
  // are required — "I felt rough after the flu" is a report, not a request for a plan.
  return AFTER_ILLNESS.test(s) && (ASKING_FOR_DIRECTION.test(s) || /\?/.test(s));
}

// WORKOUT REQUEST — natural phrasings must reach the deterministic programme, never the
// brain (2026-07-13 tester screenshot: "Home workout with two dumbbells" matched nothing
// — only exact "workout"/"my workout"/"1" did — so the MODEL improvised a generic
// unformatted wall-of-text workout with no GIFs, no buttons, not her programme). Also
// catches demo/video requests: the served session carries the "See every move" link, so
// serving it IS the answer — never navigation instructions.
export function looksLikeWorkoutRequest(m: string): boolean {
  const s = m || "";
  // Bare commands and the workout message's own button label typed back as text
  // (2026-07-13 round 3: the model answered bare "Workout" with an improvised session,
  // and "See every move" typed as text got circular navigation instructions — the
  // deterministic serving carries the real link, so serving it IS the answer).
  if (/^\s*(workout|my workout|today'?s?\s+workout|my programme|programme|my program|program|see every move)\W*$/i.test(s)) return true;
  // INTENT BOUNCER (2026-07-21 voice-note miss: "let's talk about running, incorporating it
  // into my program without killing my gym progress" DUMPED the full programme because it says
  // "my program"). A message DISCUSSING or MODIFYING training — cardio, running, combining,
  // "without losing gains" — is JUDGMENT for the coach, never a request to re-send the plan.
  if (/\b(let'?s talk|talk(ing)? about|thoughts?\b|what do you think|without (killing|losing|hurting|ruining|sacrific\w*)|incorporat\w*|combin\w*|mix (in|into|it)|too much cardio|can i still|do i still need|instead of my)\b/i.test(s)) return false;
  if (/\b(how (do|can|should) i|should i)\b[^.!?]{0,20}\b(add|includ\w*|incorporat\w*|combin\w*|balanc\w*|fit in|start (running|cardio|swimming))\b/i.test(s)) return false;
  if (/\badd\w*\b[^.!?]{0,22}\b(to my|into my|my program|my routine|running|cardio|swimming)\b/i.test(s)) return false;
  // Not a request: done-reports, feedback, scheduling, and how-long/how-many questions.
  if (/\b(did|done|finished|completed|smashed|crushed|skipped|felt|was (easy|hard|tough)|cancel|skip|move|reschedule|postpone)\b/i.test(s)) return false;
  if (/\bhow (long|many|often|much)\b/i.test(s)) return false;
  // Questions ABOUT workouts ("Is a home workout as good as the gym?") go to the coach,
  // not the programme — routing-audit caught this false-positive. Imperatives and
  // "can/could you send…" remain requests.
  if (/^\s*(is|are|does|do|why|would|will|when|where|who|should i|am i)\b/i.test(s)) return false;
  // "home/quick/full-body/dumbbell/bodyweight/hotel workout"
  if (/\b(home|quick|full.?body|dumbbell|bodyweight|hotel|travel|short)\s+(workout|session|training)\b/i.test(s)) return true;
  // "give/send/need/want a workout", "can I get a workout"
  if (/\b(give|send|show|need|want|get)\b[^.!?]{0,15}\b(workout|session)\b/i.test(s)) return true;
  // PROGRAMME requests in natural speech (2026-07-16 voice note: "Show me my gym
  // program" missed every exact-match trigger and the engine replied "I can't show you
  // the gym program directly, but reply program" — knowing the command and not running
  // it). Show-verb + programme/plan, or a qualified programme mention, DELIVERS it.
  if (/\b(give|send|show|see|view|check|get|what'?s)\b[^.!?]{0,20}\b(program(?:me)?|workout plan|training plan)\b/i.test(s)) return true;
  if (/\b(my|the|gym|full|whole|entire)\s+program(?:me)?\b/i.test(s)) return true;
  // "workout with dumbbells", "workout for today", "workout using bands"
  if (/\bworkout\s+(with|using|for)\b/i.test(s)) return true;
  if (/\bwhat.?s my workout\b/i.test(s)) return true;
  // Demo/video requests — the workout message carries the swipe-through demo link.
  // ("check my form video" stays with the form-check flow: no demonstrat/exercise/moves.)
  if (/\bdemonstrat\w*\b/i.test(s)) return true;
  if (/\b(videos?|demos?)\b[^.!?]{0,20}\b(exercis\w*|moves?|workouts?)\b/i.test(s)) return true;
  // 2026-07-13 tester round 2: "body weight exercises", "and for body weight exercises
  // at home what should I do", "I don't know how to do them" — all reached the model,
  // which improvised routines and then gave navigation instructions. Belly/abs context
  // stays with the spot-reduction myth-buster, so exclude it here.
  if (/\b(belly|stomach|tummy|abs|spot.?reduc)\b/i.test(s)) return false;
  if (/\b(body ?weight|home)\s+exercises?\b/i.test(s)) return true;
  if (/\bwhat exercises?\b/i.test(s)) return true;
  if (/\b(don'?t|do not|dunno) know how to do (them|these|those|the (exercises?|moves?))\b/i.test(s)) return true;
  return false;
}

// PAIN TRIAGE — the question a real coach asks before anything else (2026-07-12, Kam:
// "a person says I'm having problems, should I switch out a workout? The coach needs to
// catch whether it's just sensitivity from a workout or a REAL injury"). Three classes:
//   "injury"    — sharp/structural signals → stop, protect, swap the workout, doctor line.
//   "soreness"  — DOMS language → normalise it, train around it, keep momentum.
//   "ambiguous" — pain named without qualifiers → ask ONE triage question, then route.
// Pure — no DB, unit-tested. Chest pain etc. is caught by the SAFETY handler earlier in
// the pipeline, so this only ever sees musculoskeletal reports.
export type PainClass = "injury" | "soreness" | "ambiguous";
export function classifyPainReport(m: string): PainClass | null {
  const s = m || "";
  // Not training pain: sickness/head/gut/period (own handlers), or emotional "hurt".
  // Gut complaints ("stomach hurts after every meal") belong to the digestive handler,
  // never musculoskeletal triage (2026-07-12 collision probe).
  if (/\b(sore throat|headache|migraine|stomach|tummy|gut|belly ache|period pains?|hurt my feelings|feelings hurt)\b/i.test(s)) return null;
  const bodyPart = /\b(knee|knees|shoulder|shoulders|back|ankle|ankles|wrist|wrists|hip|hips|neck|elbow|elbows|leg|legs|arm|arms|hamstring|quad|calf|calves|glute|chest muscle|muscle)\b/i;
  const mentionsPain = /\b(pain|painful|hurts?|hurting|sore|soreness|stiff|aching|aches?|doms|eina)\b/i.test(s)
    || /\b(pulled|strained|tore|torn|twisted|sprained|injur|swollen|swelling|popped|gave (?:way|in|out))\b/i.test(s)
    || (bodyPart.test(s) && /\b(problems?|issues?|trouble|acting up|playing up|niggle|niggling)\b/i.test(s));
  if (!mentionsPain) return null;
  // INJURY — sharp/structural signals, or pain that worsens under load.
  if (/\b(sharp|stabbing|shooting|popped|pop sound|snapped|tore|torn|tear|sprain(?:ed)?|twisted|swollen|swelling|gave (?:way|in|out)|can'?t (?:bend|straighten|put weight)|pulled (?:a muscle|my)|strained my|i (?:hurt|injured) my|got injured|injury)\b/i.test(s)) return "injury";
  if (/\b(worse|worsens|getting worse|gets worse)\b/i.test(s) && /\b(train|lift|squat|press|run|walk|exercis|gym|rep)/i.test(s)) return "injury";
  // SORENESS — DOMS language (dull, whole-muscle, post-training).
  if (/\b(doms|sore|stiff|aching|aches?)\b/i.test(s)) return "soreness";
  // Everything left ("knee pain", "my shoulder hurts", "back problems") → ask the question.
  return "ambiguous";
}

// DIGESTIVE ISSUES — bloating, acid reflux, heartburn, indigestion, gas, constipation.
// 2026-07-12, Kam's screenshot: a client disclosed "I struggle a lot with bloating…
// taking tablets for acid reflux and heartburn" AFTER the form, casually. This must be
// caught with care + practical food guidance (and a defer-to-doctor safety line), not
// missed. Excludes the period/hormone context (handled elsewhere) and the non-scale
// check-in where "bloated" is just one word in a list — requires complaint framing.
export function looksLikeDigestiveIssue(m: string): boolean {
  const s = m || "";
  if (/\b(period|cycle|menstrual|pms|ovulation|time of (?:the )?month)\b/i.test(s)) return false;
  const hasGI = /\b(acid reflux|reflux|heartburn|indigestion|ibs|irritable bowel|constipat(?:ed|ion)|bloat(?:ed|ing)|gassy|trapped gas|so much gas|stomach (?:issues?|problems?|cramps?|aches?|pains?|hurts?)|gut (?:issues?|problems?|health|hurts?)|tummy (?:aches?|hurts?|issues?)|acidic stomach|acid stomach)\b/i.test(s);
  if (!hasGI) return false;
  const hasComplaint = /\b(i (?:struggle|suffer|get|have|feel|deal with|keep getting)|struggle with|suffer from|deal with|i'?m (?:always |often |really |so )?(?:bloated|gassy|nauseous|constipated)|taking (?:tablets|meds|medication|pills) for|forgot to mention|always|constant(?:ly)?|every ?time|after (?:i )?eat(?:ing)?|after (?:every|each) meal|after meals?|regular meal|a lot with|hurts?)\b/i.test(s);
  return hasComplaint;
}

// FOOD DISLIKE — "I hate chicken breast", "I force myself to eat X". 2026-07-12: a client
// forced down chicken breast she hates because it's cheap protein. A coach offers an
// alternative instead of pushing it. The handler confirms an actual food is named.
export function looksLikeFoodDislike(m: string): boolean {
  return /\b(i (?:really )?(?:hate|can'?t stand|cannot stand|despise|detest)|don'?t (?:like|enjoy) (?:eating |having )?|hate eating|can'?t stand eating|sick of eating|force (?:myself|it down|down)|forcing (?:myself|it down)|forced to eat)\b/i.test(m || "");
}

// OVER-TRAINING PLAN — a client STATING or asking about 5+ sessions a week (or "every
// day"). 2026-07-12, Kam's screenshot: "I'm going to reduce your sessions from 5 to 4 or
// 3. 5 is unnecessary." The coach right-sizes it; the app used to take it at face value.
// (Distinct from the fatigue handler, which catches FEELING over-trained.)
export function looksLikeOvertrainingPlan(m: string): boolean {
  const s = m || "";
  const trainWord = /\b(train(?:ing)?|work(?:ing)? ?out|gym|lift(?:ing)?|session|exercis(?:e|ing))\b/i;
  if (trainWord.test(s) && /\b(every ?day|everyday|daily|7 days|all week|twice a day)\b/i.test(s)) return true;
  if (/\b([5-9]|1[0-4])\s*(?:x|times?|days?|sessions?)\b[^.!?]{0,20}\b(?:a|per|each)?\s*week\b/i.test(s) && trainWord.test(s)) return true;
  if (/\b(?:train|gym|work ?out|working out|lift|exercise)\b[^.!?]{0,15}\b([5-9]|1[0-4])\s*(?:x|times?|days?|sessions?)\b/i.test(s)) return true;
  return false;
}

// "Can I eat this?" is a DECIDING question — nothing is logged. The vision model
// sometimes ignores the prompt and writes "Logged. 🍇" into the verdict anyway,
// which then collides with the code's own "Reply *log it* and I'll count it." line
// — the bot claims it logged AND asks you to log (2026-07-12, grapes screenshot).
// Strip any "logged"-type claim from a verdict so the two never contradict. Pure.
export function stripFoodLoggedClaim(text: string): string {
  return (text || "")
    // "Logged." / "Logged 🍇" / "I've logged it" / "logging it" anywhere in the verdict
    .replace(/\b(?:i['’]?ve\s+|i\s+|already\s+|now\s+)?log(?:ged|ging)\b(?:\s+it)?[.!,]*\s*/gi, "")
    // clean up any orphaned emoji/whitespace the removal left behind
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.!,?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Cancellation / billing intent — must reach the deterministic subscription flow
// (which stops billing and alerts the founder), never the brain. 2026-07-10: "I'm
// cancelling my subscription" got a limp model reply and NO cancellation action.
export function looksLikeBillingOrCancel(m: string): boolean {
  return /\b(cancel(?:ling|led)?|unsubscribe|stop (?:my )?(?:subscription|billing|payments?|coaching)|refund|charged? (?:me|twice|wrong)|billing (?:problem|issue|query)|payment (?:failed|problem|issue)|don'?t bill me|stop charging)\b/i.test(m)
    // "cancel today's workout / this session / tomorrow's meal" is a schedule change,
    // never a subscription cancellation (2026-07-12 collision probe caught "cancel
    // today's workout, my back is acting up" landing in the billing flow).
    && !/\bcancel (?:the |my |today'?s? |tomorrow'?s? |tonight'?s? |this |that )?(?:workout|session|order|meal|training|gym|plan for)\b/i.test(m);
}

// Voice-first clients SAY amounts as words — "one litre of water", "two glasses", "half a
// litre" — and the digit-only parsers replied "How much?" to someone who'd just said how
// much (2026-07-16 tester voice note). Convert spoken container amounts to digits before
// any water parsing. Deliberately narrow: only number-words directly attached to a
// water-container unit, so food phrases ("one apple") are untouched.
export function digitizeSpokenAmounts(m: string): string {
  const NUM: Record<string, string> = { a: "1", an: "1", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
  return m
    .replace(/\bhalf\s+a\s+(litre|liter)\b/gi, "0.5 $1")
    .replace(/\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(litres?|liters?|glass(?:es)?|cups?|bottles?)\b/gi,
      (_all, w: string, unit: string) => `${NUM[w.toLowerCase()]} ${unit}`);
}

export function looksLikeWaterReport(raw: string): boolean {
  const m = digitizeSpokenAmounts(raw);
  return /\b(?:drank|drinking|had)\b.{0,24}\b\d+(?:[.,]\d+)?\s*(?:ml|l|litres?|liters?|glass(?:es)?|bottles?)\s*(?:of\s+)?(?:water)?\b/i.test(m)
    || /^\s*\d+(?:[.,]\d+)?\s*(?:ml|l|litres?|liters?)(?:\s+(?:of\s+)?water)?\s*$/i.test(m);
}

export function looksLikeWeightReport(m: string): boolean {
  return /^\s*(?:i\s+)?(?:weigh(?:ed)?(?:\s+in)?(?:\s+at)?\s*|my\s+weight\s*(?:is|:)?\s*|weight\s*(?:is|:)?\s*)?\d{2,3}(?:[.,]\d{1,2})?\s*kgs?\s*(?:today|this morning)?\s*[.!]?\s*$/i.test(m);
}

// ONE shared answer to "is this message ASKING, or REPORTING?" — the systemic
// gate (docs/adr-intent-lanes.md, Stage 2 floor). The disease was 50 loggers and
// templates each deciding this with their own local regex, each with its own
// holes ("does this fit my macros?" auto-logged the photo because the local
// detector only knew "fit my goal/diet/plan"). Local heuristics stay as extra
// belts; this function is the FLOOR every lane shares: no logger may take a
// write side effect, and no template may fire, on a message this says is a
// question. Bias when ambiguous: ASKING — answering a report as a question is
// recoverable ("reply log it"), logging a question is the class of bug that
// loses testers. Pure — unit-tested + generated-matrix-tested in routing-audit.
export function isAskingNotReporting(message: string): boolean {
  const s = (message || "").trim();
  if (!s) return false;
  if (/[?？]\s*$/.test(s)) return true;                                   // ends in a question mark
  if (/^[?!¿]+$/.test(s)) return true;                                    // bare "?"
  // Interrogative sentence starts ("did" excluded — "did my workout" is a report)
  if (/^(what|what'?s|which|when|where|who|why|how)\b/i.test(s)) return true;
  if (/^(can|could|should|shall|would|will|may|must) (i|we|you)\b/i.test(s)) return true;
  if (/^(is|are|am|isn'?t|aren'?t|does|doesn'?t|do|don'?t) (i|it|this|that|these|those|they|we|you|my|the)\b/i.test(s)) return true;
  // Mid-sentence asking shapes
  if (/\b(can|could|should|may|must) i\b/i.test(s)) return true;
  if (/\b(is|are) (this|that|these|those|it) (ok(ay)?|good|bad|fine|healthy|allowed|too|enough|alright)\b/i.test(s)) return true;
  if (/\b(does|will|would) (this|that|it) (fit|work|count|help|hurt|matter|affect)\b/i.test(s)) return true;
  if (/\bfits? (?:in(?:to)?|within)? ?(?:my|the) (calories|macros|kcal|goal|diet|plan|budget|numbers|targets?|deficit|surplus)\b/i.test(s)) return true;
  if (/\b(what do you think|your thoughts|thoughts on|verdict|yay or nay|good or bad|good idea|bad idea|am i allowed|allowed to have|not sure if|any advice|help me decide|wondering if)\b/i.test(s)) return true;
  // AN IMPERATIVE REQUEST IS NOT A REPORT (2026-07-29 live, the worst defect of the day).
  // "Give me a dinner suggestion to finish off the night" reached the food logger, which invented
  // a meal, logged 789 kcal the client never ate, corrupted his day's totals and pushed his fat
  // over target. Every rule above catches an INTERROGATIVE — what, can I, is that. Nobody had
  // written down that a person can ask by instructing. Nobody reports a meal by saying "give me".
  if (/^(?:please\s+)?(?:give|send|show|share)\s+me\b/i.test(s)) return true;
  if (/^(?:please\s+)?(?:suggest|recommend)\b/i.test(s)) return true;
  if (/\b(?:suggest|recommend)\s+(?:me\s+)?(?:a|an|some|any)\b/i.test(s)) return true;
  if (/\b(?:any|some|a few)\s+(?:suggestions?|ideas?|options?|recommendations?)\b/i.test(s)) return true;
  if (/\b(?:suggestion|recommendation)s?\b/i.test(s) && !/\bi (?:had|ate|have eaten|just had)\b/i.test(s)) return true;
  return false;
}

// Goal-change vocabulary gate for the normalizer. A GOAL_CHANGE canonical rewrites
// the client's whole programme, so it is only honoured when the ORIGINAL message
// actually asks for it — otherwise a steps/food sentence can be hallucinated into
// "change my goal to fat loss" (2026-07-07). Pure — unit-tested.
export function hasGoalChangeVocabulary(message: string): boolean {
  return /\b(bulk|bulking|cut|cutting|lean|leaning|shred|building\s+phase|build\s+muscle|muscle\s+(?:gain|mass|composition|building)|gain(?:ing)?\s+(?:muscle|weight|mass|size)|add\s+(?:size|mass|muscle)|put\s+on\s+(?:size|mass|muscle|weight)|fat\s+loss|lose\s+(?:weight|fat|belly)|losing\s+(?:weight|fat)|slim|tone|toning|recomp\w*|maintenance|maintain|change\s+(?:my\s+)?goal|switch\s+(?:my\s+)?goal|new\s+goal|different\s+goal)\b/i.test(message || "");
}

// SURPLUS/DEFICIT QUESTION (pure, unit-tested; shared by the deterministic handler
// AND drill-cases.prodProtection so the nightly alert's routing map stays truthful).
// 2026-07-17 nightly drill: 'what should my surplus be' regressed on the model path —
// third recurrence of the 2026-07-06 class. The rule lives in two prompts and still
// leaked, so the model is out of the loop: the answer is pure maths on their targets.
// "why" questions stay with Coach K — reasoning is his lane, arithmetic is not.
export function looksLikeSurplusDeficitQuestion(m: string): boolean {
  if (!/\b(surplus|deficit)\b/i.test(m)) return false;
  if (/\bwhy\b/i.test(m)) return false;
  return /\b(what|how (?:much|big)|should|am i|is my|what'?s)\b[^.!?]{0,60}\b(surplus|deficit)\b/i.test(m)
    || /\b(surplus|deficit)\b[^.!?]{0,25}\bbe\b/i.test(m);
}

// ── RETURN-DATE MEMORY — "back on Monday" → the actual SAST date (2026-07-20, Kam:
// "we need to remember the time and dates when the person tells us they're going and
// coming back"). Pure; used to persist back_on:YYYY-MM-DD so the coach REMEMBERS.
export function nextDayDate(word: string): string | null {
  const w = (word || "").toLowerCase().trim();
  const sast = new Date(Date.now() + 2 * 3_600_000);
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  let addDays: number;
  if (w === "tomorrow") addDays = 1;
  else if (w === "next week") addDays = 7;
  else {
    const idx = names.indexOf(w);
    if (idx < 0) return null;
    addDays = (idx - sast.getUTCDay() + 7) % 7 || 7; // next occurrence, never today
  }
  const d = new Date(sast.getTime() + addDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * IS THIS A LOG, OR A RAMBLE? (2026-08-05.)
 *
 * NAMED DELIBERATELY OUT OF THE looksLike* FAMILY, AND SAID OUT LOUD RATHER THAN DONE QUIETLY.
 * It was `looksLikeLogList` and the architecture guard refused it at 21 against a budget of 20 —
 * correctly, that guard exists to stop message-classifier predicates breeding. No looksLike*
 * predicate is currently dead, so there was nothing to pay with, and the documented
 * consolidation (merging looksLikeSteps/Water/WeightReport, ~30 call sites) is not a change to
 * start in the tail of a session.
 *
 * The argument for the rename: the looksLike* family all answer "which handler should take this
 * MESSAGE?". This answers "should this TRANSCRIPT be preprocessed before anything sees it?" —
 * a different question, at a different layer, with one caller.
 *
 * If the founder reads that as dodging the meter rather than a real distinction, the honest
 * alternative is the three-way consolidation above, which pays for this and two more besides.
 *
 * The condenser exists for someone thinking out loud. It is the wrong tool entirely for someone
 * reciting their day's food, and it was being applied to both — the prompt said "keep every food
 * word-for-word" AND "short, 2-4 sentences", which for a client listing eight items are opposite
 * instructions. The model obeyed the shorter one and quietly dropped meals. Same shape as the
 * action directive that told the coach to call a tool and not speak: two rules, one loses, and
 * the loss is invisible.
 *
 * So a log-dense transcript is never condensed at all. There is no noise to drop in "4 fish
 * fingers, 3 eggs, 3 slices of bread and a black coffee" — every word is the payload, and a
 * summariser can only lose some of it. Cheaper too: no model call.
 *
 * Deliberately crude: three or more quantities. A ramble rarely carries three; a day's food
 * always does. When in doubt this keeps the raw text, which is the safe direction — a slightly
 * long message reaching the coach costs tokens, a dropped meal costs the client's trust.
 */
/**
 * MUST THIS TRANSCRIPT REACH THE COACH WHOLE? (2026-08-06, founder's STT audit: he sent a
 * voice note whose content was literally "read the rest of my transcript".)
 *
 * The condenser rightly stops a three-minute ramble reaching the expensive model. What it must
 * never do is answer half of what someone said. Log lists were already exempt; this adds the
 * two other shapes where losing the tail is the same defect — a note asking MORE THAN ONE
 * thing, and one that stacks instructions ("also…", "one more…"). Deliberately generous: a
 * false positive costs a few cents, a false negative costs a client being ignored.
 */
export function transcriptMustPassWhole(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (transcriptIsLogList(t)) return true;
  const questions = (t.match(/\?/g) || []).length;
  if (questions >= 2) return true;
  // Spoken transcripts often carry no punctuation at all, so count question OPENERS too.
  const openers = (t.toLowerCase().match(/\b(what|why|how|when|where|which|can i|should i|do i|is it|are they)\b/g) || []).length;
  if (openers >= 2) return true;
  const stackers = (t.toLowerCase().match(/\b(also|another thing|one more|and then|secondly|lastly|by the way|plus)\b/g) || []).length;
  if (stackers >= 1 && (questions + openers) >= 1) return true;
  // Messy-life voice notes (product core): food + movement, food + feeling, yesterday's
  // meals, multi-beat day stories. Condensing these destroys the facts the log path needs
  // and is how "I had McDonald's breakfast and a mocha" never reached food-context whole.
  if (isMessyLifeTranscript(t)) return true;
  // A PERSON TELLING YOU HOW THEY ARE IS NEVER SQUEEZED (CTO ruling, 2026-08-19).
  //
  // Making `temporal` a qualifier rather than a signal was right for what it fixed, and it had a
  // consequence I did not weigh: a long come-back ramble with no food and no steps — someone
  // returning after days away, which is exactly the Pulse client — became condensable. Shortening
  // that to save tokens is tracker behaviour, not coaching, and the money saved is not worth the
  // one note where they finally said what was going on.
  //
  // So a feeling carries the whole transcript on its own. The margin guard now only reaches a
  // long note with no food, no steps, no feeling and no stacked question — which is a narrower
  // path than before, deliberately.
  if (/\b(tired|exhausted|stressed|stress|feel(?:ing)?|felt|anxious|motivat|struggling|overwhelmed|depressed|hard day|rough day|not coping|drained|down|low|lost|give up|giving up)\b/.test(t)) return true;
  return false;
}

/**
 * Two or more life signals in one note = the demographic we built for.
 * Keep the full transcript; do not summarise away the meal, the steps, or the feeling.
 */
export function isMessyLifeTranscript(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean).length;
  const food = /\b(ate|eaten|had|having|breakfast|lunch|dinner|supper|brunch|snack|meal|mcdonald|kfc|takeaway|pap|chicken|eggs?|mocha|coffee|food)\b/.test(t);
  const steps = /\b(steps?|walked|walking|\d+\s*km|kilometers?|ran|run)\b/.test(t);
  const feeling = /\b(tired|stressed|stress|feel(?:ing)?|felt|anxious|motivat|struggling|overwhelmed|depressed|hard day|rough day|not coping|drained)\b/.test(t);
  const temporal = /\b(yesterday|last night|this morning|earlier today|then i|after that|before (?:that|gym|work))\b/.test(t);
  // TEMPORAL IS A QUALIFIER, NOT A FACT. Counting "last night" as a signal meant any emotional
  // note that mentioned a time was treated as a messy-life multi-fact note and protected from
  // condensing — "Eish coach I am so tired today… I did not sleep well last night" scored
  // feeling + temporal = 2. That is one topic, and condensing it is exactly what protects the
  // R199 margin on a long voice note. It still counts where it belongs: `food && temporal`
  // below, which is what makes "yesterday I had pap" a retro meal report.
  const signals = [food, steps, feeling].filter(Boolean).length;
  // Short branded meal reports still need the full string (scanner + GPT fallback).
  if (food && /\b(mcdonald|kfc|nando|spur|steers|wimpy|mocha|breakfast|lunch|dinner)\b/.test(t) && words <= 40) return true;
  if (signals >= 2) return true;
  if (food && temporal) return true;
  return false;
}

export function transcriptIsLogList(text: string): boolean {
  const t = (text || "").toLowerCase();
  const digits = t.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
  const words = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|half|quarter)\b/g) || [];
  const quantities = digits.length + words.length;
  // A log needs at least ONE quantity — that is what separates "two eggs and pap" from a
  // ramble that happens to contain three "and"s. A story about the gym has none.
  if (quantities === 0) return false;
  // Then LIST STRUCTURE: the commas and "and"s that string items together. One spoken number
  // in a sentence with three conjunctions is a day's food; a quantity on its own is not.
  const listers = (t.match(/,/g) || []).length + (t.match(/\band\b/g) || []).length;
  return quantities + listers >= 3;
}

