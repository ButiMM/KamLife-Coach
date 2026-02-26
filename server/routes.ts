import { type Express } from "express";
import { type Server } from "http";
import { db } from "./db";
import { users, weightLogs, workoutLogs, stepLogs, chatHistory, clothingCheckins, bodyMeasurements, weeklyCheckins } from "../shared/schema";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

// ============================================================
// COACH K MASTER PROMPT — 20 YEARS SA COACHING KNOWLEDGE
// ============================================================

const COACH_K_SYSTEM = `You are Coach K. A South African fitness and nutrition coach with 20 years experience coaching real South Africans — domestic workers, students, executives, nurses, mineworkers, grandmothers, teenagers, and everyone in between. You know South Africa deeply. The food, the culture, the economics, the language, the real struggles.

YOUR VOICE:
Firm. Warm. Direct. Human. SA. Never corporate. Never generic. Never American.
Maximum 3 sentences per response. Always end with ONE specific action.
Never say: "Got it", "Nice", "Great job", "Well done", "Amazing", "As an AI", "I understand that", "That is understandable", "I acknowledge your frustration".

SA LANGUAGE — understand and respond naturally to:
eish, sharp, yebo, ja, aweh, lekker, mara, haibo, aikona, sho, eita, howzit, shame, bru, sis, babe, china, laaitie

FOOD RULES — know every SA food:
- Pap: not the enemy. One fist portion. Always with protein. Never eliminate.
- Samp and beans: excellent. High protein and fibre. Always encourage.
- Kota: coach the filling not the kota. Egg kota beats chips kota.
- Fat cakes and magwinya: finish what you have, do not buy again. Never say throw away.
- KFC: happens. Remove skin. Skip chips. Back on track next meal.
- Viennas and polony: already bought means already bought. Chicken polony next shop.
- Pilchards: always encourage. Elite budget protein.
- Baked beans: excellent. Protein and fibre.
- Speckled Eggs and sweets: finish them, do not restock.
- Green tea: does not improve gut health. Rooibos is better. Correct gently.
- Hennessy, henny, Henry: alcohol. Coach forward not backward.
- Cool drinks, Coke, Fanta: liquid sugar. Flag once only.
- Month end after 20th: always reference R57 budget plan. Eggs R25. Pilchards R12. Sugar beans R20.

LIFE SITUATIONS:
- Student: simple meals, under 15 minutes, under 3 ingredients, budget always tight
- Domestic worker: eats employer food, focus on choices within what is available
- Retail worker: already active all day, higher calorie needs, recovery focus
- Night shift: meal timing shifts, protein before shift, sleep is the challenge
- Unemployed: time rich money limited, R57 plan, frame as eating like an athlete
- Church weekend: enjoy the fellowship, protein first, smaller portions, no guilt
- Ramadan: training after Iftar, suhoor is most important meal, light during fasting hours
- Travelling: hotel or fast food strategy, protein first always, 30 minute room workout available
- Diabetic: low GI carbs, consistent meal timing, train 1 to 2 hours after eating, no skipping meals
- Period: normal for workouts to feel harder, lighter sessions are fine, hydration critical

MINDSET RULES:
- Overwhelmed: one sentence acknowledge, one single action only. Never a list.
- Budget anxiety: immediately say "Your budget does not need to change. Smarter choices with the same money." Before any coaching.
- Bad weekend: redirect to next meal not next Monday. Never say start fresh tomorrow.
- Scale went up: check context first. Water retention, menstrual cycle, muscle gain, sodium.
- Client frustrated or angry: do not be defensive. Acknowledge briefly. Give one action.
- Reset requested: always honour it immediately.
- Diabetic mentioned: acknowledge immediately with specific diabetic coaching.
- Ramadan mentioned: immediately restructure advice around fasting hours.

BANNED RESPONSES:
Never respond with motivational quotes as standalone responses like "One meal at a time" or "The work is the answer" without context.
Never call someone HI or USER. Use their name or say "Coach K here".
Never ignore a direct request. If someone asks for a gym programme give them a gym programme.
Never repeat the same message three times. If a response does not fit the question try a different approach.`;

// ============================================================
// SA FOOD CALORIE ESTIMATES
// ============================================================

const SA_FOOD_CALORIES: Record<string, number> = {
  pap: 350, samp: 300, rice: 200, bread: 80, "brown bread": 70,
  oats: 150, "jungle oats": 150, maltabella: 160, "weet-bix": 130,
  egg: 70, eggs: 140, pilchards: 180, "tinned tuna": 120,
  chicken: 165, "chicken breast": 165, beef: 250, mince: 300,
  "sugar beans": 200, "baked beans": 120, lentils: 180,
  kota: 900, "fat cake": 400, magwinya: 400, vetkoek: 350,
  "russian sausage": 290, polony: 280, viennas: 250,
  "simba chips": 500, niknaks: 480, "bar one": 230,
  "kfc streetwise 2": 800, kfc: 600, "steers burger": 700,
  "peanut butter": 190, avocado: 160, banana: 90,
  "cool drink": 140, coke: 140, fanta: 130,
  beer: 150, "castle": 150, "black label": 160,
  hennessy: 250, henny: 250, "henry and coke": 350, "henny and coke": 350,
  "sweet potato": 130, butternut: 80, spinach: 20, cabbage: 25,
  "mageu": 180, "mahewu": 180, cremora: 60,
  "green tea": 2, rooibos: 2, "latte": 250, "giant latte": 400,
  creatine: 0, "protein shake": 120,
  "stew": 280, "fatty": 350, "pork": 300,
};

function estimateCalories(message: string): number {
  const lower = message.toLowerCase();
  let total = 0;
  for (const [food, cals] of Object.entries(SA_FOOD_CALORIES)) {
    if (lower.includes(food)) total += cals;
  }
  return total || 400;
}

// ============================================================
// EXERCISE LIBRARY — PUSH / PULL / LEGS / CORE
// ============================================================

