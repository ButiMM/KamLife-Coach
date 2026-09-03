import OpenAI from "openai";
import { readHealthState } from "./health-state";
import { db, recordedIntent } from "./db";
import { users, chatHistory, weightLogs, stepLogs, workoutLogs, mealLogs, gptCosts } from "../shared/schema";
import { eq, desc, and, gte, lt, sql } from "drizzle-orm";
import { COACH_K_SYSTEM } from "./coach-prompt";
import { getPhaseNames } from "./programme";
import { calculateTargets } from "./targets";
import { getDisplayName, sastDayStart, findFabricatedComposites, findUngroundedFoodItems } from "./utils";
import { patternCache, PATTERN_CACHE_TTL_MS } from "./cache";
import { getClientNarrative } from "./intelligence/profile";
import { verifyBrainReply } from "./brain/reply-verifier";
import { weightInContextLine } from "./weight-context";
import { getWeightTruth, sastDayBucketSql } from "./day-ledger";
import { captureQualitySignal } from "./quality-signals";
import { verifyMealEstimate } from "./verifiers/meal-verifier";
import { assertAiOnline, isAiOfflineError } from "./ai-offline";
import type { VoiceEmotion } from "./elevenlabs";

// ============================================================
// CONCURRENCY LIMITER — max 25 simultaneous OpenAI calls. Prevents thundering-herd
// when 100s of messages arrive at once; callers beyond the limit wait in line.
// ============================================================
let _openaiSlots = 25;
const _openaiQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (_openaiSlots > 0) { _openaiSlots--; return Promise.resolve(); }
  return new Promise(resolve => _openaiQueue.push(resolve));
}
function releaseSlot(): void {
  const next = _openaiQueue.shift();
  if (next) { next(); } else { _openaiSlots++; }
}

