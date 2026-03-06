import OpenAI from "openai";
import { queryFoodDatabase } from "./foods";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const HARD_LIMIT = "HARD RULE: Max 3 sentences. 60 words maximum for conversational responses. Always end with one specific action. Never use bullets in conversation. Always use the client's actual name.";

// ============================================================
// NUTRITION AGENT
// ============================================================

const NUTRITION_SYSTEM = `You are Coach K's nutrition specialist. You have 20 years of SA nutrition coaching experience and deep knowledge of South African foods — pap, pilchards, vetkoek, morogo, umngqusho, kota, magwinya, smileys, mogodu, chakalaka, biltong, Maltabella, Mageu, Jungle Oats.

ABSOLUTE RULES:
- Use the exact calorie and protein numbers provided to you — never estimate when database values are given
- Never say "Great choice" or "Good choice" as standalone praise
- Never give a bulleted list in a conversational response
- One food swap suggestion maximum — never give 3 things to fix
- Coach the next meal, not the last mistake
- Never mention water unless the client specifically asked about water
- Always use the client's actual name`;

export async function nutritionAgent(user: any, message: string, memoryContext: string, saFlags: string): Promise<string> {
  const name = user.name || "there";
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

CLIENT PROFILE:
Name: ${name}
Goal: ${goal}
Calorie target: ${calorieTarget} kcal/day
Protein target: ${proteinTarget}g/day
Weekly food budget: ${budget}
Medical conditions: ${medicalConditions}
Nutrition protocol: ${protocol || "standard"}
${saFlags ? "\n" + saFlags : ""}${foodDbContext}${memoryContext ? "\n\nCOACH K MEMORY — WHAT YOU KNOW ABOUT THIS CLIENT FROM PREVIOUS SESSIONS:\n" + memoryContext : ""}

${HARD_LIMIT}`;

  try {
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
    console.error("[NUTRITION_AGENT]", err);
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

export async function programmingAgent(user: any, message: string, memoryContext: string, programme: string, saFlags: string): Promise<string> {
  const name = user.name || "there";
  const mode = user.trainingMode || "home";
  const experience = user.trainingExperience || "beginner";
  const days = user.trainingDaysPerWeek || 3;
  const injuries = user.injuries || "none";
  const goal = user.goalType || "fat_loss";
  const medConditions = user.medicalConditions || "none";

  const systemPrompt = `${PROGRAMMING_SYSTEM}

CLIENT PROFILE:
Name: ${name}
Training mode: ${mode}
Experience: ${experience}
Training days per week: ${days}
Injuries: ${injuries}
Goal: ${goal}
Medical conditions: ${medConditions}
${saFlags ? "\n" + saFlags : ""}${memoryContext ? "\n\nCOACH K MEMORY — WHAT YOU KNOW ABOUT THIS CLIENT FROM PREVIOUS SESSIONS:\n" + memoryContext : ""}

THEIR CURRENT PROGRAMME (${mode.toUpperCase()}, ${experience.toUpperCase()}):
${programme}

${HARD_LIMIT}`;

  try {
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
    console.error("[PROGRAMMING_AGENT]", err);
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
- One specific actionable step at the end — not a list, one step
- Use one real data point showing progress if available
- Never be a cheerleader. Be a coach
- Coach the person, not the behaviour
- Never say "I am here to support you" as a standalone sentence
- Max 3 sentences total`;

export async function mindsetAgent(user: any, message: string, memoryContext: string, dataPoint: string, saFlags: string): Promise<string> {
  const name = user.name || "there";
  const situation = user.lifeSituation || "office";
  const workouts = user.totalWorkoutsCompleted || 0;

  const systemPrompt = `${MINDSET_SYSTEM}

CLIENT PROFILE:
Name: ${name}
Life situation: ${situation}
Total workouts completed: ${workouts}
Real data point to reference: ${dataPoint || "They showed up and sent this message — that means they have not quit."}
${saFlags ? "\n" + saFlags : ""}${memoryContext ? "\n\nCOACH K MEMORY — WHAT YOU KNOW ABOUT THIS CLIENT FROM PREVIOUS SESSIONS:\n" + memoryContext : ""}

${HARD_LIMIT}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 150,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ]
    });
    return response.choices[0]?.message?.content?.trim() || "That feeling is real. One session changes everything — do it today.";
  } catch (err) {
    console.error("[MINDSET_AGENT]", err);
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
  const name = user.name || "there";

  const systemPrompt = `${ADMIN_SYSTEM}

CLIENT: ${name}
Log type: ${logType}
What was logged: ${logValue}
Their target: ${targetValue}

${HARD_LIMIT}`;

  try {
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
    console.error("[ADMIN_AGENT]", err);
    return "Eish Coach K had a moment. Try that again.";
  }
}

// ============================================================
// AGENT ROUTER — decides which agent handles the message
// ============================================================

type AgentType = "nutrition" | "programming" | "mindset" | "admin" | "general";

const NUTRITION_KW = ["ate", "eaten", "eat", "food", "meal", "calories", "calorie", "protein", "hungry", "hunger", "diet", "supplement", "creatine", "pilchards", "eggs", "pap", "vetkoek", "kota", "morogo", "umngqusho", "samp", "oats", "rice", "bread", "chicken", "beef", "fish", "beans", "sugar beans", "spinach", "banana", "biltong", "polony", "mageu", "maltabella", "yoghurt", "cottage", "butter", "peanut butter", "braai", "cook", "cooked", "ate today", "what should i eat", "meal plan", "food budget", "shopping", "lunch", "breakfast", "dinner", "snack", "whey", "fat burner", "pre workout"];
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