const WORKOUTS: Record<string, Record<string, Array<{name: string, sets: string, description: string, mistake: string, modification: string}>>> = {
  gym: {
    push: [
      { name: "Bench Press", sets: "3x10", description: "Lie on bench. Bar or dumbbells at chest. Press up until arms extended. Lower slowly. Feet flat.", mistake: "Bouncing bar off chest or flaring elbows 90 degrees.", modification: "Dumbbell press with neutral grip if shoulder pain." },
      { name: "Overhead Press", sets: "3x10", description: "Bar or dumbbells at shoulder height. Press straight overhead. Lower slowly. Core tight throughout.", mistake: "Excessive lower back arch.", modification: "Seated press if lower back pain." },
    ],
    pull: [
      { name: "Barbell Row", sets: "3x10", description: "Hinge forward back flat. Pull bar to lower chest. Squeeze shoulder blades hard at top. Lower slowly.", mistake: "Rounding back or using momentum.", modification: "Single dumbbell row with knee on bench if lower back pain." },
      { name: "Lat Pulldown", sets: "3x10", description: "Sit at machine. Pull bar to upper chest. Lean back slightly. Squeeze back. Return slowly.", mistake: "Pulling with arms not back.", modification: "Use lighter weight and focus on feeling the back." },
    ],
    legs: [
      { name: "Barbell Back Squat", sets: "3x10", description: "Bar on upper back. Feet shoulder width. Lower until thighs parallel. Drive through heels. Chest up.", mistake: "Heels rising or chest collapsing forward.", modification: "Goblet squat with dumbbell if back pain." },
      { name: "Romanian Deadlift", sets: "3x10", description: "Hold dumbbells. Hinge at hips pushing bum back. Lower until hamstring stretch. Drive hips forward to stand.", mistake: "Rounding lower back.", modification: "Reduce range of motion if back pain." },
      { name: "Leg Press", sets: "3x12", description: "Sit in machine. Feet shoulder width on platform. Lower until 90 degrees. Push through heels.", mistake: "Knees caving inward.", modification: "Wider foot position if knee pain." },
    ],
    core: [
      { name: "Plank", sets: "3x30 seconds", description: "Forearms on floor. Body straight from head to heels. Squeeze stomach hard. Hold and breathe.", mistake: "Hips sagging or rising too high.", modification: "Drop knees to floor." },
    ],
    conditioning: [
      { name: "Incline Treadmill Walk", sets: "15 minutes", description: "Incline 8 to 12 percent. Brisk walking pace. Do not hold the rails. Burns fat without destroying recovery.", mistake: "Holding rails which reduces effectiveness.", modification: "Reduce incline if joint pain." },
    ],
  },
  home: {
    push: [
      { name: "Push Up", sets: "3x10", description: "Hands slightly wider than shoulders. Body straight. Lower chest to floor. Push back up.", mistake: "Hips rising or elbows flaring 90 degrees.", modification: "Knees on floor if too hard. Wall push up if knees also painful." },
    ],
    pull: [
      { name: "Table Row", sets: "3x10", description: "Lie under sturdy table. Grip edge. Body straight. Pull chest up to table. Lower slowly.", mistake: "Hips dropping or only pulling with arms.", modification: "Bend knees to make easier." },
    ],
    legs: [
      { name: "Bodyweight Squat", sets: "3x15", description: "Feet shoulder width. Arms forward for balance. Lower like sitting on chair. Push through heels.", mistake: "Knees caving inward.", modification: "Hold chair for balance. Only lower halfway if knee pain." },
      { name: "Glute Bridge", sets: "3x15", description: "Lie on back. Knees bent feet flat. Push hips up. Squeeze glutes hard at top. Lower slowly.", mistake: "Pushing through toes instead of heels.", modification: "Single leg version when this becomes easy." },
      { name: "Reverse Lunge", sets: "3x10 each", description: "Step backward. Lower back knee toward floor. Push through front heel to return.", mistake: "Front knee caving inward.", modification: "Hold chair for balance. Reduce range if knee pain." },
    ],
    core: [
      { name: "Plank", sets: "3x20 seconds", description: "Forearms on floor. Body straight. Squeeze stomach. Hold and breathe.", mistake: "Hips sagging.", modification: "Knees on floor." },
    ],
    conditioning: [
      { name: "Mountain Climbers", sets: "3x20 seconds", description: "Push up position. Drive knees to chest alternating quickly. Hips level.", mistake: "Hips bouncing up with each drive.", modification: "Slow the pace. Elevate hands on chair if wrists hurt." },
    ],
  },
  walk: {
    session: [
      { name: "Brisk Walk", sets: "Phase 1: 15min | Phase 2: 25min | Phase 3: 35min | Phase 4: 45min", description: "Walk fast enough to feel slightly breathless but still able to talk. Arms swinging. Posture tall.", mistake: "Walking too slowly. Comfortable pace does not burn fat.", modification: "Reduce pace if breathless to discomfort. Start shorter if needed." },
    ],
  },
};

function getPhaseMultiplier(phase: number): { sets: string, reps: string, rest: string } {
  switch(phase) {
    case 1: return { sets: "3", reps: "10", rest: "60 seconds" };
    case 2: return { sets: "4", reps: "8", rest: "90 seconds" };
    case 3: return { sets: "4", reps: "6", rest: "120 seconds" };
    case 4: return { sets: "5", reps: "5", rest: "120 seconds" };
    case 5: return { sets: "3", reps: "10", rest: "60 seconds" };
    default: return { sets: "3", reps: "10", rest: "60 seconds" };
  }
}

function getPhaseNames(): Record<number, string> {
  return { 1: "Foundation", 2: "Build", 3: "Push", 4: "Peak", 5: "Deload" };
}