// ============================================================
// EXPONENTIAL BACKOFF WRAPPER — retries on OpenAI 429 rate limits
// Wrapped inside concurrency limiter so max 25 calls run at once.
// ============================================================
async function withOpenAIRetry<T>(fn: () => Promise<T>, label = "openai"): Promise<T> {
  assertAiOnline(label); // offline test mode: throw instantly so the caller's fallback fires (no network, no backoff)
  await acquireSlot();
  try {
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const status = err?.status ?? err?.statusCode ?? 0;
        const msg = (err?.message ?? "").toLowerCase();
        const isRateLimit = status === 429 || msg.includes("rate limit") || msg.includes("quota");
        if (!isRateLimit || attempt === MAX_RETRIES) throw err;
        const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.warn(`[${label}] rate-limited — retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw new Error("unreachable");
  } finally {
    releaseSlot();
  }
}

const openai = new OpenAI({
  // Prevent startup crash when env key is absent; request-time handling returns safe fallbacks.
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-missing-key",
});

// ── Prompt-injection sanitiser for user-supplied free-text fields ──
// A user who types "ignore previous instructions" in their name/injury field could corrupt
// the system prompt. We neutralise common injection patterns and cap length (defence-in-depth).
export function sanitizeProfileField(v: string | null | undefined, maxLen = 200): string {
  if (!v) return "";
  let s = v
    .slice(0, maxLen * 2)             // trim before heavy work
    .replace(/\r?\n|\r/g, " ")        // collapse newlines to spaces (breaks multi-line injection)
    .replace(/\t/g, " ")
    .replace(/\s{2,}/g, " ")          // collapse repeated whitespace
    .trim()
    .slice(0, maxLen);
  // Neutralise the most common prompt-injection openers
  const injectionPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions?/gi,
    /disregard\s+(all\s+)?previous\s+instructions?/gi,
    /forget\s+(all\s+)?previous\s+instructions?/gi,
    /you\s+are\s+now\s+a\s+/gi,
    /act\s+as\s+(if\s+)?/gi,
    /system\s*:/gi,
    /assistant\s*:/gi,
    /\[INST\]/gi,
    /<\|im_start\|>/gi,
  ];
  for (const re of injectionPatterns) {
    s = s.replace(re, "[filtered]");
  }
  return s;
}

// ── Per-call GPT cost recorder (fire-and-forget; prices per 1M tokens USD, mid-2025) ──
const GPT_PRICE_PER_1M: Record<string, { prompt: number; completion: number }> = {
  "gpt-4o":           { prompt: 2.50,  completion: 10.00 },
  "gpt-4o-mini":      { prompt: 0.15,  completion: 0.60  },
  "gpt-4o-2024-11-20":{ prompt: 2.50,  completion: 10.00 },
  "gpt-4o-mini-2024-07-18": { prompt: 0.15, completion: 0.60 },
};

export function recordGptCost(opts: {
  userId?: string | null;
  model: string;
  feature?: string;
  promptTokens: number;
  completionTokens: number;
}): void {
  const { userId, model, feature, promptTokens, completionTokens } = opts;
  const prices = GPT_PRICE_PER_1M[model] ?? GPT_PRICE_PER_1M["gpt-4o-mini"];
  const costUsd = (promptTokens * prices.prompt + completionTokens * prices.completion) / 1_000_000;
  db.insert(gptCosts).values({
    userId: userId ?? null,
    model,
    feature: feature ?? null,
    promptTokens,
    completionTokens,
    costUsd: costUsd.toFixed(6),
  }).catch(e => console.warn("[gptCosts] insert failed (non-fatal):", e?.message || e));
}

export async function buildContext(user: any): Promise<string> {
  // Sanitize all free-text user fields before they enter the system prompt.
  const name = sanitizeProfileField(getDisplayName(user)) || "a client";
  const goal = user.goalType || "general fitness";
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const steps = user.stepsTarget || 8500;
  // Fix 2 — always use live-calculated targets so GPT sees correct numbers even if DB is stale
  const weight = parseFloat(user.currentWeight || "75");
  const liveTargets = calculateTargets(weight, goal, user.lifeSituation || "office", user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, user.heightCm || 170, user.trainingExperience || "beginner");
  const calories = liveTargets.calorieTarget;
  const protein = liveTargets.proteinTarget;
  const mode = user.trainingMode || "home";
  const equipment = user.homeEquipment || "none";
  const situation = user.lifeSituation || "";
  const job = user.jobType || "";
  const activity = user.activityLevel || "";
  const focus = sanitizeProfileField(user.primaryFocusArea) || "";
  const injuries = sanitizeProfileField(user.injuries) || "none";
  const age = user.age || 30;
  const water = user.todayWater || 0;
  const experience = user.trainingExperience || "beginner";

  const medicalConditions = sanitizeProfileField(user.medicalConditions) || "none";
  const hasMedical = medicalConditions !== "none" && medicalConditions.trim() !== "";
  const medicalDisclaimer = hasMedical
    ? `\nMEDICAL NOTE: This client has: ${medicalConditions}. When giving condition-specific advice (diet, exercise modification, medication timing), ALWAYS end with a one-sentence reminder to consult their doctor or healthcare provider for personalised medical guidance. Never diagnose, never contraindicate prescribed medication, never tell them to stop medication.`
    : "";

  // Age-derived coaching tone and safety flags
  // ONE SOURCE PER FACT, IN THE MODEL'S CONTEXT TOO (2026-08-21). Fixing the deterministic
  // replies was only half of it: this block handed the model `totalWorkoutsCompleted` (the
  // users-row counter, which drifts from workoutLogs), a day count anchored to `createdAt` while
  // everything else anchors to `programmeStartDate`, and TWO week numbers that mean different
  // things under labels that read as the same thing. A model given contradictory facts can
  // manufacture the contradiction back out — which is how "Day 35, week 1" was born.
  const { daysOnProgramme: daysOn } = await import("./day-ledger-core");
  const daysOnProgramme = daysOn(user);
  const weeksOnProgramme = Math.max(1, Math.floor(daysOnProgramme / 7));
  const sessionsLifetime = await (async () => {
    try {
      const { db } = await import("./db");
      const { workoutLogs } = await import("../shared/schema");
      const { eq, and, sql: s2 } = await import("drizzle-orm");
      const [row] = await db.select({ n: s2<number>`COUNT(*)::int` }).from(workoutLogs)
        .where(and(eq(workoutLogs.userId, user.id), eq(workoutLogs.workoutCompleted, true)));
      return Number((row as any)?.n || 0);
    } catch { return 0; }
  })();
  const isYouth = age < 18;
  const isElderly = age >= 60;
  const gender = user.gender || "unknown";

  // Coaching maturity — how Coach K talks to this client based on how long they've been around
  let coachingTone = "";
  if (daysOnProgramme <= 7) {
    coachingTone = "NEW CLIENT (week 1): Be encouraging, explain everything simply, celebrate small wins. Don't overwhelm. This person is building trust with you.";
  } else if (daysOnProgramme <= 21) {
    coachingTone = "BUILDING PHASE (weeks 2-3): The danger zone. Motivation drops. Be direct, acknowledge it's hard, but remind them WHY they started. Reference any progress.";
  } else if (daysOnProgramme <= 56) {
    coachingTone = "HABIT FORMING (weeks 4-8): Habits are setting in. Push harder. Challenge them. Start expecting more. Reference their streak and consistency.";
  } else {
    coachingTone = "VETERAN (8+ weeks): This client is committed. Talk to them as a peer. Set bigger goals. Reference their journey. They've earned real coaching.";
  }

  // Age-specific coaching guidelines
  let ageGuidelines = "";
  if (isYouth) {
    ageGuidelines = "YOUTH CLIENT (under 18): Use energetic, fun language. No heavy 1RM lifts — focus on form, bodyweight, and building habits. Celebrate effort over results. Never body-shame. Frame everything as 'getting stronger' not 'losing weight'. Use slang naturally (sharp, eish, let's go).";
  } else if (isElderly) {
    ageGuidelines = "SENIOR CLIENT (60+): Respectful but not patronizing. Joint-friendly alternatives for every exercise. Emphasize mobility, balance, and independence. Lower impact cardio. Always remind to listen to their body. Never push through pain. Warm-up is mandatory, not optional.";
  } else if (age >= 40) {
    ageGuidelines = "40+ CLIENT: Recovery matters more. Warm-ups are essential. Mention joint care when relevant. Don't assume they can't perform — many are at their strongest. Respect their time constraints.";
  }

  // Store tier — derived from weeklyFoodBudget so meal suggestions match where they shop
  const budgetRaw = user.weeklyFoodBudget || "100_300";
  const storeTier =
    ["under_100", "under_50", "50_100", "100_300"].includes(budgetRaw)
      ? "Shoprite/Boxer (budget R100–R300/week)"
      : budgetRaw === "300_600"
      ? "Pick n Pay/Checkers (budget R300–R600/week)"
      : "Woolworths/Checkers/Spar (budget R600+/week)";

  // Dietary restrictions from profileNotes (set during onboarding)
  const gptProfileNotes = (user.profileNotes || "").toLowerCase();
  const gptDietaryParts: string[] = [];
  if (gptProfileNotes.includes("diet:halal")) gptDietaryParts.push("HALAL (no pork, no alcohol in food — must be halal-certified)");
  if (gptProfileNotes.includes("diet:vegan")) gptDietaryParts.push("VEGAN (no meat, fish, eggs, or dairy — plant-based only: beans, lentils, tofu, soya mince, plant milk)");
  else if (gptProfileNotes.includes("diet:vegetarian")) gptDietaryParts.push("VEGETARIAN (no meat or fish — eggs and dairy are fine)");
  const dietaryContext = gptDietaryParts.length > 0
    ? `\nDietary restrictions: ${gptDietaryParts.join(", ")}. NEVER suggest foods that violate these restrictions — not even as an example or alternative.`
    : "";

  return `CLIENT PROFILE:\nName: ${name}\nGender: ${gender}\nGoal: ${goal}\nAge: ${age}\nPhase: ${phase} — ${phaseName}\nCalorie target: ${calories}\nProtein target: ${protein}g\nStep target: ${steps}\nTraining mode: ${mode}\nEquipment: ${equipment}\nLife situation: ${situation}\nJob type: ${job}\nActivity level: ${activity}\nPrimary focus: ${focus}\nInjuries: ${injuries}\nMedical conditions: ${medicalConditions}\nExperience: ${experience}\nWater today: ${water}L\nDays on programme: ${daysOnProgramme} (calendar week ${weeksOnProgramme} since they started)\nCompliance level: ${user.complianceLevel || 'RESET'}\nWorkout streak: ${user.workoutStreak || 0} consecutive sessions\nTotal sessions completed: ${sessionsLifetime} (counted from logged sessions)\nProgramme position: ${phaseName} phase, week ${user.programmeWeek || 1} OF THAT PHASE — this resets each phase and is NOT the calendar week above; never present the two as the same number\nSubscription status: ${user.subscriptionStatus || 'inactive'}\nShopping store tier: ${storeTier}${dietaryContext}\n\n${coachingTone}\n${ageGuidelines}${medicalDisclaimer}`;
}

// ============================================================
// SA CULTURAL & SEASONAL CONTEXT FLAGS
// ============================================================

export function getSAContextFlags(user?: any): string {
  const now = new Date(Date.now() + 2 * 3_600_000); // SAST — budget mode and month context must reflect SA calendar date
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const flags: string[] = [];

  if (day >= 20) {
    flags.push("BUDGET MODE ACTIVE: Date is after the 20th. Client may be tight on money. Only mention budget alternatives if the client brings up money or budget concerns. Do NOT assume everyone is broke — if they send a photo of steak, coach them on steak. Never downgrade their food choices unsolicited.");
  }

  // Fix 2 — Ramadan only activates on explicit user mention, never on calendar date alone
  const RAMADAN_KEYWORDS = ["ramadan", "ramadhan", "fasting", "iftar", "suhoor", "sehri", "muslim", "islam", "halaal", "halal"];
  const userNotes = ((user?.otherMedicalNotes || "") + " " + (user?.workSchedule || "")).toLowerCase();
  const userMentionsRamadan = RAMADAN_KEYWORDS.some(kw => userNotes.includes(kw));
  if (userMentionsRamadan) {
    flags.push("RAMADAN / FASTING ACTIVE: Client has indicated they are Muslim or fasting. Train only after Iftar. Suhoor is the most critical meal — high protein, slow carbs, water before Fajr. No training during fasting hours. Adjust all calorie and meal timing advice to the eating window only.");
  }

  const MONTHLY: Record<number, string> = {
    1:  "January — New year motivation is high but gyms are overcrowded. Set realistic first-month expectations. Focus on building sustainable habits not chasing rapid results. Beware over-commitment.",
    2:  "February — Valentine's Day body image pressure is real. Do not amplify comparison or appearance anxiety. Celebrate progress and strength. Acknowledge emotional eating triggers around this time.",
    3:  "March — Back to school means back to routine. Excellent month to restart lapsed clients. Routines are re-establishing — capitalise on the structure.",
    4:  "April — Easter weekend and braai season. Social eating is high risk. Protein-first strategy at any braai or family gathering. One training session over the long weekend minimum.",
    5:  "May — Workers Day. Autumn. Post-January-rush motivation slump common around now. Focus on consistency over intensity. Celebrate progress made since January.",
    6:  "June — Youth Day. Mid-year check-in. January starters are at programme halfway point — review what has changed and what needs adjustment.",
    7:  "July — School holidays. Routine disruption is real. Kids at home affects training time. Adapt to shorter sessions, home workouts, early mornings, or post-bedtime sessions.",
    8:  "August — Women's Month. Celebrate female clients specifically. Body positivity and strength messaging. No weight-focused language unless client initiates. Celebrate what the body can DO.",
    9:  "September — Spring in SA. Outdoor training season begins. Encourage park runs, outdoor sessions, Parkrun, walking with friends. Energy and motivation naturally higher.",
    10: "October — Walking and transport awareness month. Step count focus. Encourage getting off the taxi one stop early, taking the stairs, lunch walks.",
    11: "November — Year-end party season begins. Alcohol and social eating management. Help clients navigate office parties and year-end functions without derailing progress.",
    12: "December — Festive season. Maintenance mode only — do NOT set aggressive fat loss targets. Two rules: keep protein up and stay moving. Family time is not failure time. January is for reset.",
  };
  if (MONTHLY[month]) flags.push(MONTHLY[month]);

  if (month >= 5 && month <= 9) {
    flags.push("Load shedding risk: Winter months have historically high Eskom load shedding stages 4–6. Gyms may be without power. Always have a home workout alternative ready for every session.");
  }

  if (flags.length === 0) return "";
  return `SA CONTEXT FLAGS:\n${flags.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
}

// ============================================================ REAL-TIME AWARENESS — current SAST date, weekday, and time of day. Railway runs in UTC; SAST is
// UTC+2 with no daylight saving, so we shift the epoch by +2h and read the UTC fields as
// SAST wall-clock. Injected into every GPT path so the coach actually knows WHEN "now" is — morning vs
// midnight, weekday vs weekend, the real date — instead of guessing or sounding timeless. ============================================================
export function getNowContextSA(): string {
  const sast = new Date(Date.now() + 2 * 3_600_000);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const dow = sast.getUTCDay();
  const dayName = days[dow];
  const monthName = months[sast.getUTCMonth()];
  const date = sast.getUTCDate();
  const year = sast.getUTCFullYear();
  const hour = sast.getUTCHours();
  const hh = String(hour).padStart(2, "0");
  const mm = String(sast.getUTCMinutes()).padStart(2, "0");
  const isWeekend = dow === 0 || dow === 6;

  const period =
    hour >= 5 && hour < 12 ? "morning" :
    hour >= 12 && hour < 17 ? "afternoon" :
    hour >= 17 && hour < 21 ? "evening" : "night";

  const timeCue =
    period === "night"
      ? "It is late at night — do NOT tell them to go train now. If they have not eaten, suggest something light; otherwise focus on rest and setting up tomorrow."
      : period === "morning"
      ? "Morning — a natural time to set up the day: today's session, steps, and a protein-strong first meal."
      : period === "evening"
      ? "Evening — the day is closing. Check whether they trained, hit their protein, and moved today; coach the last meal accordingly."
      : "";

  return `RIGHT NOW (authoritative — never guess the date or time): It is ${dayName}, ${date} ${monthName} ${year}, ${hh}:${mm} (${period}) SAST — South Africa, UTC+2.${isWeekend ? " It is the weekend." : ""}${timeCue ? " " + timeCue : ""}`;
}

// ============================================================
// PATTERN SUMMARY — 7-DAY BEHAVIOUR ANALYSIS SENT WITH EVERY GPT CALL
// ============================================================

export async function buildPatternSummary(user: any): Promise<string> {
  const cacheKey = `pattern:${user.id}`;
  const cached = patternCache.get(cacheKey);
  if (cached) {
    console.log(`[PATTERN_CACHE] hit user=${user.id?.slice(-6)}`);
    return cached;
  }

  const name = getDisplayName(user) || "client";
  const proteinTarget = user.proteinTarget || 120;
  const programmeWeek = user.programmeWeek || 1;
  const today = new Date();
  // SAST-shifted copy for calendar-date checks (e.g. "after the 20th") — today itself
  // must stay raw/UTC since it also feeds sastDayStart(), which applies its own +2h shift.
  const todaySAST = new Date(today.getTime() + 2 * 3_600_000);
  const sevenDaysAgo = sastDayStart(new Date(today.getTime() - 7 * 86_400_000));
  const twentyEightDaysAgo = new Date(today.getTime() - 28 * 86_400_000);

  try {
    const [recentChats, recentWeights, monthWeights, recentSteps, monthWorkouts, monthProtein] = await Promise.all([
      db.select().from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), gte(chatHistory.createdAt, sevenDaysAgo)))
        .orderBy(desc(chatHistory.createdAt))
        .limit(100),
      // THE SCALE COMES FROM ITS OWNER (2026-08-25, P0-5). Two direct weight_logs reads used to
      // feed this straight into the model's context, neither asking do_not_mention. Why in
      // getWeightTruth; withheld yields no points, so the block below says "No weight data".
      getWeightTruth(user, { windowDays: 7 }).catch(() => null),
      getWeightTruth(user, { windowDays: 28 }).catch(() => null),
      db.select().from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo)))
        .orderBy(desc(stepLogs.loggedAt))
        .limit(7),
      // 28-day session count for trajectory scoring
      db.select({ count: sql<number>`COUNT(*)::int` })
        .from(workoutLogs)
        .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, twentyEightDaysAgo)))
        .catch(() => [{ count: 0 }]),
      // 28-day protein compliance. Day bucket from the owner — was DATE(), the UTC day (P0-5).
      db.select({
        day: sastDayBucketSql(mealLogs.loggedAt),
        total: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
      }).from(mealLogs)
        .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, twentyEightDaysAgo)))
        .groupBy(sastDayBucketSql(mealLogs.loggedAt))
        .catch(() => [] as { day: string; total: number }[]),
    ]);

    // Count only days the CLIENT actually spoke (messageIn present) — outbound-only proactive rows
    // have a null messageIn and must NOT count, else a silent client looks active and silence never fires.
    const daysWithLogs = new Set(
      recentChats.filter(c => (c.messageIn || "").trim()).map(c => new Date(new Date(c.createdAt || "").getTime() + 2 * 3_600_000).toLocaleDateString("en-ZA"))
    ).size;
    const daysSilent = 7 - daysWithLogs;

    const foodLogs = recentChats.filter(c => c.intent === "FOOD_LOG");
    let avgProtein: number | null = null;
    try {
      const dailyProtein = await db.select({
        day: sastDayBucketSql(mealLogs.loggedAt),
        protein: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
      })
        .from(mealLogs)
        .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, sevenDaysAgo)))
        .groupBy(sastDayBucketSql(mealLogs.loggedAt));
      const dailyTotals = dailyProtein.map(d => d.protein).filter(p => p > 0);
      if (dailyTotals.length >= 2) {
        avgProtein = Math.round(dailyTotals.reduce((a, b) => a + b, 0) / dailyTotals.length);
      }
    } catch (protErr) {
      console.warn("[PATTERN] meal log protein query failed:", protErr);
    }

    const allIn = recentChats.map(c => (c.messageIn || "").toLowerCase()).join(" ");

    const BUDGET_WORDS = ["broke", "no money", "can't afford", "cannot afford", "no cash", "eina the money", "month end", "no food money", "tight on", "struggling financially"];
    const HARD_WORDS = ["too hard", "too difficult", "can't do it", "cannot do it", "killing me", "giving up", "want to quit", "want to stop", "too tough", "it's too much"];
    const EASY_WORDS = ["too easy", "not challenging", "too light", "too simple", "boring"];
    const PAIN_WORDS = ["pain", " hurts", "so sore", "soreness", "injured", "bad knee", "bad back", "bad shoulder", "hip pain", "knee pain", "back pain", "aching", "inflamed"];
    const STRESS_WORDS = ["stressed", "anxious", "anxiety", "depressed", "depression", "overwhelmed", "so tired", "exhausted", "family problem", "relationship problem", "work pressure", "difficult time", "struggling emotionally", "not okay", "hard time"];

    const mentionedBudget = BUDGET_WORDS.some(w => allIn.includes(w));
    const mentionedTooHard = HARD_WORDS.some(w => allIn.includes(w));
    const mentionedTooEasy = EASY_WORDS.some(w => allIn.includes(w));
    const mentionedPain = PAIN_WORDS.some(w => allIn.includes(w));
    const mentionedStress = STRESS_WORDS.some(w => allIn.includes(w));

    const DONE_PATTERN = /^(done|workout done|finished|completed)$/;
    const trainingLogs = recentChats.filter(c =>
      DONE_PATTERN.test((c.messageIn || "").toLowerCase().trim()) || c.intent === "WORKOUT_LOG"
    );
    const lastTraining = trainingLogs[0];
    const daysSinceTraining = lastTraining?.createdAt
      ? Math.floor((Date.now() - new Date(lastTraining.createdAt).getTime()) / 86_400_000)
      : null;

    // WEIGHT IN CONTEXT (2026-07-22): bare "up 1.3kg this week" was the intelligence gap —
    // no attribution to WHEN the weight moved or the client's STATE. Engine in weight-context.ts.
    const restingNow = readHealthState(user).isSick;
    // `points` is oldest-first from the owner; weightInContextLine took newest-first rows.
    const monthPoints = [...(monthWeights?.points ?? [])].reverse();
    let weightTrend = weightInContextLine({
      goalType: user.goalType,
      weighIns: monthPoints.map(p => ({ weight: p.kg, at: p.at })),
      resting: restingNow,
    });
    if (!weightTrend) {
      const latest7 = recentWeights?.currentKg;
      weightTrend = latest7 != null
        ? `Weight logged: ${latest7}kg — no trend yet.`
        : "No weight data this week.";
    }

    const parts: string[] = [
      `PATTERN CONTEXT: ${name} has logged ${daysWithLogs} of the last 7 days${daysSilent > 0 ? ` (${daysSilent} day${daysSilent > 1 ? "s" : ""} silent)` : ""}.`,
    ];

    if (avgProtein !== null) {
      const status = avgProtein >= proteinTarget
        ? `at or above target (avg ${avgProtein}g vs ${proteinTarget}g)`
        : `consistently under (avg ${avgProtein}g vs ${proteinTarget}g target)`;
      parts.push(`Average protein logged is ${status}.`);
    } else {
      parts.push(`Protein target is ${proteinTarget}g/day — tracking data limited this week.`);
    }

    if (mentionedBudget) parts.push("They mentioned being broke or tight on budget this week.");
    if (mentionedTooHard) parts.push("They mentioned the programme being too hard or wanting to quit.");
    if (mentionedTooEasy) parts.push("They mentioned the programme being too easy.");
    if (mentionedPain) parts.push("They mentioned pain or injury in the last 7 days.");
    if (mentionedStress) parts.push("They mentioned stress, work pressure, or emotional difficulty this week.");

    if (trainingLogs.length === 0) {
      parts.push("No training sessions logged this week.");
    } else {
      parts.push(`${trainingLogs.length} training session${trainingLogs.length > 1 ? "s" : ""} logged this week.`);
      if (daysSinceTraining !== null && daysSinceTraining >= 3) {
        parts.push(`Last training was ${daysSinceTraining} days ago.`);
      }
    }

    parts.push(weightTrend);

    const stepsTarget = user.stepsTarget || 8500;
    if (recentSteps.length > 0) {
      const avgSteps = Math.round(recentSteps.reduce((sum, s) => sum + s.steps, 0) / recentSteps.length);
      const hitTarget = recentSteps.filter(s => s.steps >= stepsTarget).length;
      parts.push(`Steps: avg ${avgSteps.toLocaleString()}/day (${hitTarget}/${recentSteps.length} days hit ${stepsTarget.toLocaleString()} target).`);
      if (avgSteps < stepsTarget * 0.6) {
        parts.push("Walking is significantly below target — needs direct accountability.");
      }
    } else {
      parts.push("No step data logged this week.");
    }

    const weekendChats = recentChats.filter(c => {
      const day = new Date(new Date(c.createdAt || "").getTime() + 2 * 3_600_000).getUTCDay();
      return day === 0 || day === 6;
    });
    const weekdayChats = recentChats.filter(c => {
      const day = new Date(new Date(c.createdAt || "").getTime() + 2 * 3_600_000).getUTCDay();
      return day >= 1 && day <= 5;
    });
    if (weekdayChats.length > 3 && weekendChats.length === 0) {
      parts.push("Pattern: Active on weekdays, silent on weekends — weekend accountability needed.");
    }

    const foodLogDays = new Set(
      recentChats.filter(c => c.intent === "FOOD_LOG").map(c => new Date(new Date(c.createdAt || "").getTime() + 2 * 3_600_000).toLocaleDateString("en-ZA"))
    ).size;
    if (foodLogDays >= 5) {
      parts.push("Food logging is consistent this week — solid habit.");
    } else if (foodLogDays <= 1) {
      parts.push("Almost no food logged this week — needs encouragement to track.");
    }

    if (programmeWeek === 3) parts.push("Currently in week 3 of the programme — the danger zone.");
    if (todaySAST.getUTCDate() >= 20) parts.push("Date is after the 20th — budget mode active.");

    // ── 28-day trajectory scoring ────────────────────────────────────────────
    const plannedSessions28 = (user.trainingDaysPerWeek || 3) * 4;
    const completedSessions28 = (monthWorkouts as { count: number }[])[0]?.count || 0;
    const sessionCompliance28 = plannedSessions28 > 0 ? completedSessions28 / plannedSessions28 : 0;

    const protDays = monthProtein as { day: string; total: number }[];
    const protCompliantDays = protDays.filter(d => d.total >= proteinTarget * 0.8).length;
    const protLoggedDays = protDays.filter(d => d.total > 0).length;
    const protCompliance28 = protLoggedDays >= 7 ? protCompliantDays / protLoggedDays : null;

    // Trajectory label: derives from session compliance over 4 weeks + current streak
    const wStreak28 = user.workoutStreak || 0;
    let trajectory: string;
    if (sessionCompliance28 >= 0.8 && wStreak28 >= 4) {
      trajectory = "ON_A_RUN";
    } else if (sessionCompliance28 >= 0.65) {
      trajectory = "ON_TRACK";
    } else if (sessionCompliance28 >= 0.4 && wStreak28 >= 1) {
      trajectory = "RECOVERING";
    } else if (completedSessions28 === 0) {
      trajectory = "DISENGAGED";
    } else {
      trajectory = "STRUGGLING";
    }

    const trajectoryNote = {
      ON_A_RUN:    `TRAJECTORY: On a run — ${completedSessions28}/${plannedSessions28} sessions over 4 weeks (${Math.round(sessionCompliance28 * 100)}%). This client is succeeding. Push harder. Reference the streak. Raise the bar.`,
      ON_TRACK:    `TRAJECTORY: On track — ${completedSessions28}/${plannedSessions28} sessions over 4 weeks. Consistent. Reinforce the habit. Identify the next gear.`,
      RECOVERING:  `TRAJECTORY: Recovering — was behind, now back. ${completedSessions28}/${plannedSessions28} sessions. Acknowledge the comeback. Build momentum, don't pile on.`,
      DISENGAGED:  `TRAJECTORY: Disengaged — 0 sessions in 28 days. Handle with care. Find out what's in the way. Set the smallest possible win. Don't push training — rebuild the relationship first.`,
      STRUGGLING:  `TRAJECTORY: Struggling — ${completedSessions28}/${plannedSessions28} sessions over 4 weeks (${Math.round(sessionCompliance28 * 100)}%). Direct but not harsh. Name the gap. Give one small action. Don't accept excuses — but acknowledge the difficulty is real.`,
    }[trajectory] || "";

    if (trajectoryNote) parts.push(trajectoryNote);

    if (protCompliance28 !== null) {
      if (protCompliance28 >= 0.75) {
        parts.push(`28-day protein compliance: ${Math.round(protCompliance28 * 100)}% of logged days at ≥80% target — strong habit.`);
      } else if (protCompliance28 < 0.4) {
        parts.push(`28-day protein compliance: only ${Math.round(protCompliance28 * 100)}% of logged days hit 80% protein target — chronic shortfall.`);
      }
    }

    // Silent return: when a user comes back after 3+ days without an explicit comeback
    // phrase, the deterministic handler won't intercept them — they land here in GPT.
    // Give GPT an explicit instruction so the response acknowledges the gap with data.
    const actualDaysSilent = user.lastActiveAt
      ? Math.floor((Date.now() - new Date(user.lastActiveAt).getTime()) / 86_400_000)
      : 0;
    if (actualDaysSilent >= 3) {
      parts.push(`SILENT RETURN: Client has been away for ${actualDaysSilent} days. Before answering their message, open with a 1-sentence acknowledgment — use their name, reference ONE concrete number from above (weight, steps average, or protein avg). Do NOT say "welcome back" literally. Make it feel like you noticed and tracked what happened while they were gone. Then answer their actual message normally.`);
    }

    const result = parts.join(" ");
    patternCache.set(cacheKey, result, PATTERN_CACHE_TTL_MS);
    return result;
  } catch (err) {
    console.error("[PATTERN] buildPatternSummary error:", err);
    const fallback = [`PATTERN CONTEXT: ${name}.`];
    if (programmeWeek === 3) fallback.push("Week 3 — danger zone.");
    if (todaySAST.getUTCDate() >= 20) fallback.push("Budget mode active.");
    return fallback.join(" ");
  }
}

