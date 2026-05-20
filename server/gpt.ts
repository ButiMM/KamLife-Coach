import OpenAI from "openai";
import { db } from "./db";
import { users, chatHistory, weightLogs, stepLogs, workoutLogs, exerciseLogs, mealLogs } from "../shared/schema";
import { eq, desc, and, gte, lt, sql } from "drizzle-orm";
import { COACH_K_SYSTEM } from "./coach-prompt";
import { getPhaseNames } from "./programme";
import { calculateTargets } from "./targets";
import { getDisplayName, sastDayStart } from "./utils";
import { patternCache, PATTERN_CACHE_TTL_MS } from "./cache";

// ============================================================
// EXPONENTIAL BACKOFF WRAPPER — retries on OpenAI 429 rate limits
// ============================================================
async function withOpenAIRetry<T>(fn: () => Promise<T>, label = "openai"): Promise<T> {
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
}

const openai = new OpenAI({
  // Prevent startup crash when env key is absent; request-time handling returns safe fallbacks.
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-missing-key",
});

export function buildContext(user: any): string {
  const name = getDisplayName(user) || "a client";
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
  const focus = user.primaryFocusArea || "";
  const injuries = user.injuries || "none";
  const age = user.age || 30;
  const water = user.todayWater || 0;
  const experience = user.trainingExperience || "beginner";

  const medicalConditions = user.medicalConditions || "none";
  const hasMedical = medicalConditions !== "none" && medicalConditions.trim() !== "";
  const medicalDisclaimer = hasMedical
    ? `\nMEDICAL NOTE: This client has: ${medicalConditions}. When giving condition-specific advice (diet, exercise modification, medication timing), ALWAYS end with a one-sentence reminder to consult their doctor or healthcare provider for personalised medical guidance. Never diagnose, never contraindicate prescribed medication, never tell them to stop medication.`
    : "";

  // Age-derived coaching tone and safety flags
  const daysOnProgramme = Math.floor((Date.now() - new Date(user.createdAt || Date.now()).getTime()) / 86400000);
  const weeksOnProgramme = Math.max(1, Math.floor(daysOnProgramme / 7));
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

  return `CLIENT PROFILE:\nName: ${name}\nGender: ${gender}\nGoal: ${goal}\nAge: ${age}\nPhase: ${phase} — ${phaseName}\nCalorie target: ${calories}\nProtein target: ${protein}g\nStep target: ${steps}\nTraining mode: ${mode}\nEquipment: ${equipment}\nLife situation: ${situation}\nJob type: ${job}\nActivity level: ${activity}\nPrimary focus: ${focus}\nInjuries: ${injuries}\nMedical conditions: ${medicalConditions}\nExperience: ${experience}\nWater today: ${water}L\nDays on programme: ${daysOnProgramme} (week ${weeksOnProgramme})\nCompliance level: ${user.complianceLevel || 'RESET'}\nWorkout streak: ${user.workoutStreak || 0} consecutive sessions\nTotal sessions completed: ${user.totalWorkoutsCompleted || 0}\nProgramme week: ${user.programmeWeek || 1}\nSubscription status: ${user.subscriptionStatus || 'inactive'}\nShopping store tier: ${storeTier}\n\n${coachingTone}\n${ageGuidelines}${medicalDisclaimer}`;
}

// ============================================================
// SA CULTURAL & SEASONAL CONTEXT FLAGS
// ============================================================