function buildDayWorkout(user: any): string {
  const mode = user.trainingMode || "home";
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const multiplier = getPhaseMultiplier(phase);
  const week = user.programmeWeek || 1;
  const day = user.programmeDayInWeek || 1;

  if (mode === "walk_only" || mode === "walk") {
    const duration = phase === 1 ? "15 minutes" : phase === 2 ? "25 minutes" : phase === 3 ? "35 minutes" : "45 minutes";
    return `*Phase ${phase}: ${phaseName} — Week ${week}*\nToday: Day ${day}\n\n*Brisk Walk — ${duration}*\nWalk fast enough to feel slightly breathless but still able to talk. Arms swinging. Posture tall. Do not stop unless necessary.\n\nReply DONE when finished.`;
  }

  const library = WORKOUTS[mode === "gym" ? "gym" : "home"];
  const push = library.push[0];
  const pull = library.pull[0];
  const legs1 = library.legs[0];
  const legs2 = library.legs[1] || library.legs[0];
  const core = library.core[0];

  const isFemaleGluteFocus = user.primaryFocusArea === "glutes_legs";

  let workout = `*Phase ${phase}: ${phaseName} — Week ${week}*\nToday: Day ${day} | ${multiplier.sets} sets | Rest ${multiplier.rest}\n\n`;

  workout += `*${push.name} — ${multiplier.sets}x${multiplier.reps}*\n${push.description}\n⚠️ ${push.mistake}\n\n`;
  workout += `*${pull.name} — ${multiplier.sets}x${multiplier.reps}*\n${pull.description}\n⚠️ ${pull.mistake}\n\n`;
  workout += `*${legs1.name} — ${multiplier.sets}x${multiplier.reps}*\n${legs1.description}\n⚠️ ${legs1.mistake}\n\n`;

  if (isFemaleGluteFocus) {
    workout += `*${legs2.name} — ${multiplier.sets}x${multiplier.reps}*\n${legs2.description}\n⚠️ ${legs2.mistake}\n\n`;
    if (library.legs[2]) {
      workout += `*${library.legs[2].name} — ${multiplier.sets}x${multiplier.reps}*\n${library.legs[2].description}\n⚠️ ${library.legs[2].mistake}\n\n`;
    }
  }

  workout += `*${core.name} — ${multiplier.sets}x${multiplier.reps}*\n${core.description}\n⚠️ ${core.mistake}\n\n`;
  workout += `Reply DONE when finished.`;

  return workout;
}

// ============================================================
// BUILD USER CONTEXT FOR GPT
// ============================================================

function buildContext(user: any): string {
  const name = user.name && user.name.length > 1 ? user.name : "Coach K here";
  const goal = user.goalType || "general fitness";
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const calories = user.calorieTarget || 1800;
  const protein = user.proteinTarget || 120;
  const steps = user.stepsTarget || 7000;
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
// GPT CALL — ALWAYS USES MASTER PROMPT + FULL CONTEXT
// ============================================================

async function askCoachK(userMessage: string, user: any, extraInstruction?: string): Promise<string> {
  const context = buildContext(user);
  const instruction = extraInstruction || "Respond as Coach K to this client message.";

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 150,
      messages: [
        {
          role: "system",
          content: `${COACH_K_SYSTEM}\n\n${context}\n\nINSTRUCTION: ${instruction}`
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });
    return response.choices[0]?.message?.content?.trim() || "Sharp. Keep moving forward.";
  } catch (err) {
    console.error("OpenAI error:", err);
    return "Something went wrong on my end. Try again in a moment.";
  }
}

// ============================================================
// GET OR CREATE USER
// ============================================================

async function getOrCreateUser(phone: string): Promise<any> {
  const existing = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
  if (existing.length > 0) {
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.phoneNumber, phone));
    return existing[0];
  }
  const newUsers = await db.insert(users).values({
    phoneNumber: phone,
    subscriptionStatus: "trial",
    onboardingState: "START",
    programmePhase: 1,
    programmeWeek: 1,
    programmeDayInWeek: 1,
    trainingMode: "home",
    stepsTarget: 7000,
    createdAt: new Date(),
    lastActiveAt: new Date(),
  }).returning();
  return newUsers[0];
}

// ============================================================
// MENU TEXT
// ============================================================

const MENU = `*KamLife Coach* 💪

What do you need?
1️⃣ Today's workout
2️⃣ Food coaching
3️⃣ Log steps
4️⃣ Log sleep
5️⃣ Log weight
6️⃣ Weekly report
7️⃣ Measurements check-in

Or just tell me what you ate, how training went, your steps, or anything on your mind.`;

// ============================================================
// ONBOARDING FLOW
// ============================================================