// ============================================================
// GPT CALL — ALWAYS USES MASTER PROMPT + FULL CONTEXT
// ============================================================

const GPT4O_TEXT_SIGNALS = [
  "suicidal", "suicide", "self harm", "self-harm", "want to die", "kill myself",
  "end it all", "no reason to live", "want to hurt myself",
];

export function selectModel(instruction: string, userMessage: string): { model: string; maxTokens: number; reason: string } {
  const msgLower = userMessage.toLowerCase();

  const crisis = GPT4O_TEXT_SIGNALS.find(s => msgLower.includes(s));
  if (crisis) {
    console.log(`[MODEL] gpt-4o (crisis) — matched: "${crisis}"`);
    return { model: "gpt-4o", maxTokens: 400, reason: "crisis" };
  }

  // gpt-4o reserved for topics where a WRONG answer is unsafe (injuries/pain, medical, pregnancy); routine coaching answers as well on mini (~1/17th cost).
  const COMPLEX_SIGNALS = [
    "injury", "hurt my", "pain in", "hurts when", "sore knee", "sore shoulder", "sore back",
    "is it safe to",
    "diabetes", "hypertension", "blood pressure", "thyroid", "pcos",
    "doctor said", "medical", "chronic",
    "pregnant", "postpartum",
    "ozempic", "wegovy", "saxenda", "mounjaro", "glp-1", "glp1",
  ];
  const isComplex = COMPLEX_SIGNALS.some(s => msgLower.includes(s));
  if (isComplex) {
    console.log(`[MODEL] gpt-4o (complex coaching) | msg: "${userMessage.slice(0, 60)}"`);
    return { model: "gpt-4o", maxTokens: 350, reason: "complex" };
  }

  // LONG-FORM ASKS NEED ROOM TO FINISH (Work Order D, 2026-08-12: "*Week total: ~R199–R*" — a list
  // cut off mid-price). 160 stays the default for conversation; it was never right for a caller
  // asking for four sections and twenty priced items. The signal must be read off the INSTRUCTION
  // too — for the grocery rebuild the message is raw foods and the wanted SHAPE is all in the
  // instruction, which this function never inspected. That blind spot IS the truncation.
  const LONG_FORM_SIGNALS = ["grocery list", "shopping list", "rebuilt list", "updated list",
    "full list", "meal plan", "detailed plan", "week total", "respond exactly in this format"];
  const bothLower = `${msgLower}\n${(instruction || "").toLowerCase()}`;
  const longForm = LONG_FORM_SIGNALS.find(s => bothLower.includes(s));
  if (longForm) {
    console.log(`[MODEL] gpt-4o-mini (long-form) — matched: "${longForm}"`);
    return { model: "gpt-4o-mini", maxTokens: 900, reason: "long_form" };
  }

  console.log(`[MODEL] gpt-4o-mini | msg: "${userMessage.slice(0, 60)}"`);
  // Conversational replies are hard-capped at ~60 words / 3 sentences by the voice
  // rules (~90 tokens) — 160 leaves headroom without paying for runaway outputs.
  return { model: "gpt-4o-mini", maxTokens: 160, reason: "coaching" };
}

