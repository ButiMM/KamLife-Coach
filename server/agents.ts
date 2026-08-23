import OpenAI from "openai";
import { queryFoodDatabase } from "./foods";
import { HANDLING_CONFUSION } from "./coach-prompt";
import { assertAiOnline, isAiOfflineError } from "./ai-offline";
import { getDisplayName } from "./utils";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-missing-key",
});

const ADVISOR_LIMIT = "You are a domain advisor to Coach K, not the Coach. Return 2–4 short factual notes. No greeting, no 'you should', no walk/train/rest/weigh/log instruction, no customer-facing paragraph. Facts and food or programme details only.";

// ============================================================
// NUTRITION AGENT
// ============================================================

const NUTRITION_SYSTEM = `You are Coach K's nutrition specialist. You have 20 years of SA nutrition coaching experience and deep knowledge of South African foods — pap, pilchards, vetkoek, morogo, umngqusho, kota, magwinya, smileys, mogodu, chakalaka, biltong, Maltabella, Mageu, Jungle Oats.

ABSOLUTE RULES:
- Use the exact calorie and protein numbers provided to you — never estimate when database values are given
- Never say "Great choice" or "Good choice" as standalone praise
- Never give a bulleted list in a conversational response
- One food swap suggestion maximum — never give 3 things to fix
- Never mention water unless the client specifically asked about water`;

export async function nutritionAgent(user: any, message: string, memoryContext: string, saFlags: string, liveSnapshot = ""): Promise<string> {
  const name = getDisplayName(user) || "there";
  const goal = user.goalType || "fat_loss";
  const calorieTarget = user.calorieTarget || 1800;
  const proteinTarget = user.proteinTarget || 120;
  const budget = user.weeklyFoodBudget || "100_300";
  const medicalConditions = user.medicalConditions || "none";
  const protocol = user.nutritionProtocol || "";

  let foodDbContext = "";
  try {
    const matches = await queryFoodDatabase(message);
    if (matches.length > 0) {
      const best = matches[0];
      foodDbContext = `\n\nSA FOOD DATABASE MATCH: "${best.name}" — ${best.portionDescription} = ${best.portionCalories} kcal, ${best.portionProtein}g protein. Notes: ${best.notes}. Use these exact numbers.`;
    }
  } catch { }

  const systemPrompt = `${NUTRITION_SYSTEM}

${HANDLING_CONFUSION}

CLIENT PROFILE:
Name: ${name}
Goal: ${goal}
Calorie target: ${calorieTarget} kcal/day
Protein target: ${proteinTarget}g/day
Weekly food budget: ${budget}
Medical conditions: ${medicalConditions}
Nutrition protocol: ${protocol || "standard"}
${liveSnapshot ? `\nTHIS CLIENT'S LIVE PICTURE RIGHT NOW (real data — today's food, protein trend, weight direction; use these exact numbers, never generic advice when you can name where they actually are):\n${liveSnapshot}\n` : ""}${saFlags ? "\n" + saFlags : ""}${foodDbContext}${memoryContext ? "\n\nCOACH K MEMORY — WHAT YOU KNOW ABOUT THIS CLIENT FROM PREVIOUS SESSIONS:\n" + memoryContext : ""}

${ADVISOR_LIMIT}`;

  try {
    assertAiOnline("agent");
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ]
    });
    return response.choices[0]?.message?.content?.trim() || "Log that and keep your protein up today.";
  } catch (err) {
    if (!isAiOfflineError(err)) console.error("[NUTRITION_AGENT]", err);
    return "Eish Coach K had a moment. Try that again.";
  }
}

// ============================================================
// PROGRAMMING AGENT
// ============================================================

const PROGRAMMING_SYSTEM = `You are Coach K's programming specialist. You know the KamLife programme philosophy: machine and cable based compound movements for gym clients, full body for beginners, upper lower for intermediate, push pull legs for advanced. For home clients — always 6 exercises, full body, no equipment assumed beyond bodyweight.

ABSOLUTE RULES:
- Never give bicycle kicks, bosu balls, resistance band circles, or gimmick exercises
- Never give fewer than 6 exercises for a home session
- Always include YouTube links in this format: https://www.youtube.com/results?search_query=exercise+name+tutorial
- Always include form cue and common mistake for every exercise
- Always give sets, reps, rest period
- Never give circuit training for strength goals
- Progressive overload is the only rule — more weight or more reps every session
- Always use the client's actual name`;