async function handleOnboarding(user: any, message: string, phone: string): Promise<string> {
  const state = user.onboardingState || "START";
  const msg = message.trim();

  if (state === "START") {
    await db.update(users).set({ onboardingState: "ASK_NAME" }).where(eq(users.phoneNumber, phone));
    return `Welcome to *KamLife Coach* 👋\n\nNo keto. No detox teas. No shortcuts.\nReal coaching built for real South Africans.\n\nWhat is your name?`;
  }

  if (state === "ASK_NAME") {
    const cleaned = msg.replace(/[^a-zA-Z\s]/g, "").trim();
    const INVALID = new Set(["HI", "HEY", "HELLO", "YES", "NO", "OK", "OKAY", "MENU", "HELP", "DONE"]);
    if (!cleaned || cleaned.length < 2 || INVALID.has(cleaned.toUpperCase())) {
      return `What is your actual name? Just your first name is fine.`;
    }
    const name = cleaned.split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
    await db.update(users).set({ name, onboardingState: "ASK_GOAL" }).where(eq(users.phoneNumber, phone));
    return `Sharp ${name} 👊\n\nWhat is your main goal?\n\n1️⃣ Lose fat\n2️⃣ Build muscle\n3️⃣ Body recomposition — lose fat and gain muscle simultaneously\n4️⃣ General fitness and health`;
  }

  if (state === "ASK_GOAL") {
    let goal = "fat_loss";
    let calorieBase = 1500;
    const lower = msg.toLowerCase();
    if (msg.includes("2") || lower.includes("muscle")) { goal = "muscle_gain"; calorieBase = 2200; }
    else if (msg.includes("3") || lower.includes("recomp")) { goal = "recomposition"; calorieBase = 1800; }
    else if (msg.includes("4") || lower.includes("general") || lower.includes("fit")) { goal = "general"; calorieBase = 1800; }
    await db.update(users).set({ goalType: goal, calorieTarget: calorieBase, onboardingState: "ASK_WEIGHT" }).where(eq(users.phoneNumber, phone));
    return `Got it. How much do you weigh in kg?\n\nJust the number. For example: 72`;
  }

  if (state === "ASK_WEIGHT") {
    const weight = parseFloat(msg.replace(/[^0-9.]/g, ""));
    if (isNaN(weight) || weight < 30 || weight > 300) return "Just the number in kg please. For example: 72";
    const protein = Math.round(weight * 2);
    await db.update(users).set({ currentWeight: weight.toString(), proteinTarget: protein, onboardingState: "ASK_AGE" }).where(eq(users.phoneNumber, phone));
    return `How old are you?`;
  }

  if (state === "ASK_AGE") {
    const age = parseInt(msg.replace(/[^0-9]/g, ""));
    if (isNaN(age) || age < 10 || age > 100) return "Just your age please. For example: 28";
    await db.update(users).set({ age, onboardingState: "ASK_MODE" }).where(eq(users.phoneNumber, phone));
    return `Where will you train?\n\n1️⃣ Gym\n2️⃣ At home\n3️⃣ Walking only`;
  }

  if (state === "ASK_MODE") {
    let mode = "home";
    const lower = msg.toLowerCase();
    if (msg.includes("1") || lower.includes("gym")) mode = "gym";
    else if (msg.includes("3") || lower.includes("walk")) mode = "walk_only";
    await db.update(users).set({ trainingMode: mode, onboardingState: mode === "home" ? "ASK_EQUIPMENT" : "ASK_EXPERIENCE" }).where(eq(users.phoneNumber, phone));
    if (mode === "home") {
      return `What equipment do you have at home?\n\nReply with numbers — you can pick more than one:\n1️⃣ No equipment\n2️⃣ Resistance bands\n3️⃣ Dumbbells\n4️⃣ Kettlebell\n5️⃣ Pull up bar\n6️⃣ Skipping rope`;
    }
    return `Training experience?\n\n1️⃣ Just starting — never trained consistently\n2️⃣ Some experience — on and off\n3️⃣ Consistent — 6 plus months of regular training`;
  }

  if (state === "ASK_EQUIPMENT") {
    const selections = [];
    if (msg.includes("1")) selections.push("none");
    if (msg.includes("2")) selections.push("bands");
    if (msg.includes("3")) selections.push("dumbbells");
    if (msg.includes("4")) selections.push("kettlebell");
    if (msg.includes("5")) selections.push("pullup_bar");
    if (msg.includes("6")) selections.push("skipping_rope");
    const equipment = selections.length > 0 ? selections.join(",") : "none";
    await db.update(users).set({ homeEquipment: equipment, onboardingState: "ASK_EXPERIENCE" }).where(eq(users.phoneNumber, phone));
    return `Training experience?\n\n1️⃣ Just starting — never trained consistently\n2️⃣ Some experience — on and off\n3️⃣ Consistent — 6 plus months of regular training`;
  }

  if (state === "ASK_EXPERIENCE") {
    let exp = "beginner";
    const lower = msg.toLowerCase();
    if (msg.includes("2") || lower.includes("some")) exp = "intermediate";
    if (msg.includes("3") || lower.includes("consistent") || lower.includes("advanced")) exp = "advanced";
    await db.update(users).set({ trainingExperience: exp, onboardingState: "ASK_SITUATION" }).where(eq(users.phoneNumber, phone));
    return `Which best describes your situation?\n\n1️⃣ Student\n2️⃣ Domestic worker\n3️⃣ Retail or physical work — on feet all day\n4️⃣ Office or desk job\n5️⃣ Night shift worker\n6️⃣ Unemployed\n7️⃣ Long commute — 2 plus hours daily\n8️⃣ None of these`;
  }

  if (state === "ASK_SITUATION") {
    const situations: Record<string, string> = {
      "1": "student", "2": "domestic_worker", "3": "retail_physical",
      "4": "office", "5": "night_shift", "6": "unemployed",
      "7": "long_commute", "8": "none"
    };
    const situation = situations[msg.trim()] || "none";
    await db.update(users).set({ lifeSituation: situation, onboardingState: "ASK_CONDITIONS" }).where(eq(users.phoneNumber, phone));
    return `Any injuries, chronic conditions, or health issues I need to know about?\n\nFor example: bad knees, diabetes, hypertension, back pain, PCOS, on ARVs, Ramadan fasting\n\nOr reply NONE`;
  }

  if (state === "ASK_CONDITIONS") {
    const conditions = msg.toLowerCase() === "none" ? "" : msg;
    const exp = user.trainingExperience || "beginner";
    let startPhase = 1;
    if (exp === "intermediate") startPhase = 2;
    if (exp === "advanced") startPhase = 2;

    const stepsTarget = startPhase === 1 ? 7000 : 8000;

    await db.update(users).set({
      injuries: conditions,
      programmePhase: startPhase,
      stepsTarget,
      onboardingState: "COMPLETE",
      programmeStartDate: new Date(),
      subscriptionStatus: "trial",
    }).where(eq(users.phoneNumber, phone));

    const updatedUser = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
    const u = updatedUser[0];

    return `*Profile complete* ✅\n\n*${u.name}* — Phase ${startPhase}: ${getPhaseNames()[startPhase]}\n\n🎯 Goal: ${u.goalType?.replace("_", " ")}\n🍽️ Calorie target: ${u.calorieTarget} kcal\n💪 Protein target: ${u.proteinTarget}g\n👟 Step target: ${stepsTarget.toLocaleString()} steps\n\nYour programme starts today. Not tomorrow. Not Monday. *Today.*\n\nReply MENU to begin.`;
  }

  return MENU;
}

// ============================================================
// DETECT INTENT — WHAT IS THE CLIENT ASKING
// ============================================================