export interface GptFoodItem {
  name: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  portion_desc: string;
  category: "protein" | "carb" | "fat" | "vegetable" | "junk" | "dairy" | "beverage" | "other";
}

export interface GptFoodFallbackResult {
  foods: GptFoodItem[];
  totalKcal: number;
  totalProtein: number;
  coachNote: string;
  fromCache: boolean;
  // Composite items the anti-fabrication guard stripped before totalling — the
  // caller surfaces these so the client can re-send what was left out.
  dropped?: string[];
}

const foodFallbackCache = new Map<string, { result: GptFoodFallbackResult; expiresAt: number }>();
const FOOD_CACHE_TTL_MS = 60 * 60_000;

function normaliseFoodCacheKey(msg: string): string {
  return msg.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

export async function gptFoodFallback(
  message: string,
  user: { goalType?: string | null; calorieTarget?: number | null; proteinTarget?: number | null },
): Promise<GptFoodFallbackResult | null> {
  const goal = user.goalType || "fat_loss";
  // Cache key is bucketed by goal — the cached coach_note is generated FOR that goal
  // (fat_loss vs muscle_gain read very differently), so two users logging the same
  // food with different goals must never share a cached note (was a real cross-user leak).
  const cacheKey = `${goal}:${normaliseFoodCacheKey(message)}`;
  const cached = foodFallbackCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, fromCache: true };
  }

  try {
    const calTarget = user.calorieTarget || 1800;
    const protTarget = user.proteinTarget || 120;

    const resp = await withOpenAIRetry(() => openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 400,
      tools: [
        {
          type: "function",
          function: {
            name: "log_food",
            description: "Extract nutritional data ONLY for foods the user explicitly named or clearly described. Never add a different menu item (e.g. do not add Big Mac when they said South African breakfast). Use South African food names where applicable. If the message is NOT about food at all, set is_food to false and leave foods empty.",
            parameters: {
              type: "object",
              properties: {
                is_food: {
                  type: "boolean",
                  description: "true if the user is logging food they ate. false if the message is about something else entirely (social events, emotions, workout, questions, etc.).",
                },
                foods: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "Food name (SA name preferred: pap not polenta, pilchards not sardines)" },
                      kcal: { type: "integer", description: "Calories for the described portion" },
                      protein_g: { type: "integer", description: "Protein grams for the described portion" },
                      carbs_g: { type: "integer", description: "Carbohydrate grams" },
                      fat_g: { type: "integer", description: "Fat grams" },
                      portion_desc: { type: "string", description: "What the portion is, e.g. '1 half chicken (~380g)'" },
                      category: { type: "string", enum: ["protein", "carb", "fat", "vegetable", "junk", "dairy", "beverage", "other"] },
                    },
                    required: ["name", "kcal", "protein_g", "carbs_g", "fat_g", "portion_desc", "category"],
                  },
                },
                coach_note: {
                  type: "string",
                  description: `One direct sentence Coach K would say about this meal for a ${goal} goal (calorie target ${calTarget} kcal, protein target ${protTarget}g). Direct, SA voice. No filler. No 'great job'.`,
                },
              },
              required: ["is_food"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "log_food" } },
      messages: [
        {
          role: "system",
          content: `You extract nutritional data from South African WhatsApp fitness coaching messages.

LISTED ITEMS — when the user lists foods separately (one per line, comma-separated, slash-separated, or as a bullet list), OR when the message reads "i had X, Y and Z", log EACH as a COMPLETELY SEPARATE food item. NEVER create a combined "X and Y" entry when X and Y appear as distinct items.
- "Rice / Chicken breast / Mixed veggies" → 3 separate items: rice, chicken breast, mixed veggies
- "eggs, toast, banana" → 3 separate items
- "i had lentils, rice and chicken breast for lunch" → 3 separate items: lentils, rice, chicken breast
- NEVER add a "rice and chicken" or "chicken with rice" composite when chicken and rice are already logged as separate items
- CRITICAL: if you log "chicken breast" as one item, NEVER also log "chicken and rice" or "chicken with X" — that double-counts the chicken protein and breaks the calorie total

COMPOUND NAMES — only applies when written as ONE continuous phrase (not a list):
- "lemon cream biscuits" = one biscuit type (~100 kcal each)
- "steak wrap" = one wrap filled with steak
- "sweet potato" = sweet potato (not regular potato)
- "peanut butter toast" = toast with peanut butter
- "chicken rice" as a single phrase = one rice-and-chicken meal

SA PORTION STANDARDS (use these — not US defaults):
- Chicken breast: 180g = ~290 kcal, 55g protein
- Pap/maize: 250-300g cooked = ~300 kcal, 7g protein
- Rice cooked: 1 cup (180g) = ~230 kcal, 5g protein
- Pilchards (whole tin, 215g drained): ~215 kcal, 26g protein
- Bread slice (SA standard): 70g white = ~170 kcal, 65g brown = ~155 kcal
- Egg (large): 65g = ~85 kcal, 7g protein
- Use Nando's, Steers, KFC, Wimpy, Spur, Mugg & Bean SA actual menu calories when those brands are mentioned

SA FAST-FOOD BREAKFAST (use the real menu item, never a generic "breakfast muffin" guess):
- McDonald's Big Breakfast (eggs, hash brown, pork sausage, English muffin): ~760 kcal, 26g protein
- McDonald's Egg McMuffin: ~290 kcal, 17g protein. Bacon & Egg McMuffin: ~310 kcal, 18g protein
- McDonald's Hash Brown: ~140 kcal, 1g protein. Hotcakes (3, syrup + butter): ~580 kcal, 9g protein
- A plain "McDonald's breakfast" with no item named = treat as the Big Breakfast
- Wimpy / Spur / Mugg & Bean full breakfast: ~1100-1470 kcal — log as one breakfast plate, not separate items

DRINKS — ZERO/SUGAR-FREE IS NOT FULL SUGAR:
- Regular energy drink (Red Bull 250ml) = ~113 kcal. Coke/cola 330ml = ~140 kcal.
- If the message says "zero", "zero sugar", "sugar free", "sugarfree", "no sugar", "diet", or "light" — that drink is ~0-5 kcal, 0g protein. NEVER log the full-sugar value, and NEVER mention "sugar" in the note for a sugar-free drink.
- A "sugar free" milk coffee (mocha/latte/cappuccino) still has calories from the milk — only fizzy drinks/energy drinks go to ~0.

NEVER ASSUME DEFAULT INGREDIENTS — log ONLY what the user explicitly mentioned:
- "toast" = just toast (no butter). "bread" = just bread (no spread). "eggs" = just eggs (no oil).
- If the user lists items separately, log each exactly as stated — add NOTHING extra.
- Do NOT add butter, oil, margarine, cream, sugar, sauce, or any cooking medium unless the user said so.
- "toast and eggs" → toast + eggs. NOT toast + butter + eggs.

Be precise — never round to nearest 100. Always use SA food names (pap not polenta, pilchards not sardines).`,
        },
        {
          role: "user",
          content: message.slice(0, 500),
        },
      ],
    }), "gptFoodFallback");

    const toolCall = resp.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== "function" || toolCall.function.name !== "log_food") return null;

    const parsed = JSON.parse(toolCall.function.arguments);

    if (parsed.is_food === false) {
      console.log("[gptFoodFallback] model says not food — skipping");
      return null;
    }

    const allFoods: GptFoodItem[] = (parsed.foods || []).map((f: any) => ({
      name: String(f.name || "food"),
      kcal: Math.max(0, Math.round(parseFloat(String(f.kcal ?? 0)) || 0)),
      protein_g: Math.max(0, Math.round(parseFloat(String(f.protein_g ?? 0)) || 0)),
      carbs_g: Math.max(0, Math.round(parseFloat(String(f.carbs_g ?? 0)) || 0)),
      fat_g: Math.max(0, Math.round(parseFloat(String(f.fat_g ?? 0)) || 0)),
      portion_desc: String(f.portion_desc || ""),
      category: (["protein","carb","fat","vegetable","junk","dairy","beverage","other"].includes(f.category) ? f.category : "other") as GptFoodItem["category"],
    }));

    if (allFoods.length === 0) return null;

    // ANTI-FABRICATION GUARD — the model sometimes merges a listed carb with an UNLISTED protein
    // ("rice" → "rice and chicken"), inventing protein. Drop phantom composites before totalling so
    // an inflated number is never logged; the caller surfaces `dropped` to re-send what was left out.
    const droppedComposites = findFabricatedComposites(message, allFoods);
    let foods = droppedComposites.length > 0 ? allFoods.filter(f => !droppedComposites.includes(f.name)) : allFoods;
    const droppedUngrounded = findUngroundedFoodItems(message, foods);
    if (droppedUngrounded.length > 0) {
      console.warn(`[gptFoodFallback] dropped ungrounded item(s): ${droppedUngrounded.join(", ")} — message: "${message.slice(0, 80)}"`);
      foods = foods.filter(f => !droppedUngrounded.includes(f.name));
    }
    const dropped = [...droppedComposites, ...droppedUngrounded];
    if (foods.length === 0) return null; // whole "meal" was fabricated / ungrounded

    const totalKcal = foods.reduce((s, f) => s + f.kcal, 0);
    const totalProtein = foods.reduce((s, f) => s + f.protein_g, 0);
    const itemOutOfRange = foods.some(f => f.kcal > 2500 || f.protein_g > 250);
    if (itemOutOfRange || totalKcal > 3500 || totalProtein > 350) {
      console.warn(`[gptFoodFallback] rejecting hallucinated meal — totalKcal=${totalKcal} totalProt=${totalProtein} items=${foods.map(f => `${f.name}:${f.kcal}`).join(",")}`);
      return null;
    }
    if (dropped.length > 0) {
      console.warn(`[gptFoodFallback] dropped fabricated composite(s): ${dropped.join(", ")} — kept: ${foods.map(f => f.name).join(", ")}`);
    }
    const result: GptFoodFallbackResult = {
      foods,
      totalKcal,
      totalProtein,
      // The model's one-liner was written for the full pre-strip meal — discard it
      // when we dropped an item so it can't praise food we didn't log.
      coachNote: dropped.length > 0 ? "" : String(parsed.coach_note || ""),
      dropped,
      fromCache: false,
    };

    // ── Self-verifying loop: math → SA reference → LLM plausibility ──────────
    // Runs before cache write so every caller gets the verified estimate.
    // Fail-open: any error returns the original result unchanged.
    const verified = await verifyMealEstimate(message, result, user).catch(() => ({
      result, passes: 0, corrected: false, log: [] as string[],
    }));
    if (verified.corrected) {
      console.log(`[gptFoodFallback] verifier corrected estimate in ${verified.passes} pass(es): ${verified.log.join(" | ")}`);
    }
    const finalResult = verified.result as GptFoodFallbackResult;

    foodFallbackCache.set(cacheKey, { result: finalResult, expiresAt: Date.now() + FOOD_CACHE_TTL_MS });
    return finalResult;
  } catch (err) {
    if (!isAiOfflineError(err)) console.warn("[gptFoodFallback] error:", err);
    return null;
  }
}