export function getSAContextFlags(user?: any): string {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
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
  const sevenDaysAgo = sastDayStart(new Date(today.getTime() - 7 * 86_400_000));
  const fourteenDaysAgo = new Date(today.getTime() - 14 * 86_400_000);

  try {
    const [recentChats, recentWeights, olderWeights, recentSteps] = await Promise.all([
      db.select().from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), gte(chatHistory.createdAt, sevenDaysAgo)))
        .orderBy(desc(chatHistory.createdAt))
        .limit(100),
      db.select().from(weightLogs)
        .where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, sevenDaysAgo)))
        .orderBy(desc(weightLogs.loggedAt))
        .limit(5),
      db.select().from(weightLogs)
        .where(and(
          eq(weightLogs.userId, user.id),
          gte(weightLogs.loggedAt, fourteenDaysAgo),
          lt(weightLogs.loggedAt, sevenDaysAgo)
        ))
        .orderBy(desc(weightLogs.loggedAt))
        .limit(1),
      db.select().from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo)))
        .orderBy(desc(stepLogs.loggedAt))
        .limit(7),
    ]);

    const daysWithLogs = new Set(
      recentChats.map(c => new Date(c.createdAt || "").toLocaleDateString("en-ZA"))
    ).size;
    const daysSilent = 7 - daysWithLogs;

    const foodLogs = recentChats.filter(c => c.intent === "FOOD_LOG");
    let avgProtein: number | null = null;
    try {
      const dailyProtein = await db.select({
        day: sql<string>`DATE(${mealLogs.loggedAt})`,
        protein: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
      })
        .from(mealLogs)
        .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, sevenDaysAgo)))
        .groupBy(sql`DATE(${mealLogs.loggedAt})`);
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

    let weightTrend = "No weight data this week.";
    if (recentWeights.length > 0 && olderWeights.length > 0) {
      const recent = parseFloat(String(recentWeights[0].weight));
      const older = parseFloat(String(olderWeights[0].weight));
      const diff = recent - older;
      if (Math.abs(diff) < 0.3) weightTrend = "Weight unchanged week-on-week.";
      else if (diff > 0) weightTrend = `Weight up ${diff.toFixed(1)}kg this week.`;
      else weightTrend = `Weight down ${Math.abs(diff).toFixed(1)}kg this week.`;
    } else if (recentWeights.length > 0) {
      const daysAgo = Math.floor((Date.now() - new Date(recentWeights[0].loggedAt || "").getTime()) / 86_400_000);
      weightTrend = daysAgo <= 1
        ? `Weight logged: ${recentWeights[0].weight}kg.`
        : `Weight unchanged for ${daysAgo} days.`;
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

    const stepsTarget = user.stepsTarget || 10000;
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
      const day = new Date(c.createdAt || "").getDay();
      return day === 0 || day === 6;
    });
    const weekdayChats = recentChats.filter(c => {
      const day = new Date(c.createdAt || "").getDay();
      return day >= 1 && day <= 5;
    });
    if (weekdayChats.length > 3 && weekendChats.length === 0) {
      parts.push("Pattern: Active on weekdays, silent on weekends — weekend accountability needed.");
    }

    const foodLogDays = new Set(
      recentChats.filter(c => c.intent === "FOOD_LOG").map(c => new Date(c.createdAt || "").toLocaleDateString("en-ZA"))
    ).size;
    if (foodLogDays >= 5) {
      parts.push("Food logging is consistent this week — solid habit.");
    } else if (foodLogDays <= 1) {
      parts.push("Almost no food logged this week — needs encouragement to track.");
    }

    if (programmeWeek === 3) parts.push("Currently in week 3 of the programme — the danger zone.");
    if (today.getDate() >= 20) parts.push("Date is after the 20th — budget mode active.");

    const result = parts.join(" ");
    patternCache.set(cacheKey, result, PATTERN_CACHE_TTL_MS);
    return result;
  } catch (err) {
    console.error("[PATTERN] buildPatternSummary error:", err);
    const fallback = [`PATTERN CONTEXT: ${name}.`];
    if (programmeWeek === 3) fallback.push("Week 3 — danger zone.");
    if (today.getDate() >= 20) fallback.push("Budget mode active.");
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

  const COMPLEX_SIGNALS = [
    "injury", "hurt my", "pain in", "hurts when", "sore knee", "sore shoulder", "sore back",
    "recomposition", "body recomp", "recomp",
    "creatine", "supplement", "pre-workout", "bcaa", "whey",
    "change my programme", "switch my programme", "adjust my programme",
    "not losing weight", "not seeing results", "why am i not",
    "plateau", "weight plateau", "stuck at",
    "should i take", "is it safe to",
    "diabetes", "hypertension", "blood pressure", "thyroid", "pcos",
    "doctor said", "medical", "chronic",
    "pregnant", "postpartum",
  ];
  const isComplex = COMPLEX_SIGNALS.some(s => msgLower.includes(s));
  if (isComplex) {
    console.log(`[MODEL] gpt-4o (complex coaching) | msg: "${userMessage.slice(0, 60)}"`);
    return { model: "gpt-4o", maxTokens: 350, reason: "complex" };
  }

  console.log(`[MODEL] gpt-4o-mini | msg: "${userMessage.slice(0, 60)}"`);
  return { model: "gpt-4o-mini", maxTokens: 280, reason: "coaching" };
}

export type VisionUseCase = "food_photo" | "progress_compare" | "exercise_classify" | "step_ocr";
export type SubscriptionTier = "active" | "trial" | "inactive" | string | null | undefined;