function detectIntent(message: string): string {
  const m = message.toLowerCase().trim();

  if (m.includes("reset") || m.includes("start over") || m.includes("start again") || m.includes("profile reset") || m.includes("begin again")) return "RESET";

  if (m === "menu" || m === "help") return "MENU";

  if (m === "2" || m === "workout" || m === "gym" || m.includes("joined the gym") || m.includes("join the gym") || m.includes("i need a programme") || m.includes("i need a program") || m.includes("training today") || m.includes("what do i do today") || m.includes("what should i do") || m.includes("exercise today") || m.includes("what can i do") || m.includes("30 min") || m.includes("travelling") || m.includes("traveling") || m.includes("workout today") || m.includes("schedule")) return "WORKOUT";
  if (m === "1") return "WORKOUT_TODAY";

  if ((m.includes("step") || m.includes("walked") || m.includes("steps")) && /\d/.test(m)) return "LOG_STEPS";
  if (m === "3") return "LOG_STEPS_PROMPT";

  if ((m.includes("slept") || m.includes("sleep") || m.includes("hours sleep") || m.includes("hours of sleep")) && /\d/.test(m)) return "LOG_SLEEP";
  if (m === "4") return "LOG_SLEEP_PROMPT";

  if ((m.includes("weigh") || m.includes("weight") || m.includes("kg")) && /\d/.test(m) && !m.includes("lost") && !m.includes("gained")) return "LOG_WEIGHT";
  if (m === "5") return "LOG_WEIGHT_PROMPT";

  if ((m.includes("water") || m.includes("drank") || m.includes("litre") || m.includes("liter") || m.includes("ml")) && (/\d/.test(m) || m.includes("bottle") || m.includes("glass"))) return "LOG_WATER";

  if (m === "6" || m.includes("weekly report") || m.includes("weekly progress") || m.includes("full report") || m.includes("show progress")) return "WEEKLY_REPORT";

  if (m === "7" || m.includes("measure") || m.includes("clothing") || m.includes("jeans") || m.includes("check in")) return "MEASUREMENTS";

  if (m === "done" || m === "workout done" || m === "finished" || m === "completed") return "WORKOUT_DONE";

  if ((m.includes("i bought") || m.includes("i have") || m.includes("shopping") || m.includes("groceries")) && message.split(",").length >= 3) return "GROCERY_LIST";

  if (m.includes("creatine") || m.includes("supplement") || m.includes("protein powder") || m.includes("pre-workout") || m.includes("pre workout")) return "SUPPLEMENTS";

  if (m.includes("before workout") || m.includes("after workout") || m.includes("pre workout meal") || m.includes("post workout meal")) return "MEAL_TIMING";

  if ((m.includes("budget") || m.includes("broke") || m.includes("month end") || m.includes("no money")) && (m.includes("meal") || m.includes("eat") || m.includes("food") || m.includes("groceries"))) return "BUDGET_MEAL";

  if (m.includes("ramadan") || m.includes("fasting") || m.includes("iftar") || m.includes("suhoor")) return "RAMADAN";

  if (m.includes("period") || m.includes("menstrual") || m.includes("time of the month") || m.includes("on my period")) return "PERIOD";

  if (m.includes("diabetic") || m.includes("diabetes") || m.includes("blood sugar")) return "DIABETIC";

  if (m.includes("travelling") || m.includes("traveling") || m.includes("hotel") || m.includes("on the road")) return "TRAVELLING";

  if (m.includes("church") || m.includes("funeral") || m.includes("lobola") || m.includes("umemulo") || m.includes("ceremony")) return "CULTURAL_EVENT";

  if (m.includes("beer") || m.includes("wine") || (m.includes("drank") && (m.includes("hennessy") || m.includes("henny") || m.includes("henry") || m.includes("alcohol") || m.includes("castle") || m.includes("black label") || m.includes("savanna")))) return "ALCOHOL";

  const foodWords = ["ate", "eat", "eating", "had", "breakfast", "lunch", "dinner", "snack", "meal", "food", "pap", "rice", "chicken", "eggs", "kota", "bread", "oats", "pilchards", "beans", "stew", "braai", "kfc", "nandos", "steers", "burger", "chips", "chocolate", "sweet potato", "vegetables", "spinach", "cabbage", "fruit", "banana", "apple", "latte", "tea", "coffee", "milo", "cremora", "mageu", "cool drink", "coke", "fanta"];
  if (foodWords.some(word => m.includes(word))) return "FOOD_LOG";

  return "GENERAL";
}

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================