/**
 * Supplement the SA scanner's matches with GPT for any food items it missed.
 * Only identifies items NOT already in `alreadyIdentified` — no double counting.
 * Returns extra GptFoodItem[] or null if nothing new was found.
 */
export async function gptFoodSupplement(
  message: string,
  user: { goalType?: string | null; calorieTarget?: number | null; proteinTarget?: number | null },
  alreadyIdentified: string[],
): Promise<GptFoodItem[] | null> {
  if (alreadyIdentified.length === 0) return null;

  // Cache key includes message + which foods are already matched (to avoid stale hits)
  const shortIds = alreadyIdentified.map(n => n.slice(0, 8).toLowerCase().replace(/\s/g, '')).sort().join(',');
  const suppKey = `supp:${normaliseFoodCacheKey(message)}:${shortIds}`;
  const cached = foodFallbackCache.get(suppKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result.foods.length > 0 ? cached.result.foods : null;
  }

  try {
    const resp = await withOpenAIRetry(() => openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 250,
      tools: [
        {
          type: "function",
          function: {
            name: "log_food",
            description: "Extract ONLY the nutritional data for food items NOT already identified by the database scanner. Leave foods empty if all items are already covered.",
            parameters: {
              type: "object",
              properties: {
                is_food: {
                  type: "boolean",
                  description: "true if there are genuinely new unidentified food items remaining. false if all foods are already covered.",
                },
                foods: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      kcal: { type: "integer" },
                      protein_g: { type: "integer" },
                      carbs_g: { type: "integer" },
                      fat_g: { type: "integer" },
                      portion_desc: { type: "string" },
                      category: { type: "string", enum: ["protein", "carb", "fat", "vegetable", "junk", "dairy", "beverage", "other"] },
                    },
                    required: ["name", "kcal", "protein_g", "carbs_g", "fat_g", "portion_desc", "category"],
                  },
                },
              },
              required: ["is_food"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "log_food" } },
      messages: [
        {
          role: "system",
          content: `You supplement a South African food log that was partially identified by a database scanner.

ALREADY IDENTIFIED (do NOT re-add these or variations of them): ${alreadyIdentified.join(', ')}

Your task: Identify ONLY the food items in the user's message that are completely absent from the above list.
- Do NOT re-add items already covered, even under a different name (e.g. if "chicken" is listed, skip "chicken breast" or "grilled chicken")
- Sauces, gravies, dressings, and condiments ONLY if >20 kcal per typical portion
- Omit: spices (salt, pepper, cumin, etc.), garnishes, water, condiments <20 kcal
- If all foods are already identified, set is_food=true with an empty foods array
- Use SA food names and portions (pap not polenta, pilchards not sardines)
- NEVER add assumed defaults: if "toast" is already identified, do NOT add butter — the user did not say butter. Only add items that were genuinely mentioned but not yet identified.`,
        },
        { role: "user", content: message.slice(0, 500) },
      ],
    }), "gptFoodSupplement");

    const toolCall = resp.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== "function" || toolCall.function.name !== "log_food") return null;

    const parsed = JSON.parse(toolCall.function.arguments);

    // Cache empty result too — so we don't re-call for the same message
    if (!parsed.is_food || !parsed.foods || parsed.foods.length === 0) {
      foodFallbackCache.set(suppKey, {
        result: { foods: [], totalKcal: 0, totalProtein: 0, coachNote: "", fromCache: false },
        expiresAt: Date.now() + FOOD_CACHE_TTL_MS,
      });
      return null;
    }

    const foods: GptFoodItem[] = (parsed.foods as any[]).map(f => ({
      name: String(f.name || "food"),
      kcal: Math.max(0, Math.round(parseFloat(String(f.kcal ?? 0)) || 0)),
      protein_g: Math.max(0, Math.round(parseFloat(String(f.protein_g ?? 0)) || 0)),
      carbs_g: Math.max(0, Math.round(parseFloat(String(f.carbs_g ?? 0)) || 0)),
      fat_g: Math.max(0, Math.round(parseFloat(String(f.fat_g ?? 0)) || 0)),
      portion_desc: String(f.portion_desc || ""),
      category: (["protein","carb","fat","vegetable","junk","dairy","beverage","other"].includes(f.category) ? f.category : "other") as GptFoodItem["category"],
    })).filter(f => f.kcal > 15); // drop spice-level items

    const result: GptFoodFallbackResult = {
      foods,
      totalKcal: foods.reduce((s, f) => s + f.kcal, 0),
      totalProtein: foods.reduce((s, f) => s + f.protein_g, 0),
      coachNote: "",
      fromCache: false,
    };

    foodFallbackCache.set(suppKey, { result, expiresAt: Date.now() + FOOD_CACHE_TTL_MS });
    console.log(`[gptFoodSupplement] Found ${foods.length} extras: ${foods.map(f => f.name).join(', ')}`);
    return foods.length > 0 ? foods : null;
  } catch (err) {
    if (!isAiOfflineError(err)) console.warn("[gptFoodSupplement] error:", err);
    return null;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of foodFallbackCache) {
    if (v.expiresAt <= now) foodFallbackCache.delete(k);
  }
}, 15 * 60_000);