export async function programmingAgent(user: any, message: string, memoryContext: string, programme: string, saFlags: string, liveSnapshot = ""): Promise<string> {
  const name = getDisplayName(user) || "there";
  const mode = user.trainingMode || "home";
  const experience = user.trainingExperience || "beginner";
  const days = user.trainingDaysPerWeek || 3;
  const injuries = user.injuries || "none";
  const goal = user.goalType || "fat_loss";
  const medConditions = user.medicalConditions || "none";

  const systemPrompt = `${PROGRAMMING_SYSTEM}

${HANDLING_CONFUSION}

CLIENT PROFILE:
Name: ${name}
Training mode: ${mode}
Experience: ${experience}
Training days per week: ${days}
Injuries: ${injuries}
Goal: ${goal}
Medical conditions: ${medConditions}
${liveSnapshot ? `\nTHIS CLIENT'S LIVE PICTURE RIGHT NOW (real data — sessions, streak, weight direction, sick state; reference where they actually are, never generic):\n${liveSnapshot}\n` : ""}${saFlags ? "\n" + saFlags : ""}${memoryContext ? "\n\nCOACH K MEMORY — WHAT YOU KNOW ABOUT THIS CLIENT FROM PREVIOUS SESSIONS:\n" + memoryContext : ""}

THEIR CURRENT PROGRAMME (${mode.toUpperCase()}, ${experience.toUpperCase()}):
${programme}

${ADVISOR_LIMIT}`;

  try {
    assertAiOnline("agent");
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 800,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ]
    });
    return response.choices[0]?.message?.content?.trim() || "Check the programme above and get your session done today.";
  } catch (err) {
    if (!isAiOfflineError(err)) console.error("[PROGRAMMING_AGENT]", err);
    return "Eish Coach K had a moment. Try that again.";
  }
}

// ============================================================
// MINDSET AGENT
// ============================================================

const MINDSET_SYSTEM = `You are Coach K's mindset specialist. You understand South African life pressures — load shedding, month-end stress, township life, domestic work exhaustion, student pressure, unemployment anxiety, family obligations, social eating pressure, taxi commutes.

ABSOLUTE RULES:
- Acknowledge the emotion in one sentence first — always
- Never say "I hear your frustration" as a standalone phrase
- Never say "you've got this" or "believe in yourself" as standalone statements
- Never give a list of tips
- One specific actionable step at the end — not a list, one step — and ONLY if the person is not in crisis
- Use one real data point showing progress if available
- Never be a cheerleader. Be a coach
- Coach the person, not the behaviour
- Never say "I am here to support you" as a standalone sentence
- Max 3 sentences total
- CRITICAL: If the client expresses thoughts of suicide, self-harm, or being better off dead — do NOT give fitness advice. Direct them to SADAG 0800 567 567 (free, 24/7). This overrides all other rules.`;

const CRISIS_KEYWORDS = [
  "want to die", "want to kill myself", "kill myself", "end my life", "suicide", "suicidal",
  "hurt myself", "harm myself", "self harm", "self-harm", "cut myself", "not worth living",
  "life is not worth", "life isn't worth", "no reason to live", "better off dead",
  "thinking about death", "want to disappear", "want it to end",
];

// DEEP EMOTIONAL SUPPORT (2026-07-14) — for a long, vulnerable share (the 5-6 minute
// voice-note dump) or a "tried everything / ready to quit" moment. Overrides the terse
// 3-sentence cap: matching the weight of what the person gave you IS the support. This
// is the accountability partner Kam's manual clients stay for.
const DEEP_EMOTIONAL_SYSTEM = `You are Coach K — a warm, grounded South African coach who is, above all, an ACCOUNTABILITY PARTNER. This client has just opened up to you (often a long voice note). Do NOT be brief or clinical here — meet them properly.

HOW TO RESPOND (4-7 sentences, warm, human, plain SA English — NOT a wall, NOT a list):
1. FIRST, reflect back the SPECIFIC thing they said so they know you actually heard them — not "I hear your frustration", but the real content ("Being back where you started after everything you've put in — that's exhausting, and it's fair to feel it").
2. If they mention having TRIED EVERYTHING (diets, GLP-1/Ozempic/Wegovy, shakes, pills, yo-yo): name the truth — it was NOT a willpower failure and NOT their fault. Those things fail most people because they're done ALONE and all-or-nothing. The one thing that was missing is what they have now: someone in it with them, and small consistent steps instead of perfection.
3. Give honest hope grounded in psychology, not cheerleading: bodies respond to CONSISTENCY, not intensity; the shame cycle (fail → quit → shame → try harder → fail) breaks when you stop needing to be perfect. Reference a real data point if given.
4. The accountability push, gently: they won't quit this time because they're not doing it alone — you're checking in, you've got them. Say it like you mean it.
5. ONE small, doable next step (not a list) — the smallest possible win.
6. END with a genuine question that invites them to keep talking — people need to feel heard, not managed.

HARD RULES:
- Never a numbered list or bullet points to the client — flowing, human sentences.
- Never therapist-speak clichés ("I hear you", "you've got this", "I'm here to support you", "it sounds like") as standalone phrases.
- Never minimise ("at least…", "just think positive").
- Warm and real, like a coach who genuinely cares — never a hype-man, never a robot.
- CRISIS OVERRIDE: any mention of suicide, self-harm, or being better off dead → stop coaching, give SADAG 0800 567 567 (free, 24/7), and say they don't have to carry it alone.`;

export async function mindsetAgent(user: any, message: string, memoryContext: string, liveSnapshot: string, saFlags: string, deep = false): Promise<string> {
  // Crisis intercept — never route to fitness coaching for active crisis signals
  const mLower = message.toLowerCase();
  if (CRISIS_KEYWORDS.some(kw => mLower.includes(kw))) {
    const firstName = (user.name || "").split(" ")[0];
    return `${firstName ? firstName + ", I" : "I"} hear you and I'm taking this seriously. Please reach out right now:\n\n*SADAG* 0800 567 567 — free, 24/7, confidential\n*SMS* 31393\n\nYou don't have to carry this alone. Call them now — they are trained for exactly this moment. I'll be here when you're ready.`;
  }

  const name = getDisplayName(user) || "there";
  const situation = user.lifeSituation || "office";
  const workouts = user.totalWorkoutsCompleted || 0;

  const base = deep ? DEEP_EMOTIONAL_SYSTEM : MINDSET_SYSTEM;
  const systemPrompt = `${base}

${HANDLING_CONFUSION}

CLIENT PROFILE:
Name: ${name}
Life situation: ${situation}
Total workouts completed: ${workouts}
${liveSnapshot
  ? `\nTHIS CLIENT'S LIVE PICTURE RIGHT NOW (real data — reference it specifically, never reply with generic empathy when you can name their actual numbers, streak, or today):\n${liveSnapshot}`
  : "Real data point to reference: They showed up and sent this message — that means they have not quit."}
${saFlags ? "\n" + saFlags : ""}${memoryContext ? "\n\nCOACH K MEMORY — WHAT YOU KNOW ABOUT THIS CLIENT FROM PREVIOUS SESSIONS:\n" + memoryContext : ""}

${ADVISOR_LIMIT}`;

  try {
    assertAiOnline("agent");
    const response = await openai.chat.completions.create({
      // A person who opened up deserves the better model + room to answer properly.
      model: deep ? "gpt-4o" : "gpt-4o-mini",
      max_tokens: deep ? 400 : 150,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ]
    });
    return response.choices[0]?.message?.content?.trim() || "I hear you — that's a lot to carry. Talk to me, what's weighing on you most right now?";
  } catch (err) {
    if (!isAiOfflineError(err)) console.error("[MINDSET_AGENT]", err);
    return "Eish Coach K had a moment. Try that again.";
  }
}

// ============================================================
// ADMIN AGENT
// ============================================================

const ADMIN_SYSTEM = `You are Coach K's admin specialist. You handle all tracking and logging confirmations. You are precise, fast, and specific. You never give generic responses.

ABSOLUTE RULES:
- Confirm what was logged with the exact number
- Compare to their target
- Give one specific coaching note — not a list
- Keep responses under 3 sentences
- Always be specific to their data — never generic
- Always use the client's actual name`;

export async function adminAgent(user: any, message: string, logType: string, logValue: string, targetValue: string): Promise<string> {
  const name = getDisplayName(user) || "there";

  const systemPrompt = `${ADMIN_SYSTEM}

CLIENT: ${name}
Log type: ${logType}
What was logged: ${logValue}
Their target: ${targetValue}

${ADVISOR_LIMIT}`;

  try {
    assertAiOnline("agent");
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 100,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ]
    });
    return response.choices[0]?.message?.content?.trim() || "Logged. Keep going.";
  } catch (err) {
    if (!isAiOfflineError(err)) console.error("[ADMIN_AGENT]", err);
    return "Eish Coach K had a moment. Try that again.";
  }
}