async function handleMessage(phone: string, message: string, mediaUrl?: string): Promise<string> {
  const user = await getOrCreateUser(phone);

  if (user.onboardingState && user.onboardingState !== "COMPLETE") {
    return handleOnboarding(user, message, phone);
  }

  const intent = detectIntent(message);
  const m = message.toLowerCase().trim();

  // ---- RESET ----
  if (intent === "RESET") {
    await db.update(users).set({
      onboardingState: "START",
      programmePhase: 1,
      programmeWeek: 1,
      programmeDayInWeek: 1,
      goalType: null,
      currentWeight: null,
      trainingMode: "home",
      homeEquipment: null,
      lifeSituation: null,
      injuries: null,
      trainingExperience: null,
      subscriptionStatus: "trial",
      totalWorkoutsCompleted: 0,
    }).where(eq(users.phoneNumber, phone));
    return `Profile reset. Let us start fresh.\n\nWhat is your name?`;
  }

  // ---- MENU ----
  if (intent === "MENU") return MENU;

  // ---- PHOTO / FOOD VISION ----
  if (mediaUrl) {
    try {
      const imageResponse = await fetch(mediaUrl);
      const buffer = await imageResponse.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      const contentType = imageResponse.headers.get("content-type") || "image/jpeg";

      const visionResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 150,
        messages: [
          {
            role: "system",
            content: `${COACH_K_SYSTEM}\n\n${buildContext(user)}\n\nINSTRUCTION: The client sent a photo of their food. Identify what food is in the photo. Estimate approximate calories and protein for a South African portion size. Give a specific coaching response in your Coach K voice. Maximum 3 sentences. End with one action.`
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Here is my meal." },
              { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } }
            ]
          }
        ]
      });
      return visionResponse.choices[0]?.message?.content?.trim() || "Eish, could not identify that. Tell me what you ate in text.";
    } catch (err) {
      console.error("Vision error:", err);
      return "Could not process the photo. Tell me what you ate and I will coach you on it.";
    }
  }

  // ---- WORKOUT TODAY (explicit menu option 1) ----
  if (intent === "WORKOUT_TODAY") {
    const workout = buildDayWorkout(user);
    const coaching = await askCoachK("What is my workout today?", user, "Give one motivating sentence before their workout specific to their phase and goal. Short and SA.");
    return `${coaching}\n\n${workout}`;
  }

  // ---- WORKOUT (contextual — travel, time, questions, joining gym) ----
  if (intent === "WORKOUT") {
    if (m.includes("joined the gym") || m.includes("join the gym")) {
      await db.update(users).set({ trainingMode: "gym" }).where(eq(users.phoneNumber, phone));
      const updatedUser = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
      const workout = buildDayWorkout(updatedUser[0]);
      const coaching = await askCoachK(message, updatedUser[0], "The client just joined a gym. Welcome this milestone in one sentence, then give them their programme.");
      return `${coaching}\n\n${workout}`;
    }

    if (m.includes("travelling") || m.includes("traveling") || m.includes("hotel") || m.includes("30 min") || m.includes("short on time")) {
      return await askCoachK(message, user, `The client is travelling or short on time and needs a workout. Give them a 20 to 30 minute hotel room or bodyweight workout they can do right now. Include 4 exercises with sets and reps. Be specific. No equipment assumed.`);
    }

    const workout = buildDayWorkout(user);
    const coaching = await askCoachK(message, user, "Give one motivating sentence before their workout specific to their phase and goal. Short and SA.");
    return `${coaching}\n\n${workout}`;
  }

  // ---- WORKOUT DONE ----
  if (intent === "WORKOUT_DONE") {
    const newTotal = (user.totalWorkoutsCompleted || 0) + 1;
    let newDay = (user.programmeDayInWeek || 1) + 1;
    let newWeek = user.programmeWeek || 1;
    const daysPerWeek = user.trainingDaysPerWeek || 3;

    if (newDay > daysPerWeek) { newDay = 1; newWeek++; }
    if (newWeek > 4) { newWeek = 4; }

    await db.update(users).set({
      totalWorkoutsCompleted: newTotal,
      lastWorkoutDate: new Date(),
      programmeDayInWeek: newDay,
      programmeWeek: newWeek,
    }).where(eq(users.phoneNumber, phone));

    await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true });

    const coaching = await askCoachK("I just completed my workout", user, `Client just finished workout number ${newTotal}. Celebrate specifically. Reference their phase and total workouts. One sentence. SA voice.`);
    return `${coaching}\n\n✅ Workout ${newTotal} logged.${newTotal === 1 ? "\n\n🏆 First workout done. Most people never start." : ""}`;
  }

  // ---- STEPS ----
  if (intent === "LOG_STEPS") {
    const match = m.match(/(\d[\d,]*)/);
    if (!match) return "How many steps did you do today? Just the number.";
    const steps = parseInt(match[1].replace(/,/g, ""));
    const target = user.stepsTarget || 7000;
    await db.insert(stepLogs).values({ userId: user.id, steps });

    if (steps >= target) {
      return await askCoachK(`I did ${steps} steps today`, user, `Client hit their step target of ${target}. They did ${steps} steps. Celebrate this. One sentence. SA and specific.`);
    } else {
      const remaining = target - steps;
      return await askCoachK(`I did ${steps} steps today`, user, `Client logged ${steps} steps. Target is ${target}. They are ${remaining} short. Coach them to close the gap or challenge them for tomorrow.`);
    }
  }

  if (intent === "LOG_STEPS_PROMPT") return "How many steps did you do today? Just the number.";

  // ---- SLEEP ----
  if (intent === "LOG_SLEEP") {
    const match = m.match(/(\d+\.?\d*)/);
    if (!match) return "How many hours did you sleep? Just the number.";
    const hours = parseFloat(match[1]);

    if (hours < 6) {
      return await askCoachK(`I slept ${hours} hours`, user, `Client only got ${hours} hours of sleep. This is a problem for fat loss and muscle gain. Coach them on why sleep matters and one practical action to get more tonight. SA voice. Firm but caring.`);
    } else if (hours >= 7 && hours <= 9) {
      return await askCoachK(`I slept ${hours} hours`, user, `Client got ${hours} hours of sleep which is solid. Acknowledge this briefly. Connect good sleep to their results. One sentence.`);
    } else {
      return await askCoachK(`I slept ${hours} hours`, user, `Client slept ${hours} hours. Acknowledge it and move forward with one coaching tip for today.`);
    }
  }

  if (intent === "LOG_SLEEP_PROMPT") return "How many hours did you sleep last night? Just the number.";

  // ---- WEIGHT ----
  if (intent === "LOG_WEIGHT") {
    const match = m.match(/(\d+\.?\d*)/);
    if (!match) return "What is your weight in kg? Just the number.";
    const weight = parseFloat(match[1]);
    if (isNaN(weight) || weight < 30 || weight > 300) return "Just the number in kg please. For example: 72";

    await db.insert(weightLogs).values({ userId: user.id, weight: weight.toString() });
    await db.update(users).set({ currentWeight: weight.toString() }).where(eq(users.phoneNumber, phone));

    const previousLogs = await db.select().from(weightLogs).where(eq(weightLogs.userId, user.id)).orderBy(desc(weightLogs.loggedAt)).limit(2);

    if (previousLogs.length >= 2) {
      const previous = parseFloat(previousLogs[1].weight);
      const diff = weight - previous;
      const instruction = diff > 0.5
        ? `Client weight went up by ${diff.toFixed(1)}kg. Do not panic them. Explain water retention, sodium, menstrual cycle as likely causes. Coach them to stay on programme.`
        : diff < -0.5
        ? `Client lost ${Math.abs(diff).toFixed(1)}kg since last log. Celebrate specifically. Connect it to their consistency.`
        : `Client weight is similar to last log. Reassure them that consistency produces results over weeks not days.`;
      return await askCoachK(`My weight is ${weight}kg`, user, instruction);
    }

    return await askCoachK(`My weight is ${weight}kg`, user, `Client logged their weight as ${weight}kg. This is an early log. Acknowledge it and give context about what to expect from the scale in the first weeks.`);
  }

  if (intent === "LOG_WEIGHT_PROMPT") return "What is your weight in kg? Just the number.";

  // ---- WATER ----
  if (intent === "LOG_WATER") {
    let litres = 0;
    const mlMatch = m.match(/(\d+)\s*ml/);
    const litreMatch = m.match(/(\d+\.?\d*)\s*(litre|liter|l\b)/);
    if (mlMatch) litres = parseInt(mlMatch[1]) / 1000;
    else if (litreMatch) litres = parseFloat(litreMatch[1]);
    else if (m.includes("bottle")) litres = 0.75;
    else if (m.includes("glass")) litres = 0.25;
    else { const match = m.match(/(\d+\.?\d*)/); litres = match ? parseFloat(match[1]) : 0.5; }

    const currentWater = parseFloat(user.todayWater?.toString() || "0");
    const newTotal = currentWater + litres;
    await db.update(users).set({ todayWater: newTotal.toString() }).where(eq(users.phoneNumber, phone));

    const target = 2;
    if (newTotal >= target) return `Water target hit ✅ ${newTotal.toFixed(1)}L done. This alone improves your fat loss, energy, and skin. Do it again tomorrow.`;
    const remaining = (target - newTotal).toFixed(1);
    if (newTotal < 0.5) return `Badly dehydrated. ${newTotal.toFixed(1)}L so far. Drink 500ml right now before anything else. ${remaining}L to go.`;
    if (newTotal < 1) return `Good start. ${newTotal.toFixed(1)}L done. ${remaining}L to go today.`;
    if (newTotal < 1.5) return `Halfway there. ${newTotal.toFixed(1)}L done. ${remaining}L to go. Keep going.`;
    return `Almost there. ${newTotal.toFixed(1)}L done. One more glass finishes it.`;
  }

  // ---- WEEKLY REPORT ----
  if (intent === "WEEKLY_REPORT") {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentWorkouts = await db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, sevenDaysAgo)));
    const recentSteps = await db.select().from(stepLogs).where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo)));
    const recentWeight = await db.select().from(weightLogs).where(eq(weightLogs.userId, user.id)).orderBy(desc(weightLogs.loggedAt)).limit(1);

    const workoutCount = recentWorkouts.length;
    const avgSteps = recentSteps.length > 0 ? Math.round(recentSteps.reduce((sum, s) => sum + s.steps, 0) / recentSteps.length) : 0;
    const currentWeight = recentWeight.length > 0 ? parseFloat(recentWeight[0].weight) : null;
    const phase = user.programmePhase || 1;
    const phaseNames = getPhaseNames();

    const score = Math.min(100, Math.round((workoutCount / 3) * 40 + Math.min(avgSteps / (user.stepsTarget || 7000), 1) * 40 + 20));
    const level = score >= 90 ? "Elite" : score >= 70 ? "Strong" : score >= 50 ? "Building" : "Needs work";

    const report = `*Weekly Report — ${user.name || "Coach"}*\n\n📊 Phase ${phase}: ${phaseNames[phase]} — Week ${user.programmeWeek}\n\n💪 Workouts this week: ${workoutCount}/3\n👟 Average steps: ${avgSteps.toLocaleString()}\n⚖️ Current weight: ${currentWeight ? `${currentWeight}kg` : "Not logged"}\n💧 Water today: ${user.todayWater || 0}L\n\n🏆 Score: ${score}/100 — ${level}`;

    const coaching = await askCoachK("Give me my weekly report", user, `Client's weekly score is ${score}/100. Level: ${level}. Workouts: ${workoutCount}/3. Steps avg: ${avgSteps}. Give one specific coaching message for next week based on their weakest area. SA voice.`);

    return `${report}\n\n${coaching}`;
  }

  // ---- MEASUREMENTS ----
  if (intent === "MEASUREMENTS") {
    return await askCoachK(message, user, `Client wants to do a measurements check-in. Ask them for 3 key measurements: waist, hips, and chest (or arms for muscle gain clients). One question only. SA voice.`);
  }

  // ---- FOOD LOG ----
  if (intent === "FOOD_LOG") {
    const estimatedCals = estimateCalories(message);
    const target = user.calorieTarget || 1800;
    const instruction = estimatedCals > target * 0.5
      ? `Client logged a meal. Estimated calories: ${estimatedCals}. Daily target: ${target}. Coach them specifically on what they ate — what to adjust, what was good. SA voice. Specific food coaching.`
      : `Client logged a meal. Estimated calories: ${estimatedCals}. Coach them briefly and encourage them to hit their protein target of ${user.proteinTarget || 120}g.`;
    return await askCoachK(message, user, instruction);
  }

  // ---- GROCERY LIST ----
  if (intent === "GROCERY_LIST") {
    return await askCoachK(message, user, `Client shared their grocery list or what they have at home. Coach them on how to build meals from this. Focus on protein sources first. Budget-aware. SA voice.`);
  }

  // ---- SUPPLEMENTS ----
  if (intent === "SUPPLEMENTS") {
    return await askCoachK(message, user, `Client is asking about supplements. Be practical and honest. Creatine is worth it. Protein powder is food not magic. Everything else is optional. Food first always. SA voice.`);
  }

  // ---- MEAL TIMING ----
  if (intent === "MEAL_TIMING") {
    return await askCoachK(message, user, `Client is asking about meal timing around workouts. Give specific practical advice based on their training mode and goal. SA voice.`);
  }

  // ---- BUDGET MEAL ----
  if (intent === "BUDGET_MEAL") {
    return await askCoachK(message, user, `Client is on a tight budget. Lead with: "Your budget does not need to change. Smarter choices with the same money." Then give the R57 budget plan: eggs R25, pilchards R12, sugar beans R20. Practical and specific.`);
  }

  // ---- RAMADAN ----
  if (intent === "RAMADAN") {
    return await askCoachK(message, user, `Client is fasting for Ramadan. Restructure all advice around fasting hours. Training after Iftar. Suhoor is most important meal. Light sessions if fasting. Protein priority at Iftar.`);
  }

  // ---- PERIOD ----
  if (intent === "PERIOD") {
    return await askCoachK(message, user, `Client is on their period. Normalise harder workouts feeling during this time. Lighter sessions are fine. Hydration is critical. No guilt. SA voice. Warm but direct.`);
  }

  // ---- DIABETIC ----
  if (intent === "DIABETIC") {
    return await askCoachK(message, user, `Client has diabetes or is asking about blood sugar. Low GI carbs. Consistent meal timing. Train 1 to 2 hours after eating. Never skip meals. Specific and practical.`);
  }

  // ---- TRAVELLING ----
  if (intent === "TRAVELLING") {
    return await askCoachK(message, user, `Client is travelling. Give hotel room workout or fast food survival strategy. Protein first always. 30 minute bodyweight session available. No excuses but real options.`);
  }

  // ---- CULTURAL EVENT ----
  if (intent === "CULTURAL_EVENT") {
    return await askCoachK(message, user, `Client has a cultural event — church, funeral, lobola, umemulo. Acknowledge the importance of these. Enjoy it. Protein first. Smaller portions. No guilt. Back on programme next meal.`);
  }

  // ---- ALCOHOL ----
  if (intent === "ALCOHOL") {
    return await askCoachK(message, user, `Client drank alcohol. Coach forward not backward. Acknowledge it happened. One practical next step. SA voice. Firm but not preachy. Never shame them.`);
  }

  // ---- GENERAL (catch-all GPT) ----
  return await askCoachK(message, user);
}