export async function isUnderGPTCallLimit(userId: string): Promise<boolean> {
  try {
    const todayStart = sastDayStart();
    const result = await db.select({ count: sql`count(*)` })
      .from(chatHistory)
      .where(and(
        eq(chatHistory.userId, userId),
        gte(chatHistory.createdAt, todayStart),
        sql`message_in IS NOT NULL AND message_in != ''`
      ));
    const count = parseInt(String(result[0]?.count || 0));
    // 40 locked out a stress-testing (voice-heavy) client mid-conversation. 80 mini
    // replies ≈ $0.09/day worst case — the monthly $ cap below is the real margin guard.
    if (count >= 80) return false;
    // Monthly AI spend cap — env var AI_SPEND_CAP_USD_PER_USER_PER_MONTH (default $5)
    // Prevents a single power user from consuming more than the revenue they generate.
    return isUnderMonthlyCostCap(userId);
  } catch {
    return true;
  }
}

async function isUnderMonthlyCostCap(userId: string): Promise<boolean> {
  const capUsd = parseFloat(process.env.AI_SPEND_CAP_USD_PER_USER_PER_MONTH || "5");
  if (!isFinite(capUsd) || capUsd <= 0) return true; // cap disabled
  try {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const result = await db.select({ total: sql<string>`COALESCE(SUM(cost_usd::numeric), 0)` })
      .from(gptCosts)
      .where(and(
        eq(gptCosts.userId, userId),
        gte(gptCosts.createdAt, monthStart),
      ));
    const spent = parseFloat(result[0]?.total || "0");
    if (spent >= capUsd) {
      console.warn(`[AI_SPEND_CAP] user ...${userId.slice(-6)} hit $${capUsd} cap (spent $${spent.toFixed(4)} this month)`);
      return false;
    }
    return true;
  } catch {
    return true; // fail open — never block coaching due to a cost query failure
  }
}

// Fixed slice of the static brain kept on the hot path: voice + coaching framework +
// the CLAUDE.md-protected goal-aware food logic (ends ~18.4k chars), excluding the
// bulky reference tables (~33.8k+) the specialist agents own. FIXED boundary (never
// tail-dependent) — that is what makes the prefix byte-identical and cacheable.
const STATIC_HOT_BRAIN = COACH_K_SYSTEM.slice(0, 20_000);

export async function askCoachK(userMessage: string, user: any, extraInstruction?: string, memoryContext?: string, staticGuide?: string): Promise<string> {
  const context = await buildContext(user);
  const [patternSummary, cipNarrative] = await Promise.all([
    buildPatternSummary(user),
    getClientNarrative(user.id).catch(() => null),
  ]);
  console.log(`[PATTERN] ${patternSummary}`);
  const saFlags = getSAContextFlags(user);
  const instruction = extraInstruction || "Respond as Coach K to this client message.";
  const winMemory = memoryContext ? `\n\nCOACH K MEMORY — WHAT YOU KNOW ABOUT THIS CLIENT FROM PREVIOUS SESSIONS:\n${memoryContext}\nUse this to reference specific past wins when relevant. Be specific: if they lost 5kg, say "5kg down". If jeans were tighter at week 2 and loose at week 8, say that. Never fabricate wins not in this list.` : "";

  let todayFoodContext = "";
  try {
    const todayStart = sastDayStart();
    // Box 3 — the AI READS THE LEDGER. Its "today's numbers" come from the same getDayLedger
    // the card and the diary read, so the coach can never speak a total that contradicts them.
    const { getDayLedger } = await import("./day-ledger");
    const ledger = await getDayLedger(user.id, { user });

    if (ledger.meals.length > 0) {
      const totalCalToday = ledger.kcal;
      const totalProtToday = ledger.protein;
      const totalCarbsToday = ledger.carbs;
      const totalFatToday = ledger.fat;

      const byMeal: Record<string, { kcal: number; prot: number }> = {};
      for (const m of ledger.meals) {
        const label = m.label || "meal";
        byMeal[label] = byMeal[label] || { kcal: 0, prot: 0 };
        byMeal[label].kcal += m.kcal;
        byMeal[label].prot += m.protein;
      }
      const mealBreakdown = Object.entries(byMeal)
        .map(([label, v]) => `${label}: ${v.kcal} kcal / ${v.prot}g protein`)
        .join(" | ");

      const calTarget = user.calorieTarget || 1800;
      const protTarget = user.proteinTarget || 120;
      const calRemaining = calTarget - totalCalToday;
      const protRemaining = protTarget - totalProtToday;

      todayFoodContext = `\n\nTODAY'S FOOD LOG — AUTHORITATIVE (from database, use these exact numbers):\n${mealBreakdown}\nRunning total: ${totalCalToday} kcal | ${totalProtToday}g protein | ${totalCarbsToday}g carbs | ${totalFatToday}g fat\nCalorie target: ${calTarget} kcal → ${calRemaining > 0 ? calRemaining + " kcal remaining" : Math.abs(calRemaining) + " kcal OVER target"}\nProtein target: ${protTarget}g → ${protRemaining > 0 ? protRemaining + "g still needed" : "protein target MET ✅"}\nCRITICAL: When suggesting meals or answering portion questions, account for these calories. Never suggest something that pushes them significantly over target.`;
    } else {
      const calTarget = user.calorieTarget || 1800;
      todayFoodContext = `\n\nTODAY'S FOOD LOG: Nothing logged yet today. Calorie target: ${calTarget} kcal.`;
    }
  } catch (foodErr) {
    console.warn("[GPT] Could not fetch today's food context:", foodErr);
  }

  const liftContext = ""; // lift tracking removed 2026-08-06 — kept as "" so the prompt shape is untouched

  const { model, maxTokens, reason } = selectModel(instruction, userMessage);

  const cappedMemory = winMemory.length > 2000 ? winMemory.slice(0, 2000) + "\n[Memory truncated — older entries omitted]" : winMemory;
  // Prompt layout for OpenAI prefix-caching: static brain byte-identical across calls (cached ~50%),
  // per-client data in the tail. Client data never truncated (memory 2k, narrative 6k).
  const cipBlock = cipNarrative
    ? `\n\nCLIENT JOURNEY MEMORY (full history — use this to reference specific past achievements, patterns, and progress. Be precise: if they lost 4kg, say 4kg. Never fabricate):\n${cipNarrative.slice(0, 6000)}`
    : "";
  const clientContext = `${getNowContextSA()}\n\n${context}\n\n${patternSummary}${cipBlock}${saFlags ? "\n\n" + saFlags : ""}${todayFoodContext}${liftContext}${cappedMemory}`;
  // The length rule must know what was ASKED (Work Order D follow-up): the raised ceiling stopped
  // the API cutting a list mid-price, but the prompt still ordered "Max 3 sentences" at a
  // twenty-item ask. Only the length clause swaps — the voice rules after it never change.
  const hardLimit = `HARD RULE: ${reason === "long_form" ? "Give the FULL list or plan they asked for — every section, every item, nothing trimmed to save space." : "Max 3 sentences, 60 words total."} Never start with 'Coach K here'. Never say 'Reply MENU'. Always use the client's actual name. End with exactly one specific action.`;
  const tail = `\n\n${clientContext}\n\n${hardLimit}\n\nINSTRUCTION: ${instruction}`;
  const systemContent = `${STATIC_HOT_BRAIN}${staticGuide ? `\n\n${staticGuide}` : ""}${tail}`;
  // PROMPT BUDGET, BY COMPONENT (Work Order C, 2026-08-12). The warning below reports one number:
  // the prompt is big, nothing about WHICH part. Same total, itemised. Measurement only — nothing
  // here changes or truncates prompt content. `staticBrain` is already a 20k slice of a 66.6k one.
  console.log("[PROMPT] " + JSON.stringify({
    staticBrain: STATIC_HOT_BRAIN.length, staticGuide: staticGuide?.length || 0,
    context: context.length, patternSummary: patternSummary.length,
    cipNarrative: cipNarrative?.length || 0, cipBlockSent: cipBlock.length,
    saFlags: saFlags?.length || 0, todayFoodContext: todayFoodContext.length,
    memory: cappedMemory.length, tail: tail.length, systemContent: systemContent.length,
  }));
  if (systemContent.length > 48_000) {
    console.warn(`[GPT] System prompt unusually large: ${systemContent.length} chars (tail ${tail.length}) — check for runaway context`);
  }

  let conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
  try {
    const recentMessages = await db.select({
      messageIn: chatHistory.messageIn,
      messageOut: chatHistory.messageOut,
    }).from(chatHistory)
      .where(eq(chatHistory.userId, user.id))
      .orderBy(desc(chatHistory.createdAt))
      .limit(6);

    conversationHistory = recentMessages.reverse().flatMap(m => {
      const msgs: { role: "user" | "assistant"; content: string }[] = [];
      if (m.messageIn) msgs.push({ role: "user", content: m.messageIn });
      if (m.messageOut) msgs.push({ role: "assistant", content: m.messageOut.slice(0, 300) });
      return msgs;
    });
  } catch (histErr) {
    console.warn("[GPT] Could not fetch chat history:", histErr);
  }

  try {
    const response = await withOpenAIRetry(() => openai.chat.completions.create({
      model,
      max_tokens: maxTokens,
      // Voice rules are strict (word caps, banned phrases); temp 1.0 maximises rule-breaking.
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content: systemContent
        },
        ...conversationHistory,
        {
          role: "user",
          content: userMessage
        }
      ]
    }), "askCoachK");
    const usage = response.usage;
    if (usage) {
      const inputTokens = usage.prompt_tokens ?? 0;
      const outputTokens = usage.completion_tokens ?? 0;
      const isMini = model === "gpt-4o-mini";
      const costUSD = isMini
        ? (inputTokens / 1000) * 0.00015 + (outputTokens / 1000) * 0.0006
        : (inputTokens / 1000) * 0.005   + (outputTokens / 1000) * 0.015;
      const costZAR = costUSD * 18.5;
      console.log(`[COST] ${model} | in:${inputTokens} out:${outputTokens} | $${costUSD.toFixed(5)} (~R${costZAR.toFixed(4)}) | user:${user.id?.slice(-6)}`);
      recordGptCost({ userId: user.id, model, feature: "coach", promptTokens: inputTokens, completionTokens: outputTokens });
    }

    const rawReply = response.choices[0]?.message?.content?.trim() || "Sorry, I missed that one — send it to me again?";
    // ANTI-HALLUCINATION NET (2026-07-22): every askCoachK reply passes the SAME verifier the engine uses; on violation one rewrite, else a safe line — never ship the hallucination.
    const verdict = verifyBrainReply(rawReply, { goalType: user?.goalType });
    if (verdict.ok) return rawReply;
    console.warn(`[askCoachK] hallucination guard tripped: ${verdict.violation?.slice(0, 90)}`);
    captureQualitySignal("verifier_violation", { userId: user.id, messageIn: userMessage, messageOut: rawReply, detail: verdict.violation });
    try {
      const fixResp = await withOpenAIRetry(() => openai.chat.completions.create({
        model: "gpt-4o-mini", temperature: 0.3, max_tokens: 220,
        messages: [
          { role: "system", content: `You are Coach K. Your previous reply broke a rule and must be rewritten. RULE BROKEN: ${verdict.violation} Keep the warmth and brevity (max 3 sentences), fix the fault, and NEVER repeat the rule-breaking content.` },
          { role: "user", content: `Client said: "${userMessage}"\nYour reply to rewrite: "${rawReply}"` },
        ],
      }));
      const fixed = fixResp.choices[0]?.message?.content?.trim();
      if (fixed && verifyBrainReply(fixed, { goalType: user?.goalType }).ok) return fixed;
    } catch (e) { console.warn("[askCoachK] rewrite failed:", (e as any)?.message || e); }
    const nm = user?.name ? user.name.split(" ")[0] + ", " : "";
    return `${nm}let's keep it simple — tell me what you ate or what you trained today, and I'll take it from there.`;
  } catch (err: any) {
    if (isAiOfflineError(err)) return "Eish Coach K had a moment. Try that again.";
    const status = err?.status ?? err?.statusCode ?? 0;
    const code = err?.code ?? "";
    const msg = err?.message ?? "";

    if (status === 401 || code === 401 || msg.includes("401")) {
      console.error("[GPT] OpenAI auth error (401) — check OPENAI_API_KEY env var:", msg);
      // Alert coach via SMS if configured
      const alertPhone = process.env.COACH_ALERT_PHONE;
      if (alertPhone) {
        import("./scheduler/shared").then(({ sendCriticalAlert }) => {
          sendCriticalAlert(alertPhone, `[KamLife] OpenAI API key invalid or expired (401). GPT is down. Check OPENAI_API_KEY in Railway.`).catch(e => console.error("[CRITICAL_ALERT_SEND]", e?.message || e));
        }).catch(e => console.error("[CRITICAL_ALERT_IMPORT]", e?.message || e));
      }
      return "I'm having a technical issue on my end — give me a few minutes and try again. Your programme and targets are all saved.";
    }
    if (status === 429 || msg.toLowerCase().includes("rate limit") || msg.toLowerCase().includes("quota")) {
      console.error("[GPT] OpenAI rate limit / quota exceeded:", msg);
      return "Coach K is a bit busy right now. Give it 30 seconds and try again.";
    }
    if (status === 503 || status === 504 || msg.toLowerCase().includes("timeout") || code === "ECONNRESET") {
      console.error("[GPT] OpenAI timeout / service unavailable:", msg);
      return "Network hiccup on my side. Send that again in a moment.";
    }
    console.error("[GPT] OpenAI unexpected error:", { status, code, msg });
    return "Eish Coach K had a moment. Try that again.";
  }
}