export interface VisionModelDecision {
  allowed: boolean;
  model: "gpt-4o" | "gpt-4o-mini";
  detail: "low" | "auto" | "high";
  maxTokens: number;
  reason: string;
}

export function selectVisionModel(useCase: VisionUseCase, tier: SubscriptionTier): VisionModelDecision {
  const t = (tier || "").toLowerCase();
  const paying = t === "active";
  const onboarded = paying || t === "trial";

  if (!onboarded) {
    return {
      allowed: false,
      model: "gpt-4o-mini",
      detail: "low",
      maxTokens: 0,
      reason: "inactive_tier_blocked",
    };
  }

  switch (useCase) {
    case "progress_compare":
      return paying
        ? { allowed: true, model: "gpt-4o", detail: "auto", maxTokens: 400, reason: "progress_paid" }
        : { allowed: true, model: "gpt-4o-mini", detail: "auto", maxTokens: 350, reason: "progress_trial" };

    case "food_photo":
      // gpt-4o for paying users — better SA food recognition, fewer "cannot make out" failures
      return paying
        ? { allowed: true, model: "gpt-4o", detail: "auto", maxTokens: 400, reason: "food_paid" }
        : { allowed: true, model: "gpt-4o-mini", detail: "auto", maxTokens: 400, reason: "food_trial" };

    case "exercise_classify":
    case "step_ocr":
      return { allowed: true, model: "gpt-4o-mini", detail: "low", maxTokens: useCase === "step_ocr" ? 50 : 8, reason: useCase };
  }
}

