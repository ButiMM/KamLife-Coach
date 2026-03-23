import OpenAI from "openai";
import { db } from "./db";
import { users, chatHistory, weightLogs, stepLogs, workoutLogs } from "../shared/schema";
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
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

export function buildContext(user: any): string {
  const name = getDisplayName(user) || "a client";
  const goal = user.goalType || "general fitness";
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const steps = user.stepsTarget || 7000;
  // Fix 2 — always use live-calculated targets so GPT sees correct numbers even if DB is stale
  const weight = parseFloat(user.currentWeight || "75");
  const liveTargets = calculateTargets(weight, goal, user.lifeSituation || "office", user.trainingDaysPerWeek || 3);
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

  return `CLIENT PROFILE:
Name: ${name}
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
Experience: ${experience}
Water today: ${water}L
Days on programme: ${Math.floor((Date.now() - new Date(user.createdAt || Date.now()).getTime()) / 86400000)}`;
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
    flags.push("BUDGET MODE ACTIVE: Date is after the 20th. Client may be tight on money. Prioritise cheap high-protein SA foods — eggs, pilchards, sugar beans, pap. Do not suggest expensive supplements or premium foods.");
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
    const [recentChats, recentWeights, olderWeights] = await Promise.all([
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

export function selectModel(instruction: string, userMessage: string): { model: string; maxTokens: number; reason: string } {
  const GPT4O_SIGNALS = [
    "programme", "workout plan", "training plan", "beginner", "intermediate", "advanced",
    "diabetes", "diabetic", "hypertension", "blood pressure", "pcos", "hiv", "arv", "tb ",
    "ramadan", "fasting", "pregnancy", "pregnant", "elderly", "injury", "bad knee",
    "bad back", "bad shoulder", "hip problem", "knee replacement",
    "calories", "calorie target", "how much should i eat", "muscle gain", "fat loss",
    "goal change", "want to gain", "want to lose", "supplement stack", "creatine",
    "protein powder", "week 3", "crisis", "suicidal", "self harm",
    "calculate", "formula", "how many calories", "what should i eat for my goal",
  ];

  // Check user message first — this is the primary routing signal
  const msgLower = userMessage.toLowerCase();
  const matchedMsg = GPT4O_SIGNALS.find(signal => msgLower.includes(signal));
  if (matchedMsg) {
    console.log(`[MODEL] gpt-4o selected — user message matched: "${matchedMsg}" | msg: "${userMessage.slice(0, 60)}"`);
    return { model: "gpt-4o", maxTokens: 600, reason: matchedMsg };
  }

  // Check the extra instruction only when it is short (utility calls like celebrations)
  // Skip scanning the full handleMessage instruction template — it always contains signals
  if (instruction.length < 200) {
    const instrLower = instruction.toLowerCase();
    const matchedInstr = GPT4O_SIGNALS.find(signal => instrLower.includes(signal));
    if (matchedInstr) {
      console.log(`[MODEL] gpt-4o selected — instruction matched: "${matchedInstr}"`);
      return { model: "gpt-4o", maxTokens: 600, reason: matchedInstr };
    }
  }

  console.log(`[MODEL] gpt-4o-mini selected | msg: "${userMessage.slice(0, 60)}"`);
  return { model: "gpt-4o-mini", maxTokens: 250, reason: "simple response" };
}

export async function askCoachK(userMessage: string, user: any, extraInstruction?: string): Promise<string> {
  const context = buildContext(user);
  const patternSummary = await buildPatternSummary(user);
  console.log(`[PATTERN] ${patternSummary}`);
  // Addition 5 — SA seasonal/cultural flags injected into every GPT call (user-aware)
  const saFlags = getSAContextFlags(user);
  const instruction = extraInstruction || "Respond as Coach K to this client message.";
  const hardLimit = "HARD RULE: Max 3 sentences, 60 words total. Never start with 'Coach K here'. Never say 'Reply MENU'. Always use the client's actual name. End with exactly one specific action.";
  const { model, maxTokens } = selectModel(instruction, userMessage);

  try {
    const response = await openai.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "system",
          content: `${COACH_K_SYSTEM}\n\n${context}\n\n${patternSummary}${saFlags ? "\n\n" + saFlags : ""}\n\n${hardLimit}\n\nINSTRUCTION: ${instruction}`
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });
    return response.choices[0]?.message?.content?.trim() || "Sharp. Keep moving forward.";
  } catch (err: any) {
    console.error("OpenAI error:", err);
    if (err?.status === 401 || err?.code === 401 || (err?.message && err.message.includes("401"))) {
      return "Coach K is almost ready. Type *menu* to see your options or *calories* for your daily target. Your programme, meal plan, and targets are all set.";
    }
    return "Eish Coach K had a moment. Try that again.";
  }
}