// ============================================================ MILESTONE VOICE SCRIPT GENERATOR Replaces static hardcoded scripts with a GPT-generated
// 2-3 sentence voice note personalised to the client's engagement this week, their
// history, and their specific achievement numbers. Cost: one gpt-4o-mini call per milestone
// (milestones are rare — negligible). Falls back to a static script on
// any error so voice notes never silently drop. ============================================================

export type MilestoneType = "weight_loss" | "goal_reached_fat_loss" | "goal_reached_muscle" | "workout_sessions";

export async function generateMilestoneVoiceScript(
  user: any,
  milestoneType: MilestoneType,
  data: {
    kgLost?: number;
    currentKg?: number;
    startKg?: number;
    sessions?: number;
  },
): Promise<{ script: string; emotion: VoiceEmotion }> {
  const firstName = (user.name || "").split(" ")[0] || "there";
  const goal = user.goalType || "fat_loss";
  const daysOn = Math.floor((Date.now() - new Date(user.createdAt || Date.now()).getTime()) / 86_400_000);

  const fallbacks: Record<MilestoneType, string> = {
    weight_loss: `${firstName}. ${data.kgLost}kg gone. That took real work — not just in the gym, but every meal, every choice. Keep going.`,
    goal_reached_fat_loss: `${firstName}. You hit your target weight. You set a number, you worked for it, and you are standing on it right now. That is not luck. That is you.`,
    goal_reached_muscle: `${firstName}. Target weight reached. Every session, every meal, every rep — it built this. You did that.`,
    workout_sessions: `${firstName}. ${data.sessions} sessions. Every single one was a choice to show up. That is not motivation — that is discipline.`,
  };

  let patternSummary = "";
  try {
    patternSummary = await buildPatternSummary(user);
  } catch {
    // non-fatal
  }

  const milestoneDescription: Record<MilestoneType, string> = {
    weight_loss: `Lost ${data.kgLost}kg total (started at ${data.startKg}kg, now ${data.currentKg}kg) after ${daysOn} days on the programme`,
    goal_reached_fat_loss: `Hit their fat loss target weight of ${data.currentKg}kg (started at ${data.startKg}kg, lost ${data.kgLost}kg)`,
    goal_reached_muscle: `Hit their muscle gain target weight of ${data.currentKg}kg (started at ${data.startKg}kg)`,
    workout_sessions: `Completed ${data.sessions} total workout sessions with Coach K`,
  };

  // Pick the emotional register from the REAL pattern data, then let it drive both
  // the words (prompt below) and the voice delivery (returned to the caller).
  // buildPatternSummary already computed these signals — read them back out.
  const silentMatch = patternSummary.match(/\((\d+)\s+days?\s+silent\)/i);
  const daysSilent = silentMatch ? parseInt(silentMatch[1], 10) : 0;
  const lastTrainMatch = patternSummary.match(/Last training was (\d+) days ago/i);
  const daysSinceTraining = lastTrainMatch ? parseInt(lastTrainMatch[1], 10) : 0;
  const lapsed = daysSilent >= 4 || daysSinceTraining >= 5
    || /No training sessions logged this week/i.test(patternSummary);
  const struggling = /too hard or wanting to quit|needs direct accountability|consistently under/i.test(patternSummary);
  const thriving = /solid habit|at or above target|Food logging is consistent/i.test(patternSummary);

  // Hitting a milestone after going quiet or struggling = a comeback: firm first,
  // proud second — never a soft "how are you". Otherwise match their momentum.
  const emotion: VoiceEmotion = (lapsed || struggling) ? "comeback" : thriving ? "celebratory" : "warm";

  const toneHint = emotion === "comeback"
    ? "They went quiet or had a rough stretch before hitting this. Do NOT open soft and do NOT ask how they are. In the first sentence, name the gap directly and firmly — they know they slipped. Then give real respect that they showed up and hit this number anyway. Firm first, proud second."
    : emotion === "celebratory"
    ? "They have been consistent and showing up. Match that energy — warm, genuinely pleased, real fire behind it. This is who they are now."
    : "Direct, warm and real — a genuine moment, spoken like you mean it, not recited.";

  try {
    assertAiOnline("milestoneVoiceScript"); // offline test mode: skip network, fall through to deterministic script
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 120,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `You write short voice note scripts for a South African fitness coach named Coach K. These will be spoken aloud by a cloned voice so they MUST sound natural when heard, not when read. Write for the ear, not the eye.\n\nRULES:\n- Exactly 2-3 sentences. Never more.\n- Start with the client's first name — nothing before it, no greeting phrase.\n- Reference the exact achievement numbers. Never round or approximate.\n- SA voice: direct, real, specific — not American hype. Use "lekker", "sharp", "eish" naturally if it fits — not forced.\n- Never say "I'm Coach K" or "this is Coach K". Never "keep it up", "great job", "I'm so proud".\n- No questions — statements only. Questions break the coaching authority.\n- End with ONE specific forward-looking sentence — what they do NEXT, not a generic sentiment.\n- No hashtags, emojis, asterisks, or punctuation the voice would mispronounce.\n- Do not start sentences with "And" or "But" — it sounds read.\n- Vary sentence rhythm: short punch, longer thought, short closer.`,
        },
        {
          role: "user",
          content: `Client: ${firstName}, goal: ${goal}, days on programme: ${daysOn}\nMilestone: ${milestoneDescription[milestoneType]}\nTheir recent pattern: ${patternSummary || "no recent data"}\nTone guidance: ${toneHint}\n\nWrite the voice note script now. No intro, no sign-off — just the script.`,
        },
      ],
    });

    const script = response.choices[0]?.message?.content?.trim();
    if (script && script.length > 20) {
      console.log(`[VOICE_SCRIPT] Generated for ${firstName} (${milestoneType}) emotion=${emotion}: "${script.slice(0, 80)}..."`);
      return { script, emotion };
    }
  } catch (err) {
    if (!isAiOfflineError(err)) console.warn("[VOICE_SCRIPT] GPT failed, using fallback:", err);
  }

  return { script: fallbacks[milestoneType], emotion };
}

// ============================================================
// INTENT CLASSIFIER
// ============================================================

export type ClassifiedIntent =
  | "FOOD_LOG" | "WORKOUT_LOG" | "STEPS" | "WEIGHT"
  | "QUESTION" | "RANT" | "GREETING" | "MENU_REQUEST" | "OTHER"
  | "GOAL_CHANGE" | "FOOD_PLANNED" | "MEAL_COPY" | "TOTALS_QUERY";

export interface IntentClassification {
  intent: ClassifiedIntent;
  confidence: number;
  /** Canonical rephrasing of the message in the exact form the deterministic
   *  handlers were built for — e.g. "i want to go into a building phase" →
   *  "change my goal to muscle gain". Empty when no rewrite is needed. */
  canonical?: string;
}