export function estimateVisionCostUSD(decision: VisionModelDecision, completionTokens: number = 0): number {
  const imgTok = decision.detail === "low" ? 85 : decision.detail === "high" ? 400 : 170;
  const promptTok = imgTok + 300;
  if (decision.model === "gpt-4o-mini") {
    return (promptTok * 0.15 + completionTokens * 0.6) / 1_000_000;
  }
  return (promptTok * 5 + completionTokens * 15) / 1_000_000;
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
  const cacheKey = normaliseFoodCacheKey(message);
  const cached = foodFallbackCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, fromCache: true };
  }

  try {
    const goal = user.goalType || "fat_loss";
    const calTarget = user.calorieTarget || 1800;
    const protTarget = user.proteinTarget || 130;

    const resp = await withOpenAIRetry(() => openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 400,
      tools: [
        {
          type: "function",
          function: {
            name: "log_food",
            description: "Extract nutritional data from a user's food description. Use South African food names where applicable. If the message is NOT about food at all, set is_food to false and leave foods empty.",
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
          content: `You extract nutritional data from South African WhatsApp fitness coaching messages.\n\nCRITICAL RULES for compound food names:\n- "steak wrap" = ONE item: a wrap/tortilla filled with beef steak. NOT "beef steak" + "chicken wrap". Log it as "steak wrap (beef)" ~450-550 kcal.\n- "chicken wrap" = ONE item: a tortilla with chicken filling\n- "X wrap" means the wrap is filled with X — never split into two items\n- "chicken rice" = ONE meal: chicken served with rice (not two separate items)\n- Only split at commas, "and", "plus", "with" when clearly listing separate dishes\n\nUse realistic SA portion sizes. When user says "Nando's" use their actual menu item calories. Be precise — never round to nearest 100.`,
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

    const foods: GptFoodItem[] = (parsed.foods || []).map((f: any) => ({
      name: String(f.name || "food"),
      kcal: Math.max(0, parseInt(f.kcal) || 0),
      protein_g: Math.max(0, parseInt(f.protein_g) || 0),
      carbs_g: Math.max(0, parseInt(f.carbs_g) || 0),
      fat_g: Math.max(0, parseInt(f.fat_g) || 0),
      portion_desc: String(f.portion_desc || ""),
      category: (["protein","carb","fat","vegetable","junk","dairy","beverage","other"].includes(f.category) ? f.category : "other") as GptFoodItem["category"],
    }));

    if (foods.length === 0) return null;

    const totalKcal = foods.reduce((s, f) => s + f.kcal, 0);
    const totalProtein = foods.reduce((s, f) => s + f.protein_g, 0);
    const itemOutOfRange = foods.some(f => f.kcal > 2500 || f.protein_g > 250);
    if (itemOutOfRange || totalKcal > 3500 || totalProtein > 350) {
      console.warn(`[gptFoodFallback] rejecting hallucinated meal — totalKcal=${totalKcal} totalProt=${totalProtein} items=${foods.map(f => `${f.name}:${f.kcal}`).join(",")}`);
      return null;
    }
    const result: GptFoodFallbackResult = {
      foods,
      totalKcal,
      totalProtein,
      coachNote: String(parsed.coach_note || ""),
      fromCache: false,
    };

    foodFallbackCache.set(cacheKey, { result, expiresAt: Date.now() + FOOD_CACHE_TTL_MS });
    return result;
  } catch (err) {
    console.warn("[gptFoodFallback] error:", err);
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
    return count < 40;
  } catch {
    return true;
  }
}

export async function askCoachK(userMessage: string, user: any, extraInstruction?: string, memoryContext?: string): Promise<string> {
  const context = buildContext(user);
  const patternSummary = await buildPatternSummary(user);
  console.log(`[PATTERN] ${patternSummary}`);
  const saFlags = getSAContextFlags(user);
  const instruction = extraInstruction || "Respond as Coach K to this client message.";
  const hardLimit = "HARD RULE: Max 3 sentences, 60 words total. Never start with 'Coach K here'. Never say 'Reply MENU'. Always use the client's actual name. End with exactly one specific action.";
  const winMemory = memoryContext ? `\n\nCOACH K MEMORY — WHAT YOU KNOW ABOUT THIS CLIENT FROM PREVIOUS SESSIONS:\n${memoryContext}\nUse this to reference specific past wins when relevant. Be specific: if they lost 5kg, say "5kg down". If jeans were tighter at week 2 and loose at week 8, say that. Never fabricate wins not in this list.` : "";

  let todayFoodContext = "";
  try {
    const todayStart = sastDayStart();
    const todayFoodLogs = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut, createdAt: chatHistory.createdAt })
      .from(chatHistory)
      .where(and(
        eq(chatHistory.userId, user.id),
        eq(chatHistory.intent, "FOOD_LOG"),
        gte(chatHistory.createdAt, todayStart),
      ))
      .orderBy(chatHistory.createdAt)
      .limit(20);

    if (todayFoodLogs.length > 0) {
      let totalCalToday = 0;
      let totalProtToday = 0;
      const mealSummaries: string[] = [];

      for (const log of todayFoodLogs) {
        const msgIn = log.messageIn || "";
        const msgOut = log.messageOut || "";
        const runningMatch = msgOut.match(/Running total[^\d]*(\d{3,4})\s*kcal\s*|\s*(\d{2,3})g/i);
        const mealTotalMatch = msgOut.match(/Meal total[^\d]*(\d{3,4})\s*kcal\s*|\s*~?(\d{2,3})g/i);
        if (runningMatch) {
          totalCalToday = parseInt(runningMatch[1]);
          totalProtToday = parseInt(runningMatch[2]);
        } else if (mealTotalMatch && !totalCalToday) {
          totalCalToday += parseInt(mealTotalMatch[1]);
          totalProtToday += parseInt(mealTotalMatch[2]);
        }
        if (msgIn && msgIn.length > 3) mealSummaries.push(msgIn.slice(0, 80));
      }

      const calTarget = user.calorieTarget || 1800;
      const protTarget = user.proteinTarget || 120;
      const calRemaining = calTarget - totalCalToday;
      const protRemaining = protTarget - totalProtToday;

      todayFoodContext = `\n\nTODAY'S FOOD LOG (use these exact numbers — NEVER ignore them):\nMeals logged today: ${mealSummaries.join(" | ")}\nRunning total: ${totalCalToday} kcal | ${totalProtToday}g protein\nCalorie target: ${calTarget} kcal → ${calRemaining > 0 ? calRemaining + " kcal remaining" : Math.abs(calRemaining) + " kcal OVER target"}\nProtein target: ${protTarget}g → ${protRemaining > 0 ? protRemaining + "g still needed" : "protein target MET ✅"}\nCRITICAL: When suggesting meals or snacks, account for these already-consumed calories. Never suggest a meal that would push them significantly over their calorie target.`;
    }
  } catch (foodErr) {
    console.warn("[GPT] Could not fetch today's food context:", foodErr);
  }

  let liftContext = "";
  try {
    const recentLifts = await db.select().from(exerciseLogs)
      .where(eq(exerciseLogs.userId, user.id))
      .orderBy(desc(exerciseLogs.loggedAt))
      .limit(10);
    if (recentLifts.length > 0) {
      const seen = new Map<string, typeof recentLifts[0]>();
      for (const l of recentLifts) { if (!seen.has(l.exerciseName)) seen.set(l.exerciseName, l); }
      const lines = [...seen.values()].slice(0, 5).map(l => {
        const w = parseFloat(String(l.weightKg || 0));
        const rStr = l.sets && l.reps ? ` ${l.sets}×${l.reps}` : l.reps ? ` ×${l.reps}` : "";
        const dAgo = Math.floor((Date.now() - new Date(l.loggedAt || "").getTime()) / 86_400_000);
        return `${l.exerciseName}: ${w}kg${rStr} (${dAgo === 0 ? "today" : dAgo + "d ago"})`;
      });
      liftContext = `\n\nCLIENT'S RECENT LIFTS (use these exact numbers — never guess):\n${lines.join("\n")}\nWhen advising on weight/progression, reference these numbers directly.`;
    }
  } catch (liftErr) {
    console.warn("[GPT] Could not fetch lift context:", liftErr);
  }

  const { model, maxTokens } = selectModel(instruction, userMessage);

  const cappedMemory = winMemory.length > 2000 ? winMemory.slice(0, 2000) + "\n[Memory truncated — older entries omitted]" : winMemory;

  let systemContent = `${COACH_K_SYSTEM}\n\n${context}\n\n${patternSummary}${saFlags ? "\n\n" + saFlags : ""}${todayFoodContext}${liftContext}${cappedMemory}\n\n${hardLimit}\n\nINSTRUCTION: ${instruction}`;
  const MAX_SYSTEM_CHARS = 10_000;
  if (systemContent.length > MAX_SYSTEM_CHARS) {
    console.warn(`[GPT] System prompt ${systemContent.length} chars — capping at ${MAX_SYSTEM_CHARS}`);
    const tail = `\n\n${hardLimit}\n\nINSTRUCTION: ${instruction}`;
    systemContent = systemContent.slice(0, MAX_SYSTEM_CHARS - tail.length) + tail;
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
    }

    return response.choices[0]?.message?.content?.trim() || "Sharp. Keep moving forward.";
  } catch (err: any) {
    const status = err?.status ?? err?.statusCode ?? 0;
    const code = err?.code ?? "";
    const msg = err?.message ?? "";

    if (status === 401 || code === 401 || msg.includes("401")) {
      console.error("[GPT] OpenAI auth error (401) — check OPENAI_API_KEY env var:", msg);
      // Alert coach via SMS if configured
      const alertPhone = process.env.COACH_ALERT_PHONE;
      if (alertPhone) {
        import("./scheduler/shared").then(({ sendCriticalAlert }) => {
          sendCriticalAlert(alertPhone, `[KamLife] OpenAI API key invalid or expired (401). GPT is down. Check OPENAI_API_KEY in Railway.`).catch(() => {});
        }).catch(() => {});
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

// ============================================================
// MILESTONE VOICE SCRIPT GENERATOR
// Replaces static hardcoded scripts with a GPT-generated 2-3 sentence
// voice note personalised to the client's engagement this week, their
// history, and their specific achievement numbers.
// Cost: one gpt-4o-mini call per milestone (milestones are rare — negligible).
// Falls back to a static script on any error so voice notes never silently drop.
// ============================================================

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
): Promise<string> {
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

  const toneHint = patternSummary.includes("silent") || patternSummary.includes("no training")
    ? "They have had a rough or inconsistent week. Acknowledge the journey wasn't smooth — this milestone despite the struggle says something real about their character."
    : patternSummary.includes("consistent") || patternSummary.includes("solid")
    ? "They have been consistent and showing up. Build on the momentum — this is who they are now."
    : "Be direct and celebratory — this is a real moment.";

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 120,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `You write short voice note scripts for a South African fitness coach named Coach K. These are spoken aloud to the client so they must sound natural when read out loud.\n\nRULES:\n- Exactly 2-3 sentences. Never more.\n- Start with the client's first name.\n- Reference the exact achievement numbers (do not round or approximate).\n- SA voice: warm, direct, real — not American hype. Use "lekker", "sharp", "eish" naturally if it fits.\n- Never say "I'm Coach K" or "this is Coach K". Never say "keep it up" or "great job".\n- End with ONE specific forward-looking sentence (what they do next, not generic inspiration).\n- No hashtags, emojis, or asterisks.`,
        },
        {
          role: "user",
          content: `Client: ${firstName}, goal: ${goal}, days on programme: ${daysOn}\nMilestone: ${milestoneDescription[milestoneType]}\nTheir week: ${patternSummary || "no recent data"}\nTone guidance: ${toneHint}\n\nWrite the voice note script now.`,
        },
      ],
    });

    const script = response.choices[0]?.message?.content?.trim();
    if (script && script.length > 20) {
      console.log(`[VOICE_SCRIPT] Generated for ${firstName} (${milestoneType}): "${script.slice(0, 80)}..."`);
      return script;
    }
  } catch (err) {
    console.warn("[VOICE_SCRIPT] GPT failed, using fallback:", err);
  }

  return fallbacks[milestoneType];
}