// ============================================================
// AGENT ROUTER — decides which agent handles the message
// ============================================================

type AgentType = "nutrition" | "programming" | "mindset" | "admin" | "general";

const NUTRITION_KW = ["ate", "eaten", "eat", "had", "having", "food", "meal", "calories", "calorie", "protein", "hungry", "hunger", "diet", "supplement", "creatine", "pilchards", "eggs", "pap", "vetkoek", "kota", "morogo", "umngqusho", "samp", "oats", "rice", "bread", "chicken", "beef", "fish", "beans", "sugar beans", "spinach", "banana", "biltong", "polony", "mageu", "maltabella", "yoghurt", "cottage", "butter", "peanut butter", "braai", "cook", "cooked", "ate today", "what should i eat", "meal plan", "food budget", "shopping", "lunch", "breakfast", "dinner", "snack", "whey", "fat burner", "pre workout", "before training", "after training", "post workout", "burger", "pizza", "steak", "cereal", "sushi", "salad", "sandwich"];
const PROGRAMMING_KW = ["programme", "program", "workout", "exercise", "gym", "training", "session", "sets", "reps", "how to do", "youtube", "home workout", "bench", "squat", "deadlift", "push up", "pull up", "leg press", "form", "technique", "give me a program", "what do i do today", "today's workout", "training plan", "rest day"];
const MINDSET_KW = ["quit", "give up", "tired", "frustrated", "not working", "no results", "stressed", "anxious", "overwhelmed", "cant do this", "can't do this", "unmotivated", "lazy", "failing", "failed", "struggling", "struggle", "depressed", "motivation", "no energy", "energy low", "want to stop", "this is hard", "too hard", "nothing is changing", "comparison", "feel fat", "feel ugly", "not good enough", "disappointed", "bad weekend", "messed up", "scale panic", "weight went up"];
const ADMIN_KW = ["done", "completed", "finished", "logged", "steps today", "weighed myself", "my weight is", "walked", "kg this morning", "check in", "weekly report", "how am i doing", "my progress", "on track", "workout done", "session done"];

export function routeToAgent(message: string): AgentType {
  const m = message.toLowerCase();

  let nutritionScore = 0;
  let programmingScore = 0;
  let mindsetScore = 0;
  let adminScore = 0;

  for (const kw of NUTRITION_KW) if (m.includes(kw)) nutritionScore++;
  for (const kw of PROGRAMMING_KW) if (m.includes(kw)) programmingScore++;
  for (const kw of MINDSET_KW) if (m.includes(kw)) mindsetScore++;
  for (const kw of ADMIN_KW) if (m.includes(kw)) adminScore++;

  const max = Math.max(nutritionScore, programmingScore, mindsetScore, adminScore);
  if (max === 0) return "general";
  if (max === nutritionScore) return "nutrition";
  if (max === programmingScore) return "programming";
  if (max === mindsetScore) return "mindset";
  if (max === adminScore) return "admin";
  return "general";
}