const INTENT_FAST_PATHS: Array<[RegExp, ClassifiedIntent]> = [
  [/^(hi|hey|hello|howzit|sawubona|dumelang|ekse|yo|sup|gm|good\s*morning|good\s*afternoon|good\s*evening|good\s*night)[\s!?.]*$/i, "GREETING"],
  [/^(menu|help|options|start|\*menu\*|\*help\*)[\s?]*$/i, "MENU_REQUEST"],
  [/^(\d{4,6})\s*(steps?|step|km|k|miles?)?\s*$/i, "STEPS"],
  // k-shorthand steps + water volumes: deterministic handlers parse these fully — the classifier call was pure waste.
  [/^([\d.,]+)\s*k\s*(steps?)?[\s!.]*$/i, "STEPS"],
  [/^([\d.,]+)\s*(l|litres?|liters?|ml|glass(?:es)?|bottles?|cups?)\s*(of\s*)?(water)?[\s!.]*$/i, "OTHER"],
  [/^(\d{2,3}(?:\.\d+)?)\s*kg\s*$/i, "WEIGHT"],
  [/^(done|finished|completed|session done|workout done|trained today|went to gym|gym done|just finished|just trained)[\s!.]*$/i, "WORKOUT_LOG"],
  // Programme requests — asking TO SEE the plan, never a completion report.
  // Must be caught BEFORE the GPT classifier, which treats "today's workout" as ambiguous
  // and guesses WORKOUT_LOG, causing a fake session log. Tolerates up to 3 leading filler words
  // ("Meet today's workout." — Whisper mishearing "what's"); completion/schedule/change verbs excluded.
  [/^(?!.*\b(?:done|did|finished|complete[d]?|smashed|crushed|logged|next|tomorrow|yesterday|change|switch|swap|cancel|skip|new|different|another)\b)(?:[\w'’]+\s+){0,3}(?:today.?s?|my|the)?\s*(?:workout|session|training|programme?)(?:\s+(?:for\s+)?(?:today|now|please|pls))?[\s?!.]*$/i, "OTHER"],
];

const VALID_INTENTS = new Set<ClassifiedIntent>([
  "FOOD_LOG", "WORKOUT_LOG", "STEPS", "WEIGHT",
  "QUESTION", "RANT", "GREETING", "MENU_REQUEST", "OTHER",
  "GOAL_CHANGE", "FOOD_PLANNED", "MEAL_COPY", "TOTALS_QUERY",
]);

export async function classifyIntent(message: string, userId?: string): Promise<IntentClassification> {
  const m = message.trim();
  if (m.length < 2) return { intent: "OTHER", confidence: 0.95 };

  for (const [pattern, intent] of INTENT_FAST_PATHS) {
    if (pattern.test(m)) return { intent, confidence: 0.95 };
  }

  // RECORDED NORMALIZATION (issue #63 item 1.1) — the offline replay of production's own rewrite.
  // The seam lives with the other test doubles in db.ts; see recordedIntent() for why.
  const recorded = recordedIntent<IntentClassification>(m);
  if (recorded) return recorded;

  if (m.length > 500) return { intent: "OTHER", confidence: 0 };

  try {
    const response = await withOpenAIRetry(() => openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 110,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `You are the message-understanding brain of a South African WhatsApp fitness coach. Clients write in English, Afrikaans, isiZulu, isiXhosa, Sotho, slang, and voice-note transcripts. Classify the message AND, for action intents, rephrase it into the canonical form the system understands. Respond ONLY with JSON: {"intent":"X","confidence":0.0,"canonical":""}

X must be exactly one of:
FOOD_LOG     - reporting food/drinks ALREADY eaten → canonical: "i had <items> for <meal> [yesterday]"
FOOD_PLANNED - food they are GOING TO eat (future tense) → canonical: "i'm gonna have <items> for <meal>"
MEAL_COPY    - repeat a previous meal ("same as lunch") → canonical: "<meal> same as <meal/yesterday>"
STEPS        - steps/distance walked, a statement not a question → canonical: "<number> steps [yesterday]"
WORKOUT_LOG  - ALREADY COMPLETED exercise/session → canonical: "workout done [yesterday]"
               MUST have explicit completion: "done", "finished", "trained", "just came from gym", "session complete"
               "Today's workout" alone = programme request = OTHER, not WORKOUT_LOG
               Sharing a lift result ("hack squat 25kg 6 reps", "I did 25kg each side") after a session = OTHER, NOT WORKOUT_LOG — that's lift data, not a new session log
               NEVER add "yesterday" to canonical unless the word "yesterday" (or equivalent retro date) is in the original
WEIGHT       - body weight check-in → canonical: "<number>kg"
GOAL_CHANGE  - wants different goal: building/bulking phase, cut, lean out, muscle composition → canonical: "change my goal to <muscle gain|fat loss|recomposition>"
TOTALS_QUERY - asking today's calorie/protein NUMBERS or remaining → canonical: "today's calories"
               Asking to SEE the meals/food/log itself ("show me today's food", "every meal I logged", "what did I eat") is NOT a totals query → OTHER, canonical ""
QUESTION     - asking about fitness/nutrition/health (even if it contains numbers!) → canonical: ""
RANT         - venting frustration/emotion → canonical: ""
GREETING     - purely social opener → canonical: ""
MENU_REQUEST - wants menu/options/help → canonical: ""
OTHER        - everything else, including requests to SEE a plan → canonical: ""

RULES:
- A question that MENTIONS steps/food/weight is QUESTION, never a log. "Doesn't going over 10,000 steps affect my goals?" → QUESTION.
- NEVER invent items, numbers, or meals not present in the message. Canonical only rephrases what is there.
- Keep food items exactly as said (tin fish stays tin fish). Translate number-words to digits ("ten thousand" → 10000).
- "building phase" / "change muscle composition" / "bulk" → GOAL_CHANGE muscle gain. "cut" / "lean out" → fat loss.
- "Today's workout" / "my workout" / "give me my workout" = requesting the plan = OTHER. No canonical needed.
- FOOD_PLANNED requires EXPLICIT future words from the client ("going to", "gonna", "later", "tonight", "will have"). A bare food list — meal name then items, no verbs — is ALWAYS FOOD_LOG (already eaten). When in doubt between FOOD_LOG and FOOD_PLANNED, choose FOOD_LOG.
- MULTILINGUAL: clients log in isiZulu, isiXhosa, Sesotho, Setswana, Afrikaans. TRANSLATE the foods and numbers into the canonical English form. Common: ipapa/papa→pap, inyama/nama→meat, isonka→bread, amaqanda/mazai→eggs, inkukhu/kgoho→chicken, izinyathelo/mehato→steps; "ngidle/ngidlile/nditye/ke jele"→i ate; "ngihambe/ke tsamaile"→i walked; "namuhla/namhlanje/kajeno"→today; "izolo/gister/maabane"→yesterday.

Examples:
"Also, I want to go into a building phase. I want to change the muscle composition." → {"intent":"GOAL_CHANGE","confidence":0.95,"canonical":"change my goal to muscle gain"}
"Doesn't going over 10,000 steps affect my body composition and my goals?" → {"intent":"QUESTION","confidence":0.95,"canonical":""}
"Breakfast, four fish fingers, four slices of bread, four eggs, and a black coffee." → {"intent":"FOOD_LOG","confidence":0.95,"canonical":"i had 4 fish fingers, 4 slices of bread, 4 eggs and a black coffee for breakfast"}
"Luch\nTin fish\nRice\nMixed veggies" → {"intent":"FOOD_LOG","confidence":0.95,"canonical":"i had tin fish, rice and mixed veggies for lunch"}
"Tonight I'm going to make chicken and pap for dinner" → {"intent":"FOOD_PLANNED","confidence":0.9,"canonical":"i'm gonna have chicken and pap for dinner"}
"Ek het ten thousand steps gedoen gister" → {"intent":"STEPS","confidence":0.9,"canonical":"10000 steps yesterday"}
"Ngidle ipapa nenyama namuhla" → {"intent":"FOOD_LOG","confidence":0.9,"canonical":"i had pap and meat"}
"Ke jele papa le nama" → {"intent":"FOOD_LOG","confidence":0.9,"canonical":"i had pap and meat"}
"Nditye isonka namaqanda kusasa" → {"intent":"FOOD_LOG","confidence":0.9,"canonical":"i had bread and eggs for breakfast"}
"Ngihambe izinyathelo eziyi-8000" → {"intent":"STEPS","confidence":0.9,"canonical":"8000 steps"}
"Ngiqedile ukujima" → {"intent":"WORKOUT_LOG","confidence":0.9,"canonical":"workout done"}
"Today's workout" → {"intent":"OTHER","confidence":0.95,"canonical":""}
"Give me my workout" → {"intent":"OTHER","confidence":0.95,"canonical":""}
"I just finished my session" → {"intent":"WORKOUT_LOG","confidence":0.95,"canonical":"workout done"}
"Hack squat I did 25kg each side for the first time. 6 reps" → {"intent":"OTHER","confidence":0.95,"canonical":""}
"Show me today's food, every single meal that I've logged" → {"intent":"OTHER","confidence":0.95,"canonical":""}
"How do my calories adjust while I'm sick? Or do they stay the same?" → {"intent":"QUESTION","confidence":0.95,"canonical":""}
"bench press 80kg 3x10" → {"intent":"OTHER","confidence":0.95,"canonical":""}`,
        },
        { role: "user", content: m.slice(0, 300) },
      ],
    }), "classifyIntent");

    const raw = (response.choices[0]?.message?.content || "{}").trim().replace(/^```json?\s*|\s*```$/g, "");
    const parsed = JSON.parse(raw) as { intent?: string; confidence?: number; canonical?: string };
    const intent: ClassifiedIntent = VALID_INTENTS.has(parsed.intent as ClassifiedIntent)
      ? (parsed.intent as ClassifiedIntent)
      : "OTHER";
    const confidence = typeof parsed.confidence === "number"
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.5;
    const canonical = typeof parsed.canonical === "string" ? parsed.canonical.trim().slice(0, 400) : "";

    if (response.usage) {
      const costUSD = (response.usage.prompt_tokens * 0.00015 + response.usage.completion_tokens * 0.0006) / 1000;
      console.log(`[INTENT] ${intent}(${Math.round(confidence * 100)}%)${canonical ? ` canon="${canonical.slice(0, 60)}"` : ""} tokens:${response.usage.total_tokens} $${costUSD.toFixed(5)}${userId ? ` user:${userId.slice(-6)}` : ""}`);
      recordGptCost({ userId: userId ?? null, model: "gpt-4o-mini", feature: "classify", promptTokens: response.usage.prompt_tokens ?? 0, completionTokens: response.usage.completion_tokens ?? 0 });
    }

    return { intent, confidence, canonical };
  } catch (err) {
    if (!isAiOfflineError(err)) console.warn("[INTENT] Classifier error (non-fatal, falling back):", err);
    return { intent: "OTHER", confidence: 0 };
  }
}