// ============================================================
// INTENT CLASSIFIER
// ============================================================

export type ClassifiedIntent =
  | "FOOD_LOG" | "WORKOUT_LOG" | "STEPS" | "WEIGHT"
  | "QUESTION" | "RANT" | "GREETING" | "MENU_REQUEST" | "OTHER";

export interface IntentClassification {
  intent: ClassifiedIntent;
  confidence: number;
}

const INTENT_FAST_PATHS: Array<[RegExp, ClassifiedIntent]> = [
  [/^(hi|hey|hello|howzit|sawubona|dumelang|ekse|yo|sup|gm|good\s*morning|good\s*afternoon|good\s*evening|good\s*night)[\s!?.]*$/i, "GREETING"],
  [/^(menu|help|options|start|\*menu\*|\*help\*)[\s?]*$/i, "MENU_REQUEST"],
  [/^(\d{4,6})\s*(steps?|step|km|k|miles?)?\s*$/i, "STEPS"],
  [/^(\d{2,3}(?:\.\d+)?)\s*kg\s*$/i, "WEIGHT"],
  [/^(done|finished|completed|session done|workout done|trained today|went to gym|gym done|just finished|just trained)[\s!.]*$/i, "WORKOUT_LOG"],
];

const VALID_INTENTS = new Set<ClassifiedIntent>([
  "FOOD_LOG", "WORKOUT_LOG", "STEPS", "WEIGHT",
  "QUESTION", "RANT", "GREETING", "MENU_REQUEST", "OTHER",
]);

