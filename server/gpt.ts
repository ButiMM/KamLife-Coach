import OpenAI from "openai";
import { db } from "./db";
import { users, chatHistory, weightLogs, stepLogs, workoutLogs, exerciseLogs } from "../shared/schema";
import { eq, desc, and, gte, lt, sql } from "drizzle-orm";
import { COACH_K_SYSTEM } from "./coach-prompt";
import { getPhaseNames } from "./programme";
import { calculateTargets } from "./targets";

// Local utility — avoids circular dep with routes.ts
function getDisplayName(user: any): string {
  const INVALID = new Set(["HI", "HEY", "HELLO", "YES", "NO", "OK", "OKAY", "MENU", "HELP", "DONE", "USER", "THERE"]);
  if (!user.name || user.name.length < 2 || INVALID.has((user.name || "").toUpperCase())) return "";
  return user.name;
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
  const liveTargets = calculateTargets(weight, goal, user.lifeSituation || "office", user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, user.heightCm || 170);
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

  return `CLIENT PROFILE:
Name: ${name}
Gender: ${gender}
Goal: ${goal}
Age: ${age}
Phase: ${phase} — ${phaseName}
Calorie target: ${calories}
Protein target: ${protein}g
Step target: ${steps}
Training mode: ${mode}
Equipment: ${equipment}
Life situation: ${situation}
Job type: ${job}
Activity level: ${activity}
Primary focus: ${focus}
Injuries: ${injuries}
Medical conditions: ${medicalConditions}
Experience: ${experience}
Water today: ${water}L
Days on programme: ${daysOnProgramme} (week ${weeksOnProgramme})
Compliance level: ${user.complianceLevel || 'RESET'}
Workout streak: ${user.workoutStreak || 0} consecutive sessions
Total sessions completed: ${user.totalWorkoutsCompleted || 0}
Programme week: ${user.programmeWeek || 1}
Subscription status: ${user.subscriptionStatus || 'inactive'}

${coachingTone}
${ageGuidelines}${medicalDisclaimer}`;
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
  const name = getDisplayName(user) || "client";
  const proteinTarget = user.proteinTarget || 120;
  const programmeWeek = user.programmeWeek || 1;
  const today = new Date();
  const sevenDaysAgo = new Date(today.getTime() - 7 * 86_400_000);
  sevenDaysAgo.setHours(0, 0, 0, 0);
  const fourteenDaysAgo = new Date(today.getTime() - 14 * 86_400_000);

  try {
    // ---- Parallel DB queries ----
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

    // ---- Days logged vs silent ----
    const daysWithLogs = new Set(
      recentChats.map(c => new Date(c.createdAt || "").toLocaleDateString("en-ZA"))
    ).size;
    const daysSilent = 7 - daysWithLogs;

    // ---- Protein estimate from food log GPT responses ----
    const foodLogs = recentChats.filter(c => c.intent === "FOOD_LOG");
    const proteinNums: number[] = [];
    for (const log of foodLogs) {
      const m = (log.messageOut || "").match(/(\d{2,3})g?\s*(?:of\s+)?protein/i);
      if (m) proteinNums.push(parseInt(m[1]));
    }
    const avgProtein = proteinNums.length >= 2
      ? Math.round(proteinNums.reduce((a, b) => a + b, 0) / proteinNums.length)
      : null;

    // ---- Scan message text for signals ----
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

    // ---- Training sessions ----
    const DONE_PATTERN = /^(done|workout done|finished|completed)$/;
    const trainingLogs = recentChats.filter(c =>
      DONE_PATTERN.test((c.messageIn || "").toLowerCase().trim()) || c.intent === "WORKOUT_LOG"
    );
    const lastTraining = trainingLogs[0];
    const daysSinceTraining = lastTraining?.createdAt
      ? Math.floor((Date.now() - new Date(lastTraining.createdAt).getTime()) / 86_400_000)
      : null;

    // ---- Weight trend ----
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

    // ---- Assemble paragraph ----
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

    // ---- Step compliance ----
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

    // ---- Weekend pattern detection ----
    const weekendChats = recentChats.filter(c => {
      const day = new Date(c.createdAt || "").getDay();
      return day === 0 || day === 6; // Sun or Sat
    });
    const weekdayChats = recentChats.filter(c => {
      const day = new Date(c.createdAt || "").getDay();
      return day >= 1 && day <= 5;
    });
    if (weekdayChats.length > 3 && weekendChats.length === 0) {
      parts.push("Pattern: Active on weekdays, silent on weekends — weekend accountability needed.");
    }

    // ---- Food logging consistency ----
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

    return parts.join(" ");
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

// Crisis-only signals that justify GPT-4o for text (quality matters for safety)
const GPT4O_TEXT_SIGNALS = [
  "suicidal", "suicide", "self harm", "self-harm", "want to die", "kill myself",
  "end it all", "no reason to live", "want to hurt myself",
];

export function selectModel(instruction: string, userMessage: string): { model: string; maxTokens: number; reason: string } {
  const msgLower = userMessage.toLowerCase();

  // GPT-4o only for genuine crisis — safety requires best model
  const crisis = GPT4O_TEXT_SIGNALS.find(s => msgLower.includes(s));
  if (crisis) {
    console.log(`[MODEL] gpt-4o (crisis) — matched: "${crisis}"`);
    return { model: "gpt-4o", maxTokens: 400, reason: "crisis" };
  }

  // GPT-4o for complex coaching that needs nuanced, accurate advice
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

  // Everything else: gpt-4o-mini — coaching quality is equal, cost is 15x lower
  console.log(`[MODEL] gpt-4o-mini | msg: "${userMessage.slice(0, 60)}"`);
  return { model: "gpt-4o-mini", maxTokens: 280, reason: "coaching" };
}

export async function isUnderGPTCallLimit(userId: string): Promise<boolean> {
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    // Only count messages the CLIENT actually sent (messageIn not empty) — excludes scheduler proactive messages
    const result = await db.select({ count: sql`count(*)` })
      .from(chatHistory)
      .where(and(
        eq(chatHistory.userId, userId),
        gte(chatHistory.createdAt, todayStart),
        sql`message_in IS NOT NULL AND message_in != ''`
      ));
    const count = parseInt(String(result[0]?.count || 0));
    return count < 40; // 40 client-initiated messages per day
  } catch {
    return true; // fail open
  }
}

export async function askCoachK(userMessage: string, user: any, extraInstruction?: string, memoryContext?: string): Promise<string> {
  const context = buildContext(user);
  const patternSummary = await buildPatternSummary(user);
  console.log(`[PATTERN] ${patternSummary}`);
  // Addition 5 — SA seasonal/cultural flags injected into every GPT call (user-aware)
  const saFlags = getSAContextFlags(user);
  const instruction = extraInstruction || "Respond as Coach K to this client message.";
  const hardLimit = "HARD RULE: Max 3 sentences, 60 words total. Never start with 'Coach K here'. Never say 'Reply MENU'. Always use the client's actual name. End with exactly one specific action.";
  const winMemory = memoryContext ? `\n\nCOACH K MEMORY — WHAT YOU KNOW ABOUT THIS CLIENT FROM PREVIOUS SESSIONS:\n${memoryContext}\nUse this to reference specific past wins when relevant. Be specific: if they lost 5kg, say "5kg down". If jeans were tighter at week 2 and loose at week 8, say that. Never fabricate wins not in this list.` : "";

  // ── TODAY'S FOOD LOG — injected so GPT knows exactly what they've eaten today ──
  // Without this, GPT suggests dinner without knowing 1,767 kcal was already consumed.
  let todayFoodContext = "";
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayFoodLogs = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut, createdAt: chatHistory.createdAt })
      .from(chatHistory)
      .where(and(
        eq(chatHistory.userId, user.id),
        eq(chatHistory.intent, "FOOD_LOG"),
        gte(chatHistory.createdAt, todayStart),
      ))
      .orderBy(chatHistory.createdAt)
      .limit(10);

    if (todayFoodLogs.length > 0) {
      // Extract calorie/protein totals from the running total line in each bot response
      let totalCalToday = 0;
      let totalProtToday = 0;
      const mealSummaries: string[] = [];

      for (const log of todayFoodLogs) {
        const msgIn = log.messageIn || "";
        const msgOut = log.messageOut || "";
        // Try to get running total from bot response
        const runningMatch = msgOut.match(/Running total[^\d]*(\d{3,4})\s*kcal\s*\|\s*(\d{2,3})g/i);
        const mealTotalMatch = msgOut.match(/Meal total[^\d]*(\d{3,4})\s*kcal\s*\|\s*~?(\d{2,3})g/i);
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

      todayFoodContext = `\n\nTODAY'S FOOD LOG (use these exact numbers — NEVER ignore them):
Meals logged today: ${mealSummaries.join(" | ")}
Running total: ${totalCalToday} kcal | ${totalProtToday}g protein
Calorie target: ${calTarget} kcal → ${calRemaining > 0 ? calRemaining + " kcal remaining" : Math.abs(calRemaining) + " kcal OVER target"}
Protein target: ${protTarget}g → ${protRemaining > 0 ? protRemaining + "g still needed" : "protein target MET ✅"}
CRITICAL: When suggesting meals or snacks, account for these already-consumed calories. Never suggest a meal that would push them significantly over their calorie target.`;
    }
  } catch (foodErr) {
    console.warn("[GPT] Could not fetch today's food context:", foodErr);
  }

  // Inject recent lift data so GPT can reference real numbers (never fabricate)
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

  // Cap winMemory to prevent context blowout for long-running users
  const cappedMemory = winMemory.length > 2000 ? winMemory.slice(0, 2000) + "\n[Memory truncated — older entries omitted]" : winMemory;

  // Assemble system prompt and enforce hard character ceiling (~10k chars)
  let systemContent = `${COACH_K_SYSTEM}\n\n${context}\n\n${patternSummary}${saFlags ? "\n\n" + saFlags : ""}${todayFoodContext}${liftContext}${cappedMemory}\n\n${hardLimit}\n\nINSTRUCTION: ${instruction}`;
  const MAX_SYSTEM_CHARS = 10_000;
  if (systemContent.length > MAX_SYSTEM_CHARS) {
    console.warn(`[GPT] System prompt ${systemContent.length} chars — capping at ${MAX_SYSTEM_CHARS}`);
    // Preserve the essential tail (hardLimit + instruction) when truncating
    const tail = `\n\n${hardLimit}\n\nINSTRUCTION: ${instruction}`;
    systemContent = systemContent.slice(0, MAX_SYSTEM_CHARS - tail.length) + tail;
  }

  // Fetch last 6 messages for conversation context so GPT understands the flow
  let conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
  try {
    const recentMessages = await db.select({
      messageIn: chatHistory.messageIn,
      messageOut: chatHistory.messageOut,
    }).from(chatHistory)
      .where(eq(chatHistory.userId, user.id))
      .orderBy(desc(chatHistory.createdAt))
      .limit(6);

    // Build in chronological order (oldest first)
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
    const response = await openai.chat.completions.create({
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
    });
    // ── Cost tracking ──────────────────────────────────────
    const usage = response.usage;
    if (usage) {
      const inputTokens = usage.prompt_tokens ?? 0;
      const outputTokens = usage.completion_tokens ?? 0;
      // gpt-4o-mini: $0.00015/1k input, $0.0006/1k output
      // gpt-4o:      $0.005/1k input,   $0.015/1k output
      const isMini = model === "gpt-4o-mini";
      const costUSD = isMini
        ? (inputTokens / 1000) * 0.00015 + (outputTokens / 1000) * 0.0006
        : (inputTokens / 1000) * 0.005   + (outputTokens / 1000) * 0.015;
      const costZAR = costUSD * 18.5; // approximate USD→ZAR
      console.log(`[COST] ${model} | in:${inputTokens} out:${outputTokens} | $${costUSD.toFixed(5)} (~R${costZAR.toFixed(4)}) | user:${user.id?.slice(-6)}`);
    }

    return response.choices[0]?.message?.content?.trim() || "Sharp. Keep moving forward.";
  } catch (err: any) {
    const status = err?.status ?? err?.statusCode ?? 0;
    const code = err?.code ?? "";
    const msg = err?.message ?? "";

    if (status === 401 || code === 401 || msg.includes("401")) {
      console.error("[GPT] OpenAI auth error (401) — check AI_INTEGRATIONS_OPENAI_API_KEY:", msg);
      return "Coach K is almost ready. Type *menu* to see your options or *calories* for your daily target. Your programme, meal plan, and targets are all set.";
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