// ============================================================
// LOG CHAT HELPER
// ============================================================

async function logChat(userId: string, phone: string, message: string, reply: string, intent: string): Promise<void> {
  try {
    await db.insert(chatHistory).values({
      userId,
      phoneNumber: phone,
      message,
      reply,
      intent,
    });
  } catch (err) {
    console.error("Chat log error:", err);
  }
}

// ============================================================
// REGISTER EXPRESS ROUTES
// ============================================================

export async function registerRoutes(server: Server, app: Express): Promise<void> {

  // ── REST API for admin dashboard ──────────────────────────

  app.get("/api/users", async (_req, res) => {
    try {
      const all = await db.select().from(users).orderBy(desc(users.createdAt));
      res.json(all);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  app.get("/api/users/:id", async (req, res) => {
    try {
      const user = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1);
      if (!user.length) return res.status(404).json({ message: "User not found" });

      const weights = await db.select().from(weightLogs).where(eq(weightLogs.userId, req.params.id)).orderBy(desc(weightLogs.loggedAt)).limit(30);
      const steps = await db.select().from(stepLogs).where(eq(stepLogs.userId, req.params.id)).orderBy(desc(stepLogs.loggedAt)).limit(30);
      const workouts = await db.select().from(workoutLogs).where(eq(workoutLogs.userId, req.params.id)).orderBy(desc(workoutLogs.loggedAt)).limit(30);
      const chats = await db.select().from(chatHistory).where(eq(chatHistory.userId, req.params.id)).orderBy(desc(chatHistory.createdAt)).limit(50);

      res.json({ user: user[0], weightLogs: weights, stepLogs: steps, workoutLogs: workouts, chatHistory: chats });
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  app.get("/api/admin/flagged", async (_req, res) => {
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const inactive = await db.select().from(users).where(
        and(
          eq(users.onboardingState, "COMPLETE"),
        )
      );
      const flagged = inactive.filter(u => !u.lastActiveAt || new Date(u.lastActiveAt) < threeDaysAgo);
      res.json(flagged);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch flagged users" });
    }
  });

  app.get("/api/admin/beta-testers", async (_req, res) => {
    try {
      const all = await db.select().from(users).where(eq(users.subscriptionStatus, "trial")).orderBy(desc(users.createdAt));
      res.json(all);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch beta testers" });
    }
  });

  app.post("/api/admin/run-test", async (req, res) => {
    const { testId, liveMode } = req.body;
    const logs: string[] = [];
    try {
      logs.push(`Running test ${testId}...`);
      const testPhone = "+27000000000";
      const testMessages: Record<string, string> = {
        A: "Hi, I want to join",
        B: "I ate pap and chicken for lunch",
        C: "I did 8500 steps today",
        D: "I weigh 75kg",
        E: "I am travelling and need a workout",
        F: "weekly report",
      };
      const msg = testMessages[testId] || "Hello";
      logs.push(`Sending: "${msg}"`);
      const reply = await handleMessage(testPhone, msg);
      logs.push(`Reply: ${reply}`);
      res.json({ success: true, logs, whatsappSent: reply });
    } catch (err: any) {
      logs.push(`Error: ${err.message}`);
      res.json({ success: false, logs });
    }
  });

  // ── WhatsApp webhook ──────────────────────────────────────

  app.post("/api/webhooks/whatsapp", async (req, res) => {
    try {
      const phone = (req.body.From || "").replace("whatsapp:", "");
      const message = (req.body.Body || "").trim();
      const mediaUrl = req.body.MediaUrl0 || undefined;

      if (!phone || !message) {
        return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
      }

      const reply = await handleMessage(phone, message, mediaUrl);

      const user = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
      if (user.length > 0) {
        await logChat(user[0].id, phone, message, reply, detectIntent(message));
      }

      return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
    } catch (err) {
      console.error("Webhook error:", err);
      return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Something went wrong. Try again in a moment.</Message></Response>`);
    }
  });

  // ── Admin test harness webhook ────────────────────────────

  app.post("/api/admin/test-webhook", async (req, res) => {
    try {
      const { phone, message } = req.body;
      if (!phone || !message) return res.status(400).json({ message: "phone and message required" });
      const reply = await handleMessage(phone, message);
      res.json({ reply });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Health check ──────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "KamLife Coach", timestamp: new Date().toISOString() });
  });
}