export async function classifyIntent(message: string, userId?: string): Promise<IntentClassification> {
  const m = message.trim();
  if (m.length < 2) return { intent: "OTHER", confidence: 0.95 };

  for (const [pattern, intent] of INTENT_FAST_PATHS) {
    if (pattern.test(m)) return { intent, confidence: 0.95 };
  }

  if (m.length > 500) return { intent: "OTHER", confidence: 0 };

  try {
    const response = await withOpenAIRetry(() => openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 20,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `Classify this WhatsApp message from a South African fitness app user. Respond ONLY with JSON: {"intent":"X","confidence":0.0}\n\nX must be exactly one of:\nFOOD_LOG   - reporting food/drinks eaten (e.g. "I had pap and eggs", "just ate chicken")\nWORKOUT_LOG- reporting completed exercise/session (e.g. "done", "trained today")\nSTEPS      - logging steps walked (e.g. "8500 steps", "walked 6km today")\nWEIGHT     - logging body weight (e.g. "I'm 85kg now", "weighed 78 this morning")\nQUESTION   - asking about fitness, nutrition, or health\nRANT       - venting frustration or emotion (not asking for information)\nGREETING   - purely social opener (hi/hello/morning only)\nMENU_REQUEST - wants menu, options, or help list\nOTHER      - everything else`,
        },
        { role: "user", content: m.slice(0, 300) },
      ],
    }), "classifyIntent");

    const raw = (response.choices[0]?.message?.content || "{}").trim();
    const parsed = JSON.parse(raw) as { intent?: string; confidence?: number };
    const intent: ClassifiedIntent = VALID_INTENTS.has(parsed.intent as ClassifiedIntent)
      ? (parsed.intent as ClassifiedIntent)
      : "OTHER";
    const confidence = typeof parsed.confidence === "number"
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.5;

    if (response.usage && userId) {
      const costUSD = (response.usage.prompt_tokens * 0.00015 + response.usage.completion_tokens * 0.0006) / 1000;
      console.log(`[INTENT] ${intent}(${Math.round(confidence * 100)}%) tokens:${response.usage.total_tokens} $${costUSD.toFixed(5)} user:${userId.slice(-6)}`);
    }

    return { intent, confidence };
  } catch (err) {
    console.warn("[INTENT] Classifier error (non-fatal, falling back):", err);
    return { intent: "OTHER", confidence: 0 };
  }
}
