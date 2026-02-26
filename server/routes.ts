import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import OpenAI from "openai";
import { format } from "date-fns";
import { db } from "./db";
import { chatHistory } from "@shared/schema";
import { eq, and, gte } from "drizzle-orm";
import { R } from "./responses";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

async function sendWhatsAppMessage(to: string, body: string) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER;
    if (!accountSid || !authToken || !fromNumber) {
      console.error('[TWILIO] Missing credentials — skipping send');
      return false;
    }
    const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        From: `whatsapp:${fromNumber}`,
        To: toNumber,
        Body: body
      }).toString()
    });
    if (!response.ok) {
      console.error(`[TWILIO] Send failed: ${response.status} ${await response.text()}`);
    }
    return response.ok;
  } catch (e) {
    console.error('[TWILIO] Failed to send WhatsApp message:', e);
    return false;
  }
}

const KAMLIFE_MASTER_PROMPT = `You are KamLife Coach — a firm, experienced South African fitness coach with 20 years of real coaching experience. You operate on WhatsApp.

WHO YOUR CLIENTS ARE:
Township and suburban South Africans aged 14-80. Teenagers trying to get fit, young adults, middle aged parents, and elderly clients all use this service. Mostly women but growing male market. High carb diets — pap, bread, rice are staples. Financially stressed — money is tight especially around month end. Low gym access — most train at home or walk. Emotionally driven eaters. They use informal language — eish, sharp, hayibo, mara, shem. They attend funerals, braais, weddings where food is cultural and central. Many work night shift. Many have chronic conditions.

AGE-SPECIFIC COACHING:
Age 14-17: Never recommend aggressive calorie deficits. Focus on healthy eating habits, sport performance, building confidence. No extreme programmes. If they mention skipping meals or extreme restriction — respond with care and encourage them to speak to a parent or doctor immediately.
Age 18-35: Standard fat loss and muscle building protocols apply.
Age 36-50: Recovery takes longer. Sleep more important. Hormonal changes affect results. Be patient with the scale.
Age 51-65: Joint health is priority. Low impact exercise. Strength training to prevent muscle loss.
Age 66-80: Safety first always. Chair exercises, walking, light resistance only. Never push intensity. Any dizziness or chest discomfort — stop and call a doctor.

WHAT YOU KNOW AFTER 20 YEARS:
The scale lies short term. Water retention, menstrual cycles, stress hormones all affect weight daily. Never let a client panic over one weigh-in.
Friday to Sunday is where 80% of clients lose their weekly progress. Weekend eating is the real enemy.
Skipping meals causes more bingeing than eating badly. Always push protein over skipping.
Most SA clients are protein deficient. Eggs, pilchards, chicken, beans are affordable protein sources to push always.
Stress and sleep affect fat loss more than most people realise. A stressed client who sleeps 4 hours will not lose weight no matter how clean they eat.
Consistency over perfection. One bad meal means nothing. Three bad days means something.
Clients need to feel seen and understood, not lectured. Firm but human.
Budget matters. Eggs R25 for 6, tinned pilchards R12, chicken portions R40, sugar beans R20. A full day of protein eating costs under R60.
Exercise form matters more than exercise choice. Simple movements done correctly beat complex movements done wrong.
Motivation is unreliable. Discipline and systems are what work long term.

EXERCISE DESCRIPTIONS — always explain in simple plain English when introducing an exercise:
Squat: Stand feet shoulder width apart, lower like sitting on a chair, chest up, push through heels to stand.
Push up: Hands shoulder width, body straight, lower chest to floor, push back up. Knees down if too hard.
Lunge: Step forward, lower back knee toward floor, push back to start. Alternate legs.
Plank: Forearms on floor, body straight like a board, hold. Do not let hips drop.
Wall sit: Back flat against wall, slide down until thighs parallel to floor, hold.
Row: Pull weight toward lower chest, squeeze shoulder blades, lower slowly.
Deadlift: Feet hip width, bend at hips and knees, keep back straight, stand up driving through heels.

CHRONIC CONDITIONS:
Diabetes: low GI carbs, smaller portions, no sugary drinks, consistent meal timing.
Hypertension: reduce sodium, no processed meats, increase potassium foods.
Thyroid: weight loss will be slower, consistency is even more critical.
Pregnancy: immediately recommend doctor consultation, switch to maintenance not deficit, light walking only.
Menopause: weight loss is slower, strength training becomes more important, be patient with the scale.

WEEKEND AND SOCIAL EATING:
If Friday or message mentions braai, party, wedding, funeral — acknowledge the social reality. Give specific strategies: eat protein before the event, limit alcohol to 2 drinks maximum, get back on track the very next meal not next Monday.

BUDGET COACHING:
If client mentions no money or cant afford food — suggest: eggs 6 pack R25, tin pilchards R12, chicken portions R40, sugar beans R20. Full day of protein under R60.

HOW SA PEOPLE ACTUALLY EAT:
One meal a day is common in poorer households — never shame this, work with it by maximising that one meal.
Bread and tea for breakfast is the most common SA breakfast — coach to add an egg or peanut butter.
Two minute noodles are a reality — coach to add an egg and reduce the seasoning packet.
Jungle Oats is an excellent SA breakfast — affirm it, suggest adding eggs or milk for protein.
Cremora in tea adds significant calories — gently flag if client mentions multiple cups daily.
Mageu is caloric — flag if consumed in large quantities.
Simba chips, Niknaks, Cheeseboys are the most common SA junk snacks — coach specifically.
Kotas are a complete meal — coach on protein choice inside the kota, skip the chips.
Atchaar is fine in small amounts — high sodium, worth mentioning.
Rooibos tea is excellent — encourage it.
Parkrun on Saturday morning is free and community-driven — always recommend it.

HOW SA PEOPLE COMMUNICATE:
They message in fragments not full sentences.
Gym done means workout complete.
7k steps means they walked 7000 steps.
Ate pap means they had pap as a meal.
Bad day means emotional eating likely happened.
Sharp means okay or thank you.
Always read the intent behind the fragment, not just the words.

DIGNITY IN BUDGET EATING:
Never make cheap food sound like a compromise.
Tinned pilchards are omega-3 rich, high protein, and one of the smartest food choices available.
Eggs are one of the most complete foods on earth.
Sugar beans and lentils are what serious athletes eat.
Frame budget eating as intelligent eating, not poverty eating.
Your clients are making smart choices with what they have — reinforce that.

TONE RULES:
Max 3 sentences per response.
Never say Got it, Nice, Great job, Well done generically.
Never mention AI, bot, system, algorithm.
Never recommend supplements as first solution.
Always end with one specific action they must take right now.
Sound like a coach who has seen everything and still believes in this client.`;

const PHASE_CONFIG: Record<number, { name: string; theme: string; weeks: number; intensityLevel: number; weeklyWorkouts: number; stepTarget: number; rest: string }> = {
  1: { name: "Foundation", theme: "Build the habit, not the body", weeks: 4, intensityLevel: 1, weeklyWorkouts: 3, stepTarget: 7000, rest: "60s" },
  2: { name: "Build", theme: "The habit is forming. Now we add load", weeks: 4, intensityLevel: 2, weeklyWorkouts: 4, stepTarget: 8000, rest: "60-90s" },
  3: { name: "Push", theme: "No excuses. This is where results happen", weeks: 4, intensityLevel: 3, weeklyWorkouts: 4, stepTarget: 9000, rest: "90s" },
  4: { name: "Peak", theme: "Highest intensity. Your body is ready", weeks: 4, intensityLevel: 4, weeklyWorkouts: 5, stepTarget: 10000, rest: "90-120s" },
  5: { name: "Deload", theme: "Intentional recovery. Your body needs this", weeks: 2, intensityLevel: 1, weeklyWorkouts: 3, stepTarget: 7000, rest: "60s" },
};

const NUTRITION_BY_PHASE: Record<number, { name: string; focus: string; carbTiming: string; keyHabit: string; weeklyTarget: string }> = {
  1: { name: "Foundation", focus: "Build 3 consistent meals daily. Protein at every meal. No skipping.", carbTiming: "Carbs around training only. Rest of day protein and vegetables.", keyHabit: "Log every meal this week — accuracy comes before perfection.", weeklyTarget: "Hit protein target 5 out of 7 days." },
  2: { name: "Build", focus: "Increase protein by 10g daily. Add a fourth meal if training 4x per week.", carbTiming: "Carbs before and after training. Reduce carbs on rest days.", keyHabit: "Meal prep Sunday. Prepare 3 days of food in advance.", weeklyTarget: "Hit protein target 6 out of 7 days. Zero junk food days." },
  3: { name: "Push", focus: "Precision eating. Every meal tracked. No guessing portions.", carbTiming: "High carb on training days. Low carb on rest days. Protein stays constant.", keyHabit: "Weigh or measure portions for one week to recalibrate your eye.", weeklyTarget: "Perfect logging 7 out of 7 days. This phase demands it." },
  4: { name: "Peak", focus: "Maximum fuel for maximum output. Do not undereat during peak phase.", carbTiming: "Carbs at every meal on training days. Your body needs the fuel.", keyHabit: "Eat within 30 minutes of waking. Eat within 30 minutes of training.", weeklyTarget: "No missed meals. No junk. This is your peak — protect it." },
  5: { name: "Deload", focus: "Reduce calories by 10 percent. Your training is lighter so fuel accordingly.", carbTiming: "Reduce carbs slightly. Keep protein identical to peak phase.", keyHabit: "Use this week to reset food habits. Cook from scratch at least 3 meals.", weeklyTarget: "Clean eating only this week. Deload is for full recovery." },
};

function getPostWorkoutNutrition(phase: number): string {
  if (phase <= 2) return "Post workout: eat protein within 30 minutes. Chicken, eggs or tinned fish with rice or pap.";
  if (phase <= 4) return "Post workout: eat protein within 30 minutes. Protein shake or chicken breast with sweet potato.";
  return "Post workout: eat protein within 30 minutes. Light protein meal — eggs or yoghurt.";
}

async function checkFoodPatterns(userId: string): Promise<string> {
  const chatLogs = await storage.getChatHistory(userId);
  const foodLogs = chatLogs
    .filter(l => l.intent === "LOG_FOOD" || l.intent === "LOG_FOOD_FOLLOWUP" || l.intent === "FOOD_PORTION")
    .slice(0, 3);

  if (foodLogs.length < 3) return "";

  const junkWords = ["chips", "chocolate", "sweets", "cake", "biscuit", "cookie", "ice cream", "vetkoek", "fat cake", "magwinya", "russian", "polony", "kota", "gatsby", "pie", "sausage roll", "fizzy", "coke", "fanta", "sprite"];
  const junkCounts: Record<string, number> = {};
  for (const log of foodLogs) {
    const msg = (log.messageIn || "").toLowerCase();
    for (const junk of junkWords) {
      if (msg.includes(junk)) {
        junkCounts[junk] = (junkCounts[junk] || 0) + 1;
      }
    }
  }
  const repeatedJunk = Object.entries(junkCounts).find(([_, count]) => count >= 3);
  if (repeatedJunk) {
    return `\n\nThis is the third time this week I have seen ${repeatedJunk[0]}. That is a pattern not a slip. What is triggering this — stress, habit, or availability? Tell me and we fix it.`;
  }

  const proteinWords = ["chicken", "egg", "fish", "tuna", "pilchard", "beef", "steak", "mince", "protein", "yoghurt", "yogurt", "beans", "lentils", "milk", "cheese", "biltong", "wors", "boerewors", "tripe", "mogodu"];
  const hasProtein = foodLogs.some(l => {
    const msg = (l.messageIn || "").toLowerCase();
    return proteinWords.some(p => msg.includes(p));
  });
  if (!hasProtein) {
    return "\n\nThree meals in a row with no protein logged. Your body is losing muscle right now. Fix the next meal.";
  }

  return "";
}

async function checkPerfectDay(user: any): Promise<string> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const workoutLogs = await storage.getWorkoutLogs(user.id);
  const todayWorkout = workoutLogs.some(l => l.workoutCompleted && l.loggedAt && new Date(l.loggedAt) >= today);

  const stepLogs = await storage.getStepLogs(user.id);
  const todaySteps = stepLogs.find(l => l.loggedAt && new Date(l.loggedAt) >= today);
  const stepsHit = todaySteps ? todaySteps.steps >= (user.stepsTarget || 8000) : false;

  const chatLogs = await storage.getChatHistory(user.id);
  const todayFoodLogs = chatLogs.filter(l =>
    (l.intent === "LOG_FOOD" || l.intent === "LOG_FOOD_FOLLOWUP") &&
    l.createdAt && new Date(l.createdAt) >= today
  );
  const cleanMeals = todayFoodLogs.length >= 2;

  if (todayWorkout && stepsHit && cleanMeals) {
    const name = user.name || "Coach";
    return `\n\n${name} — perfect day. Workout done. Steps hit. Food clean. This is exactly what results are made of. Screenshot this day.`;
  }
  return "";
}

async function buildSharecard(user: any): Promise<string> {
  const phase = user.programmePhase || 1;
  const phaseConfig = PHASE_CONFIG[phase] || PHASE_CONFIG[1];
  const phaseName = phaseConfig.name;
  const startDate = user.programmeStartDate || user.createdAt;
  const daysOnProgramme = startDate ? Math.floor((Date.now() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)) : 0;
  const weightLogs = await storage.getWeightLogs(user.id);
  let weightLost = "0";
  if (weightLogs.length >= 2) {
    const sorted = [...weightLogs].sort((a, b) => new Date(a.loggedAt || 0).getTime() - new Date(b.loggedAt || 0).getTime());
    const first = parseFloat(sorted[0].weight as string);
    const latest = parseFloat(sorted[sorted.length - 1].weight as string);
    const diff = first - latest;
    weightLost = diff > 0 ? diff.toFixed(1) : "0";
  }
  const stepLogs = await storage.getStepLogs(user.id);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const thisWeekSteps = stepLogs.filter(l => l.loggedAt && new Date(l.loggedAt) >= weekAgo);
  const avgSteps = thisWeekSteps.length > 0 ? Math.round(thisWeekSteps.reduce((sum, l) => sum + l.steps, 0) / thisWeekSteps.length) : 0;
  const score = user.weeklyScore || 0;
  const complianceLevel = user.complianceLevel || "BUILDING";

  const sharecard = [
    `╔══════════════════════════╗`,
    `║   KAMLIFE COACH          ║`,
    `║   PHASE ${phase}: ${phaseName.padEnd(16)}║`,
    `╠══════════════════════════╣`,
    `║ ${('Name: ' + (user.name || 'Coach')).padEnd(26)}║`,
    `║ ${('Days: ' + daysOnProgramme).padEnd(26)}║`,
    `║ ${('Lost: ' + weightLost + 'kg').padEnd(26)}║`,
    `║ ${('Workouts: ' + (user.totalWorkoutsCompleted || 0)).padEnd(26)}║`,
    `║ ${('Avg steps: ' + avgSteps.toLocaleString()).padEnd(26)}║`,
    `║ ${('Compliance: ' + score + '%').padEnd(26)}║`,
    `╠══════════════════════════╣`,
    `║ ${('Level: ' + complianceLevel).padEnd(26)}║`,
    `║ "Consistency over        ║`,
    `║  perfection. Always."   ║`,
    `╚══════════════════════════╝`,
    ``,
    `Join KamLife Coach — WhatsApp +1 415 523 8886`
  ].join('\n');

  return sharecard;
}

function buildOnboardingComplete(user: any, experience: string, calorieTarget: number, proteinTarget: number, phaseConfig: any, startingPhase: number): string {
  const userName = user.name || "coach";
  const goal = user.goalType || "General Fitness";
  const mode = user.trainingMode || "home";
  const stepTarget = phaseConfig.stepTarget || 7000;

  const situationLines: string[] = [];
  if (user.lifeSituation === "night shift") situationLines.push("Night shift life is tough on the body. We will time your meals and training around your shifts.");
  else if (user.lifeSituation === "student in res") situationLines.push("Res life means limited kitchen access and budget. We work with what you have.");
  else if (user.lifeSituation === "domestic worker") situationLines.push("Your job is already physical. We adjust training intensity so you are not burning out.");
  else if (user.lifeSituation === "long commute") situationLines.push("Long commute means less time. Your workouts are short, focused, and effective.");
  else if (user.lifeSituation === "unemployed") situationLines.push("Budget is tight. Every meal plan will be affordable. Eggs, pilchards, and beans are your weapons.");

  const coachLine = situationLines.length > 0 ? situationLines[0] : "Consistency beats perfection. Show up every day and the results will come.";

  return `Profile complete, ${userName}.\n\nHere is your setup:\nName: ${userName}\nGoal: ${goal}\nTraining: ${mode}\nPhase: ${startingPhase} — ${phaseConfig.name}\n\nYour daily targets:\nCalories: ${calorieTarget}kcal\nProtein: ${proteinTarget}g\nSteps: ${stepTarget.toLocaleString()}\n\n${coachLine}\n\nYour programme starts today — not tomorrow, not Monday. Today. Tell me what you ate today or type WORKOUT to begin.`;
}

async function advanceProgram(user: any): Promise<{ phaseTransitionMsg: string | null; newPhase: number; newWeek: number }> {
  const phase = user.programmePhase || 1;
  const week = user.programmeWeek || 1;
  const dayInWeek = (user.programmeDayInWeek || 1) + 1;
  const config = PHASE_CONFIG[phase] || PHASE_CONFIG[1];

  let newPhase = phase;
  let newWeek = week;
  let newDay = dayInWeek;
  let phaseTransitionMsg: string | null = null;
  let phaseComplete = false;

  if (newDay > 7) {
    newDay = 1;
    newWeek = week + 1;
    if (newWeek > config.weeks) {
      phaseComplete = true;
      let nextPhase = phase;
      if (phase === 4) nextPhase = 5;
      else if (phase === 5) nextPhase = 2;
      else if (phase < 4) nextPhase = phase + 1;

      const nextConfig = PHASE_CONFIG[nextPhase] || PHASE_CONFIG[1];

      const daysInPhase = config.weeks * 7;
      const phaseStartDate = new Date(Date.now() - daysInPhase * 24 * 60 * 60 * 1000);
      const allWorkoutLogs = await storage.getWorkoutLogs(user.id);
      const phaseWorkouts = allWorkoutLogs.filter(l => l.workoutCompleted && l.loggedAt && new Date(l.loggedAt) >= phaseStartDate).length;
      const allStepLogs = await storage.getStepLogs(user.id);
      const phaseSteps = allStepLogs.filter(l => l.loggedAt && new Date(l.loggedAt) >= phaseStartDate);
      const avgSteps = phaseSteps.length > 0 ? Math.round(phaseSteps.reduce((sum, l) => sum + l.steps, 0) / phaseSteps.length) : 0;
      const complianceScore = Math.min(100, Math.round((phaseWorkouts / (config.weeklyWorkouts * config.weeks)) * 100));

      const sharecard = await buildSharecard(user);

      phaseTransitionMsg = `Phase ${phase}: ${config.name} — Complete. You have finished ${config.weeks} weeks of consistent work.\n\nPhase ${phase} Summary:\nWorkouts completed: ${phaseWorkouts}\nAverage steps: ${avgSteps.toLocaleString()}\nCompliance: ${complianceScore}%\n\n${sharecard}\n\nBefore we move to Phase ${nextPhase} — how are you feeling?\nReply READY to advance to Phase ${nextPhase}: ${nextConfig.theme}\nOr reply REPEAT to own this phase one more week and advance stronger.`;

      newWeek = week;
      newDay = dayInWeek - 1 || 7;

      await storage.updateUser(user.id, {
        phaseReadyToAdvance: true,
        programmeDayInWeek: newDay,
        programDayIndex: (user.programDayIndex || 1),
        totalWorkoutsCompleted: (user.totalWorkoutsCompleted || 0) + 1,
        lastWorkoutDate: new Date(),
      });

      await sendWhatsAppMessage(user.phoneNumber, phaseTransitionMsg);
      return { phaseTransitionMsg, newPhase: phase, newWeek: week };
    }
  }

  let nextProgramDay = (user.programDayIndex || 1) + 1;
  if (nextProgramDay > 21) nextProgramDay = 1;

  await storage.updateUser(user.id, {
    programmePhase: newPhase,
    programmeWeek: newWeek,
    programmeDayInWeek: newDay,
    programDayIndex: nextProgramDay,
    totalWorkoutsCompleted: (user.totalWorkoutsCompleted || 0) + 1,
    lastWorkoutDate: new Date(),
  });

  return { phaseTransitionMsg: null, newPhase, newWeek };
}

function getMilestoneMessage(user: any): string | null {
  if (!user.programmeStartDate) return null;
  const daysOnProgramme = Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / (1000 * 60 * 60 * 24));
  if (daysOnProgramme === 30) return "30 days on KamLife. Most people quit in week 3. You are not most people.";
  if (daysOnProgramme === 90) return "90 days. You have been consistent for 3 months. That is not a programme anymore — that is a lifestyle.";
  if (daysOnProgramme === 180) return "6 months. You are no longer someone trying to get fit. You are fit. Keep going.";
  if (daysOnProgramme === 365) return "One year on KamLife. Think about who you were 365 days ago. That is the distance you have covered.";
  return null;
}

type Exercise = {
  id: string;
  name: string;
  sets: string;
  plainEnglish: string;
  modification: string;
  reason: string;
  phase: number;
  muscleGroup: string;
  videoUrl?: string;
};

type ExerciseEntry = {
  id: string;
  name: string;
  muscleGroup: string;
  plainEnglish: string;
  modification: string;
  reason: string;
  videoUrl: string;
};

const EXERCISE_LIBRARY = {
  gym: {
    push: [
      { id: "bench_press", name: "Bench Press", muscleGroup: "chest", plainEnglish: "Lie on bench. Bar or dumbbells at chest level. Press up until arms extended. Lower slowly to chest. Keep feet flat on floor, back natural.", modification: "If shoulder pain, use dumbbells with neutral grip. If over 60, reduce range of motion.", reason: "The fundamental upper body push movement. Builds chest, shoulders and triceps.", videoUrl: "https://www.youtube.com/results?search_query=bench+press+proper+form+tutorial" },
      { id: "overhead_press", name: "Overhead Press", muscleGroup: "shoulders", plainEnglish: "Stand or sit. Bar or dumbbells at shoulder height. Press straight overhead until arms locked out. Lower slowly back to shoulders. Keep core tight throughout.", modification: "If shoulder pain, press to eye level only. Seated version reduces lower back stress.", reason: "The fundamental shoulder movement. Builds overhead strength and shoulder size.", videoUrl: "https://www.youtube.com/results?search_query=overhead+press+proper+form+tutorial" },
    ],
    pull: [
      { id: "barbell_row", name: "Barbell Row", muscleGroup: "back", plainEnglish: "Hinge forward at hips, back flat. Pull bar to lower chest. Squeeze shoulder blades together at top. Lower slowly. Do not round your back.", modification: "If lower back pain, use seated cable row instead. Keep weight light and focus on form.", reason: "The fundamental upper back movement. Builds thickness and posture.", videoUrl: "https://www.youtube.com/results?search_query=barbell+row+proper+form+tutorial" },
      { id: "pull_up_or_lat", name: "Pull Up or Lat Pulldown", muscleGroup: "back", plainEnglish: "Pull Up: hang from bar, pull chest to bar, lower slowly. Lat Pulldown: sit at machine, pull bar to upper chest, return slowly. Both — squeeze your back at the top.", modification: "If pull ups too hard, use lat pulldown machine. If shoulder pain, use closer grip.", reason: "The fundamental vertical pull movement. Builds width and the V-shape.", videoUrl: "https://www.youtube.com/results?search_query=lat+pulldown+proper+form+tutorial" },
    ],
    legs: [
      { id: "squat", name: "Squat", muscleGroup: "legs", plainEnglish: "Bar on upper back. Feet shoulder width. Lower until thighs parallel to floor. Drive through heels to stand. Keep chest up and knees tracking over toes throughout.", modification: "If knee pain, reduce depth. If back pain, use goblet squat with dumbbell. If new, use bodyweight first.", reason: "The king of all exercises. Builds the entire lower body and burns maximum calories.", videoUrl: "https://www.youtube.com/results?search_query=squat+proper+form+tutorial" },
      { id: "deadlift", name: "Deadlift", muscleGroup: "posterior chain", plainEnglish: "Bar over mid-foot. Hinge down, grip just outside knees, back flat. Push floor away — do not pull with back. Stand tall, lock hips at top. Lower bar with control.", modification: "If lower back pain, do Romanian deadlift only — lighter weight, hinge at hips. If new, start with dumbbells.", reason: "The most complete strength movement. Works everything from neck to floor.", videoUrl: "https://www.youtube.com/results?search_query=deadlift+proper+form+tutorial" },
    ],
    core: [
      { id: "plank", name: "Plank", muscleGroup: "core", plainEnglish: "Forearms on floor. Body in straight line from head to heels. Squeeze stomach hard. Hold. Do not let hips drop or rise. Breathe steadily.", modification: "Drop knees if too difficult. Build time by 5 seconds each week.", reason: "Builds deep core stability that protects the spine and improves every other movement.", videoUrl: "https://www.youtube.com/results?search_query=plank+proper+form+tutorial" },
    ],
    phases: {
      1: { setsReps: "3x10", rest: "90 seconds", note: "Focus entirely on form. Weight is secondary. Learn the movement." },
      2: { setsReps: "4x8", rest: "90 seconds", note: "Add weight only when form is perfect. Progressive overload starts here." },
      3: { setsReps: "4x6", rest: "120 seconds", note: "Heavier weight. Controlled tempo. Feel every rep." },
      4: { setsReps: "5x5", rest: "120 seconds", note: "Maximum strength phase. Heavy, controlled, deliberate." },
      5: { setsReps: "3x10", rest: "60 seconds", note: "Deload. Half your normal weight. Perfect form only." },
    }
  },
  home: {
    push: [
      { id: "pushup", name: "Push Up", muscleGroup: "chest", plainEnglish: "Hands slightly wider than shoulders. Body straight from head to heels. Lower chest to floor. Push back up. If too hard — knees on floor. If too easy — feet elevated.", modification: "Wall push ups for elderly or injury. Knees down for beginners. Decline for advanced.", reason: "The fundamental bodyweight push movement. Works chest, shoulders, triceps with zero equipment.", videoUrl: "https://www.youtube.com/results?search_query=push+up+proper+form+tutorial" },
    ],
    pull: [
      { id: "row_towel", name: "Table Row or Resistance Band Row", muscleGroup: "back", plainEnglish: "Table row: lie under a sturdy table, grip edge, pull chest to table, lower slowly. Band row: anchor band, pull toward lower chest, squeeze shoulder blades, return slowly.", modification: "If no table or band, do Superman holds: lie face down, lift arms and chest off floor, hold 2 seconds.", reason: "The only way to train the back at home without equipment. Non-negotiable for posture.", videoUrl: "https://www.youtube.com/results?search_query=table+row+bodyweight+tutorial" },
    ],
    legs: [
      { id: "squat_bw", name: "Bodyweight Squat", muscleGroup: "legs", plainEnglish: "Feet shoulder width. Arms out front for balance. Lower like sitting on a chair. Push through heels to stand. Go as deep as comfortable. Chest stays up throughout.", modification: "Hold chair for balance if needed. Reduce depth if knee pain. Single leg if too easy.", reason: "Builds the entire lower body with zero equipment. Foundation of all movement.", videoUrl: "https://www.youtube.com/results?search_query=bodyweight+squat+proper+form+tutorial" },
      { id: "glute_bridge", name: "Glute Bridge", muscleGroup: "posterior chain", plainEnglish: "Lie on back. Knees bent, feet flat. Push hips toward ceiling. Squeeze glutes hard at top. Hold 2 seconds. Lower slowly. Repeat.", modification: "Single leg version if too easy. Place weight on hips for more resistance.", reason: "Activates the glutes which most people underuse. Protects knees and lower back.", videoUrl: "https://www.youtube.com/results?search_query=glute+bridge+proper+form+tutorial" },
      { id: "lunge", name: "Reverse Lunge", muscleGroup: "legs", plainEnglish: "Stand tall. Step one foot backward. Lower back knee toward floor. Push through front heel to return. Complete all reps one side then switch. Hold wall for balance if needed.", modification: "Reduce range of motion if knee pain. Hold chair for balance if elderly or unstable.", reason: "Builds each leg independently. Fixes imbalances. Easier on knees than forward lunge.", videoUrl: "https://www.youtube.com/results?search_query=reverse+lunge+proper+form+tutorial" },
    ],
    core: [
      { id: "plank_home", name: "Plank", muscleGroup: "core", plainEnglish: "Forearms on floor. Body straight. Squeeze stomach. Hold. Do not let hips drop. Breathe.", modification: "Knees down if too difficult. Build 5 seconds per week.", reason: "Core stability foundation. Protects the spine and improves every movement.", videoUrl: "https://www.youtube.com/results?search_query=plank+proper+form+tutorial" },
    ],
    phases: {
      1: { setsReps: "3x10", rest: "60 seconds", note: "Learn the movement. Form first. Every time." },
      2: { setsReps: "3x15", rest: "60 seconds", note: "More reps. Controlled tempo. Feel the muscle working." },
      3: { setsReps: "4x12", rest: "45 seconds", note: "Less rest, more work. This is where home training gets hard." },
      4: { setsReps: "4x15", rest: "30 seconds", note: "Maximum home phase. Minimum rest. Push through." },
      5: { setsReps: "2x10", rest: "90 seconds", note: "Deload. Light and controlled. Recovery week." },
    }
  },
  walk: {
    phases: {
      1: { duration: "15 minutes", pace: "comfortable", note: "Build the habit. 15 minutes every day beats 60 minutes once a week." },
      2: { duration: "25 minutes", pace: "brisk", note: "Slightly breathless but can still talk. This pace burns fat." },
      3: { duration: "35 minutes", pace: "brisk with 5 minute fast intervals every 10 minutes", note: "Intervals accelerate fat loss significantly." },
      4: { duration: "45 minutes", pace: "sustained brisk", note: "Your peak walk. 45 minutes of sustained movement." },
      5: { duration: "20 minutes", pace: "comfortable", note: "Deload walk. Active recovery. Enjoy it." },
    }
  }
};

function getModeKey(trainingMode: string): string {
  if (trainingMode === "walk_only") return "walk";
  if (trainingMode === "gym" || trainingMode === "home") return trainingMode;
  return "home";
}

const INJURY_FILTERS: Record<string, string[]> = {
  knee: ["squat", "squat_bw", "lunge", "deadlift"],
  back: ["deadlift", "barbell_row"],
  shoulder: ["overhead_press", "bench_press", "pushup"],
  wrist: [],
};

const PHASE_CONTEXT: Record<number, string> = {
  1: "You are building the foundation. Show up consistently — results come later.",
  2: "The habit is forming. This is where your body starts to change.",
  3: "You have earned this phase. This is where serious results happen.",
  4: "Peak phase. Your body is ready for this. Push beyond what feels comfortable.",
  5: "Deload week. This is not weakness — this is intelligence. Recovery is part of the programme.",
};

const REST_DAY_MESSAGES: Record<number, string> = {
  1: "10 minute walk and stretch your legs.",
  2: "20 minute walk and foam roll if you have one.",
  3: "30 minute walk — active recovery keeps fat burning.",
  4: "20 minute walk and full body stretch.",
  5: "20 minute gentle walk. Your body is recovering.",
};

function filterEntriesForInjuries(entries: ExerciseEntry[], user: any): ExerciseEntry[] {
  const injuries = (user.injuries || "").toLowerCase();
  if (!injuries || injuries === "none" || injuries === "no") return entries;

  let filtered = [...entries];
  for (const [injury, blockedIds] of Object.entries(INJURY_FILTERS)) {
    if (injuries.includes(injury)) {
      if (injury === "wrist") {
        filtered = filtered.filter(ex => !ex.modification.toLowerCase().includes("wrist"));
      } else {
        filtered = filtered.filter(ex => !blockedIds.some(bid => ex.id.includes(bid)));
      }
    }
  }
  return filtered;
}

function filterExercisesForInjuries(exercises: Exercise[], user: any): Exercise[] {
  const injuries = (user.injuries || "").toLowerCase();
  if (!injuries || injuries === "none" || injuries === "no") return exercises;

  let filtered = [...exercises];
  for (const [injury, blockedIds] of Object.entries(INJURY_FILTERS)) {
    if (injuries.includes(injury)) {
      if (injury === "wrist") {
        filtered = filtered.filter(ex => !ex.modification.toLowerCase().includes("wrist"));
      } else {
        filtered = filtered.filter(ex => !blockedIds.some(bid => ex.id.includes(bid)));
      }
    }
  }
  return filtered;
}

function getExercisesForDay(user: any): { exercises: Exercise[]; isRestDay: boolean } {
  const phase = user.programmePhase || 1;
  const mode = getModeKey((user.trainingMode as string) || "home");
  const dayIndex = (user.programDayIndex || 1) - 1;
  const phaseConfig = PHASE_CONFIG[phase] || PHASE_CONFIG[1];
  const workoutsPerWeek = phaseConfig.weeklyWorkouts;

  const restPattern: Record<number, number[]> = {
    3: [2, 4, 6],
    4: [3, 6],
    5: [5],
  };
  const restDays = restPattern[workoutsPerWeek] || [2, 4, 6];
  const dayOfWeek = dayIndex % 7;

  if (restDays.includes(dayOfWeek)) {
    return { exercises: [], isRestDay: true };
  }

  if (mode === "walk") {
    const walkPhase = (EXERCISE_LIBRARY.walk.phases as any)[phase] || EXERCISE_LIBRARY.walk.phases[1];
    const walkExercise: Exercise = {
      id: `walk_phase${phase}`,
      name: `${walkPhase.duration} Walk`,
      sets: walkPhase.duration,
      plainEnglish: `Pace: ${walkPhase.pace}. ${walkPhase.note}`,
      modification: "Reduce pace if breathless or in pain.",
      reason: walkPhase.note,
      phase,
      muscleGroup: "cardio",
    };
    return { exercises: [walkExercise], isRestDay: false };
  }

  const lib = mode === "gym" ? EXERCISE_LIBRARY.gym : EXERCISE_LIBRARY.home;
  const phaseSettings = (lib.phases as any)[phase] || (lib.phases as any)[1];
  const setsReps = phaseSettings.setsReps;

  const pushPool = filterEntriesForInjuries([...lib.push], user);
  const pullPool = filterEntriesForInjuries([...lib.pull], user);
  const legsPool = filterEntriesForInjuries([...lib.legs], user);
  const corePool = filterEntriesForInjuries([...lib.core], user);

  function pickRotating(pool: ExerciseEntry[], dayIdx: number): ExerciseEntry | null {
    if (pool.length === 0) return null;
    return pool[dayIdx % pool.length];
  }

  const selected: Exercise[] = [];

  const pushEx = pickRotating(pushPool, dayIndex);
  if (pushEx) {
    selected.push({ ...pushEx, sets: setsReps, phase, videoUrl: pushEx.videoUrl });
  }

  const pullEx = pickRotating(pullPool, dayIndex);
  if (pullEx) {
    selected.push({ ...pullEx, sets: setsReps, phase, videoUrl: pullEx.videoUrl });
  }

  const leg1 = pickRotating(legsPool, dayIndex);
  if (leg1) {
    selected.push({ ...leg1, sets: setsReps, phase, videoUrl: leg1.videoUrl });
  }
  if (legsPool.length > 1) {
    const leg2 = pickRotating(legsPool, dayIndex + 1);
    if (leg2 && leg2.id !== leg1?.id) {
      selected.push({ ...leg2, sets: setsReps, phase, videoUrl: leg2.videoUrl });
    }
  }

  const coreEx = pickRotating(corePool, dayIndex);
  if (coreEx) {
    selected.push({ ...coreEx, sets: setsReps, phase, videoUrl: coreEx.videoUrl });
  }

  return { exercises: selected, isRestDay: false };
}

function adjustSetsForAge(sets: string, age: number): string {
  if (age < 70) return sets;
  const match = sets.match(/^(\d+)x(\d+)/);
  if (match) {
    const newSets = Math.max(1, parseInt(match[1]) - 1);
    return sets.replace(/^\d+x/, `${newSets}x`);
  }
  return sets;
}

function formatWorkoutMessage(user: any, exercises: Exercise[], isRestDay: boolean): string {
  const phase = user.programmePhase || 1;
  const phaseConfig = PHASE_CONFIG[phase] || PHASE_CONFIG[1];
  const day = user.programDayIndex || 1;
  const age = user.age ? parseInt(user.age) : 30;
  const goal = (user.goalType || "").toLowerCase();
  const mode = getModeKey((user.trainingMode as string) || "home");

  if (isRestDay) {
    const restMsg = REST_DAY_MESSAGES[phase] || REST_DAY_MESSAGES[1];
    return `Phase ${phase}: ${phaseConfig.name} — Week ${user.programmeWeek || 1}\nToday: Day ${day}\n\nRest day — but not a lazy day. Today: ${restMsg} This is part of the programme — do it.\n\nReply DONE when finished.`;
  }

  const phaseContext = PHASE_CONTEXT[phase] || PHASE_CONTEXT[1];
  const showMods = age >= 60 || (user.injuries && user.injuries.toLowerCase() !== "none" && user.injuries.toLowerCase() !== "no");
  let msg = `Phase ${phase}: ${phaseConfig.name} — Week ${user.programmeWeek || 1}\nToday: Day ${day}\n${phaseContext}\n`;

  for (const ex of exercises) {
    const displaySets = adjustSetsForAge(ex.sets, age);
    msg += `\n${ex.name} — ${displaySets}\n${ex.plainEnglish}\n`;
    if (showMods && ex.modification && ex.modification !== "None needed." && ex.modification !== "None needed — weight is already very light.") {
      msg += `Modify: ${ex.modification}\n`;
    }
    if (ex.videoUrl) {
      msg += `Watch: ${ex.videoUrl}\n`;
    }
  }

  const restBetween = phaseConfig.rest || "60s";
  msg += `\nRest between sets: ${restBetween}`;

  if (age >= 70) {
    msg += `\nAt your level recovery is priority. Quality over quantity always.`;
  }
  if (age <= 17) {
    msg += `\nFocus on form today — not weight. Building correct movement patterns now means less injury for life.`;
  }

  if ((goal.includes("fat") || goal.includes("loss")) && (mode === "gym" || mode === "home")) {
    msg += `\nFinisher: 10 min continuous movement — jump rope, mountain climbers, or fast squats.`;
  }
  if (goal.includes("muscle")) {
    msg += `\nEat protein within 30 min of finishing.`;
  }

  msg += `\n\nReply DONE when finished.`;
  return msg;
}

function formatDailyWorkoutSummary(user: any): string {
  const { exercises, isRestDay } = getExercisesForDay(user);
  const phase = user.programmePhase || 1;
  const day = user.programDayIndex || 1;

  if (isRestDay) {
    const restMsg = REST_DAY_MESSAGES[phase] || REST_DAY_MESSAGES[1];
    return `Rest day — but not a lazy day. ${restMsg}`;
  }

  const names = exercises.map(e => `${e.name} ${e.sets}`).join(". ");
  return `Day ${day}: ${names}. Reply DONE when finished.`;
}

function parseFoodMessage(text: string) {
  const upper = text.toUpperCase();
  const tokens = upper.split(/[\s,.;]+/).filter(t => t.length > 1);

  const proteinKeywords = ["CHICKEN", "EGGS", "EGG", "FISH", "BEANS", "LENTILS", "LIVER", "PILCHARDS", "BEEF", "STEAK", "TUNA", "SARDINES", "YOGURT", "COTTAGE", "MINCE"];
  const junkKeywords = ["PIZZA", "DONUT", "DOUGHNUT", "CHOCOLATE", "CHIPS", "FRIES", "MAGWINYA", "KOTA", "BURGER", "SWEETS", "CAKE", "BISCUITS", "MCDONALDS", "KFC", "STEERS", "NANDOS"];
  const alcoholKeywords = ["BEER", "WINE", "WHISKY", "VODKA", "SAVANNA", "HUNTERS", "SPIRITS", "BRANDY", "GIN", "RUM", "CIDER"];
  const carbKeywords = ["PAP", "RICE", "PASTA", "BREAD", "SAMP", "POTATO", "POTATOES", "DUMPLING", "DUMPLINGS", "OATS", "MEALIE"];
  const drinkKeywords = ["WATER", "COKE", "PEPSI", "FANTA", "SPRITE", "JUICE", "SODA", "TEA", "COFFEE", "MILK", "SHAKE"];
  const mealKeywords = ["BREAKFAST", "LUNCH", "DINNER", "SNACK", "SUPPER"];

  const proteinItems: string[] = [];
  const junkItems: string[] = [];
  const alcoholItems: string[] = [];
  const carbItems: string[] = [];
  const drinks: string[] = [];
  const mealHints: string[] = [];

  tokens.forEach(t => {
    if (proteinKeywords.includes(t)) proteinItems.push(t);
    if (junkKeywords.includes(t)) junkItems.push(t);
    if (alcoholKeywords.includes(t)) alcoholItems.push(t);
    if (carbKeywords.includes(t)) carbItems.push(t);
    if (drinkKeywords.includes(t)) drinks.push(t);
    if (mealKeywords.includes(t)) mealHints.push(t);
  });

  const quantities = text.match(/\d+(\.\d+)?\s*(L|ML|KG|G|FISTS?|PLATES?|SLICES?|PIECES?|BEERS?|GLASSES?|CUPS?)/gi) || [];
  const isDailyDump = mealHints.length >= 2 || tokens.length >= 8 || mealHints.some(m => ["BREAKFAST", "LUNCH", "DINNER", "SUPPER"].includes(m));

  return {
    foods: tokens.filter(t => ![...drinkKeywords, ...mealKeywords, ...alcoholKeywords].includes(t)),
    drinks,
    mealHints,
    quantities,
    carbItems: Array.from(new Set(carbItems)),
    junkItems: Array.from(new Set(junkItems)),
    alcoholItems: Array.from(new Set(alcoholItems)),
    proteinItems: Array.from(new Set(proteinItems)),
    isDailyDump,
    tokenCount: tokens.length
  };
}

async function buildUserContext(user: any): Promise<string> {
  try {
    const now = new Date();
    const joinedDaysAgo = user.createdAt ? Math.floor((now.getTime() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24)) : 0;
    const dayOfWeek = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
    const daysSinceActive = user.lastActiveAt ? Math.floor((now.getTime() - new Date(user.lastActiveAt).getTime()) / (1000 * 60 * 60 * 24)) : 0;

    const recentFood = await getRecentFoodContext(user.id);
    const weightLogs = await storage.getWeightLogs(user.id);
    const stepLogs = await storage.getStepLogs(user.id);

    const recentWeights = weightLogs.slice(0, 3).map((w: any) => w.weight);
    const weightTrend = recentWeights.length >= 2
      ? (parseFloat(recentWeights[0]) < parseFloat(recentWeights[1]) ? 'losing' : parseFloat(recentWeights[0]) > parseFloat(recentWeights[1]) ? 'gaining' : 'plateauing')
      : 'unknown';

    const recentSteps = stepLogs.slice(0, 7).map((s: any) => s.steps);
    const avgSteps = recentSteps.length > 0 ? Math.round(recentSteps.reduce((a: number, b: number) => a + b, 0) / recentSteps.length) : 0;
    const stepTrend = recentSteps.length >= 2
      ? (recentSteps[0] > recentSteps[1] ? 'improving' : 'declining')
      : 'unknown';

    const phase = user.programmePhase || 1;
    const phaseConfig = PHASE_CONFIG[phase] || PHASE_CONFIG[1];
    const nutrition = NUTRITION_BY_PHASE[phase] || NUTRITION_BY_PHASE[1];

    return `
CLIENT PROFILE:
Name: ${user.name || 'unknown'}
Age: ${user.age || 'unknown'}
Goal: ${user.goalType || 'fat loss'}
Training mode: ${user.trainingMode || 'home'}
Training experience: ${user.trainingExperience || 'unknown'}
Programme phase: Phase ${phase} — ${phaseConfig.name}
Programme week: ${user.programmeWeek || 1} of ${phaseConfig.weeks}
Days on programme: ${joinedDaysAgo}
Total workouts completed: ${user.totalWorkoutsCompleted || 0}
Compliance level: ${user.complianceLevel || 'BUILDING'}
Weekly score: ${user.weeklyScore || 0}/100
Calorie target: ${user.calorieTarget || 2000}kcal
Step target: ${phaseConfig.stepTarget}
Current weight: ${user.currentWeight || 'unknown'}kg
Weight trend: ${weightTrend}
Average steps this week: ${avgSteps}
Step trend: ${stepTrend}
Days since last active: ${daysSinceActive}
Day of week: ${dayOfWeek}
Health conditions noted: ${user.injuries || 'none'}
Recent food: ${recentFood || 'nothing logged recently'}

PHASE ${phase} NUTRITION CONTEXT:
Focus: ${nutrition.focus}
Carb timing: ${nutrition.carbTiming}
Key habit: ${nutrition.keyHabit}
Weekly target: ${nutrition.weeklyTarget}
Coach food responses according to this phase. Phase 1-2: encourage consistency. Phase 3-4: demand precision. Phase 5: emphasize clean recovery eating.
    `.trim();
  } catch (e) {
    return `Client: ${user.name || 'unknown'}, Goal: ${user.goalType || 'fat loss'}`;
  }
}

async function getKamLifeFoodReply(
  userMessage: string,
  userCalories: number,
  userContext: string,
  userName: string
): Promise<{reply: string, nextState: string}> {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 150,
      messages: [
        {
          role: "system",
          content: `${KAMLIFE_MASTER_PROMPT}

FOOD-SPECIFIC INSTRUCTIONS:
You understand ALL South African foods including pap, samp, umngqusho, morogo, chakalaka, vetkoek, magwinya, kota, gatsbys, braai meat, wors, boerewors, tripe, mogodu, umleqwa, pilchards, tinned fish, Spar pies, Shoprite specials, amagwinya, umqombothi, Savanna, Hunters, Black Label, street food, township food, suburban food — everything.
SPAZA SHOP FOODS: Russians and polony are high fat processed meat — coach firmly to limit these. Fat cakes and vetkoek are junk — coach firmly to avoid. Also recognise pap en vleis, chakalaka, umngqusho, samp, mogodu, mashonzha as SA staples.
Respond to exactly what they ate — be specific. Junk food: call it out firmly. Alcohol: be strict. No protein: name what to add. Skipped meal: firm instruction to eat protein now.
RESPONSE LENGTH: Maximum 3 sentences for WhatsApp. Never more than 60 words per response.

RESPONSE FORMAT — return JSON only:
{
  "reply": "your coaching message here",
  "isJunk": true/false,
  "isAlcohol": true/false,
  "hasProtein": true/false,
  "hasCarbs": true/false,
  "needsPortionCheck": true/false,
  "carbName": "name of main carb if present, else null"
}

${userContext}`
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(completion.choices[0].message.content || "{}");

    let nextState = "drink";
    if (result.needsPortionCheck && result.hasCarbs && !result.isJunk) {
      nextState = "portion";
    }

    return {
      reply: result.reply || "Logged. Make your next meal count.",
      nextState
    };
  } catch (e) {
    return {
      reply: "Logged. Protein at every meal — that's the standard.",
      nextState: "drink"
    };
  }
}

async function getRecentFoodContext(userId: string): Promise<string> {
  try {
    const yesterday = new Date();
    yesterday.setHours(yesterday.getHours() - 24);
    const recent = await db.select().from(chatHistory)
      .where(and(eq(chatHistory.userId, userId), gte(chatHistory.createdAt, yesterday)));
    const foodLogs = recent
      .filter(c => c.intent && ["LOG_FOOD", "JUNK_LOGGED", "DAILY_DUMP_LOGGED", "PORTION_CHECK"].includes(c.intent))
      .map(c => c.messageIn)
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
    return foodLogs ? `Last 24hrs they ate: ${foodLogs}` : "";
  } catch (e) {
    return "";
  }
}

function classifyFood(text: string) {
  const parsing = parseFoodMessage(text);
  const categories: string[] = [];
  
  if (parsing.proteinItems.length > 0) categories.push("Protein source");
  if (parsing.carbItems.length > 0) categories.push("Carb-heavy");
  if (parsing.junkItems.length > 0) categories.push("Junk food");

  const isJunk = parsing.junkItems.length > 0;
  const isAlcohol = /BEER|WINE|WHISKY|VODKA|SAVANNA|HUNTERS/.test(text.toUpperCase());
  const isCarbHeavy = parsing.carbItems.length > 0;
  const isBalanced = parsing.proteinItems.length > 0 && isCarbHeavy && !isJunk;

  return {
    categories,
    flags: { isJunk, isAlcohol, isCarbHeavy, isBalanced },
    toneSeverity: (isJunk || isAlcohol) ? "high" : "normal",
    recoveryEligibility: !isJunk && !isAlcohol && parsing.proteinItems.length > 0
  };
}

async function parseIntent(message: string): Promise<{ intent: string; data?: any }> {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `${KAMLIFE_MASTER_PROMPT}

You are also the intent parser. Classify the user message into one of these intents: onboarding_answer, log_steps, log_workout, log_weight, weekly_checkin_response, hungry, general_question.
Return JSON only: { "intent": "...", "data": { ... } }`
        },
        { role: "user", content: message }
      ],
      response_format: { type: "json_object" }
    });
    return JSON.parse(completion.choices[0].message.content || "{}");
  } catch (e) {
    return { intent: "general_question" };
  }
}

const ROTATING_MOTIVATIONS = [
  "Stay consistent.",
  "One meal at a time.",
  "Show up tomorrow.",
  "The work is the answer."
];
function getRotatingMotivation(): string {
  return ROTATING_MOTIVATIONS[Math.floor(Math.random() * ROTATING_MOTIVATIONS.length)];
}

async function generateReply(message: string, intent: string, context: any): Promise<string> {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `${KAMLIFE_MASTER_PROMPT}

RESPONSE LENGTH: Maximum 3 sentences for WhatsApp. Never more than 60 words per response.

Context: ${JSON.stringify(context)}`
        },
        { role: "user", content: message }
      ]
    });
    return completion.choices[0].message.content || getRotatingMotivation();
  } catch (e) {
    return getRotatingMotivation();
  }
}

function runRulesEngine(user: any, logs: any, checkins: any) {
  let updatedTargets = { ...user };
  let adjustments = [];
  let escalationFlag = false;

  // 1) Plateau
  if (checkins.length >= 2) {
    const w1 = Number(checkins[0].weight);
    const w2 = Number(checkins[1].weight);
    if (w1 >= w2) {
      updatedTargets.calorieTarget = (user.calorieTarget || 2000) - 150;
      adjustments.push("Plateau: reduced calories by 150.");
    }
  }

  // 2) Steps low
  if (checkins.length > 0 && Number(checkins[0].avgSteps) < 6000) {
    updatedTargets.stepsTarget = 8000;
    adjustments.push("This week we push steps. Target 8k/day. 30 min incline walk.");
  }

  // 3) Inactive
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  if (!user.lastActiveAt || new Date(user.lastActiveAt) < sevenDaysAgo) {
    escalationFlag = true;
  }

  return { updatedTargets, adjustments, escalationFlag };
}

import { registerAdminTestRoutes } from "./admin-test";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  registerAdminTestRoutes(app);

  // ============================================================
  // Health Check
  // ============================================================
  app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", service: "KamLife Coach", timestamp: new Date().toISOString() });
  });

  // ============================================================
  // SINGLE Twilio WhatsApp Webhook (consolidated)
  // ============================================================
  app.post("/twilio/whatsapp", async (req, res) => {
    const { From, Body } = req.body;
    const phoneNumber = From;
    const message = Body || "";
    const cleanMsg = message.trim().toUpperCase();
    const paymentLink = "https://payfast.co.za/mock-pay";

    if (req.body.MediaContentType0 && req.body.MediaContentType0.includes("audio")) {
      return res.type('text/xml').send(`<Response><Message>Please send a text message — type what you ate, your steps, or how your workout went.</Message></Response>`);
    }

    const redFlagWords = ["dizzy", "dizziness", "chest pain", "can't breathe", "faint", "fainting", "heart pain", "collapsed", "vomiting"];
    const lowerMsg = message.toLowerCase();
    if (redFlagWords.some(w => lowerMsg.includes(w))) {
      const safetyReply = "Stop what you are doing. If you are experiencing chest pain, dizziness or difficulty breathing — stop exercising immediately and contact a medical professional or call 10177. Your safety comes first. We will be here when you are ready to continue.";
      const safetyUser = await storage.getUserByPhone(phoneNumber);
      if (safetyUser) await storage.logChat(safetyUser.id, message, safetyReply, "RED_FLAG_ESCALATION");
      return res.type('text/xml').send(`<Response><Message>${safetyReply}</Message></Response>`);
    }

    // ── CRISIS LANGUAGE — highest priority after red flags ──
    const crisisWords = ["want to die", "kill myself", "suicide", "end my life", "not worth living", "give up on life"];
    if (crisisWords.some(w => lowerMsg.includes(w))) {
      const crisisReply = "I hear you and I am concerned about you. Please call Samaritans South Africa right now: 0800 567 567 — it is free and available 24 hours. You matter more than any fitness goal.";
      const crisisUser = await storage.getUserByPhone(phoneNumber);
      if (crisisUser) await storage.logChat(crisisUser.id, message, crisisReply, "CRISIS");
      return res.type('text/xml').send(`<Response><Message>${crisisReply}</Message></Response>`);
    }

    function getMenuText(u: any): string {
      const created = u?.createdAt ? new Date(u.createdAt) : null;
      const daysActive = created ? Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24)) : 0;
      if (daysActive > 30) {
        return `KamLife — go:\n1) Workout 2) Food 3) Steps 4-7 for more\nOr just type it.`;
      }
      if (daysActive > 7) {
        return `KamLife Coach — what do you need?\n1) Workout 2) Food 3) Steps 4) Sleep 5) Weight\nOr just tell me what you ate, your steps, or how training went.`;
      }
      return `KamLife Coach — What do you want to do?\n1) Today's workout\n2) Log food\n3) Log steps\n4) Log sleep\n5) Log weight\n6) Show my targets\n7) Update my profile\nReply 1-7.`;
    }
    const menuText = getMenuText(null);

    // ── Priority 1: GREETING GUARD ──
    const rawMsg = message.trim().toLowerCase().replace(/[^\w\s]/g, "");
    const greetings = ["hi", "hello", "hey", "howzit", "sup", "yo", "sawubona", "dumela", "molo", "molweni"];
    const rawWords = rawMsg.split(/\s+/);
    const isGreeting = greetings.includes(rawMsg) || (message.length <= 20 && rawWords.some((w: string) => greetings.includes(w)) && !/\d/.test(message));

    if (isGreeting) {
      let user = await storage.getUserByPhone(phoneNumber);
      if (user) {
        await storage.updateUser(user.id, { awaitingInputType: null, lastActiveAt: new Date() });
        const menu = getMenuText(user);
        await storage.logChat(user.id, message, menu, "COACH_MENU");
        return res.type('text/xml').send(`<Response><Message>${menu}</Message></Response>`);
      }
    }

    // ── Priority 1.5: INFORMAL SA LANGUAGE ──
    const saAckWords = ["YEBO", "JA", "AWEH", "SHO", "LEKKER", "SHARP", "SHARP SHARP", "KE SHARP"];
    if (saAckWords.includes(cleanMsg)) {
      let user = await storage.getUserByPhone(phoneNumber);
      if (user) {
        await storage.updateUser(user.id, { awaitingInputType: null, lastActiveAt: new Date() });
        const menu = getMenuText(user);
        await storage.logChat(user.id, message, menu, "SA_SLANG_ACK");
        return res.type('text/xml').send(`<Response><Message>${menu}</Message></Response>`);
      }
    }
    const saNoWords = ["NEE", "AIKONA"];
    if (saNoWords.includes(cleanMsg)) {
      let user = await storage.getUserByPhone(phoneNumber);
      if (user) {
        const reply = "Noted. Just tell me what you need when you are ready.";
        await storage.logChat(user.id, message, reply, "SA_SLANG_NO");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
    }
    const saGreetWords = ["EITA", "AIGHT", "AITE"];
    if (saGreetWords.includes(cleanMsg)) {
      let user = await storage.getUserByPhone(phoneNumber);
      if (user) {
        await storage.updateUser(user.id, { awaitingInputType: null, lastActiveAt: new Date() });
        const menu = getMenuText(user);
        await storage.logChat(user.id, message, menu, "SA_SLANG_GREET");
        return res.type('text/xml').send(`<Response><Message>${menu}</Message></Response>`);
      }
    }
    const saCoachWords = ["YEBO COACH", "SHARP COACH", "LEKKER COACH"];
    if (saCoachWords.includes(cleanMsg)) {
      let user = await storage.getUserByPhone(phoneNumber);
      if (user) {
        const motivation = getRotatingMotivation();
        const menu = getMenuText(user);
        const reply = `${motivation}\n\n${menu}`;
        await storage.logChat(user.id, message, reply, "SA_SLANG_COACH");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
    }
    if (cleanMsg === "HAIBO" || cleanMsg === "HAYIBO") {
      let user = await storage.getUserByPhone(phoneNumber);
      if (user) {
        const reply = "Ha — tell me what happened. Type it out.";
        await storage.logChat(user.id, message, reply, "SA_SLANG_HAIBO");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
    }
    if (cleanMsg.includes("EISH")) {
      let user = await storage.getUserByPhone(phoneNumber);
      if (user) {
        const reply = "Talk to me — what is going on? Type what you ate or how you are feeling and I will help you get back on track.";
        await storage.logChat(user.id, message, reply, "SA_SLANG_EISH");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    // ── Priority 2: CANARY (PING) ──
    if (cleanMsg === "PING") {
      return res.type('text/xml').send(`<Response><Message>PONG v2 ✅ Replit webhook live</Message></Response>`);
    }

    // ── Priority 3: New user check ──
    let user = await storage.getUserByPhone(phoneNumber);
    const betaTesters = (process.env.BETA_TESTERS || "").split(",").map(p => p.trim());
    const isBetaTester = betaTesters.includes(phoneNumber);

    if (!user) {
      const referMatch = cleanMsg.match(/^REFER\s+(\w+)$/);
      if (referMatch) {
        const referCode = referMatch[1].toUpperCase();
        const referrer = await storage.getUserByReferralCode(referCode);
        if (referrer && referrer.phoneNumber !== phoneNumber) {
          const trialExpiry = new Date();
          trialExpiry.setDate(trialExpiry.getDate() + 7);
          user = await storage.createUser({
            phoneNumber,
            subscriptionStatus: "active",
            betaBypassUntil: trialExpiry,
            referredBy: referCode,
            onboardingState: "AWAITING_NAME"
          });
          const referrerExpiry = referrer.betaBypassUntil ? new Date(referrer.betaBypassUntil) : new Date();
          referrerExpiry.setDate(referrerExpiry.getDate() + 7);
          await storage.updateUser(referrer.id, { betaBypassUntil: referrerExpiry });
          await storage.logChat(user.id, message, "Referral signup", "REFERRAL_NEW_USER");
          await storage.logChat(referrer.id, `Referral used by ${phoneNumber}`, "7 days added to your account", "REFERRAL_REWARD");
          return res.type('text/xml').send(`<Response><Message>Welcome to KamLife Coach.\n\nYou just made a decision that most people talk about and never act on. That already makes you different.\n\nNo keto. No detox teas. No shortcuts. Just structure, protein, and consistency — applied to your life, your food, your schedule.\n\nI have coached people aged 14 to 80. Domestic workers, executives, students, grandmothers. The ones who get results are not the most talented — they are the most consistent.\n\nLet us build your profile. What is your name?</Message></Response>`);
        }
      }
      if (isBetaTester) {
        const bypassExpiry = new Date();
        bypassExpiry.setDate(bypassExpiry.getDate() + 14);
        user = await storage.createUser({
          phoneNumber,
          subscriptionStatus: "active",
          betaBypassUntil: bypassExpiry,
          onboardingState: "AWAITING_NAME"
        });
        console.log(`[BETA BYPASS] Created new beta user: ${phoneNumber}, expires: ${bypassExpiry}`);
        return res.type('text/xml').send(`<Response><Message>Welcome to KamLife Coach.\n\nNo keto. No detox teas. No waist trainers. No shortcuts.\n\nJust real coaching built for real South Africans — by someone who has spent 20 years in the trenches with real people.\n\nThis is not an app. This is a coach in your pocket.\n\nWhat is your name?</Message></Response>`);
      } else {
        return res.type('text/xml').send(`<Response><Message>Welcome to KamLife Coach.\n\nYou just made a decision that most people talk about and never act on. That already makes you different.\n\nNo keto. No detox teas. No shortcuts. Just structure, protein, and consistency — applied to your life, your food, your schedule.\n\nI have coached people aged 14 to 80. Domestic workers, executives, students, grandmothers. The ones who get results are not the most talented — they are the most consistent.\n\nSubscribe here to begin: ${paymentLink}</Message></Response>`);
      }
    }

    // ── Priority 4: ADMIN BYPASS (BYPASS ON/OFF) ──
    if (cleanMsg === "BYPASS ON") {
      await storage.updateUser(user.id, { subscriptionStatus: "active" });
      return res.type('text/xml').send(`<Response><Message>Admin Bypass: ON ✅ You are now an active user.</Message></Response>`);
    }
    if (cleanMsg === "BYPASS OFF") {
      await storage.updateUser(user.id, { subscriptionStatus: "inactive" });
      return res.type('text/xml').send(`<Response><Message>Admin Bypass: OFF ❌ Subscription required.</Message></Response>`);
    }

    // ── Priority 5: Subscription check ──
    if (isBetaTester && user.subscriptionStatus !== "active") {
      const bypassExpiry = new Date();
      bypassExpiry.setDate(bypassExpiry.getDate() + 14);
      await storage.updateUser(user.id, {
        subscriptionStatus: "active",
        betaBypassUntil: bypassExpiry,
        onboardingState: user.onboardingState || "AWAITING_NAME"
      });
      user.subscriptionStatus = "active";
    }
    if (user.subscriptionStatus !== "active" && !isBetaTester) {
      return res.type('text/xml').send(`<Response><Message>To continue, subscribe here: ${paymentLink}</Message></Response>`);
    }

    // ── Priority 6: TIMEOUT GUARD ──
    if (user.awaitingInputType) {
      const lastActive = user.lastActiveAt ? new Date(user.lastActiveAt).getTime() : 0;
      if (Date.now() - lastActive > 10 * 60 * 1000) {
        await storage.updateUser(user.id, { awaitingInputType: null });
        user.awaitingInputType = null;
      }
    }

    // ── Priority 7: Update lastActiveAt ──
    await storage.updateUser(user.id, { lastActiveAt: new Date() });

    // ── Priority 7.1: BASELINE WEEK COMPLETION CHECK ──
    if (user.baselineWeekActive && !user.baselineWeekComplete && user.programmeStartDate) {
      const daysSinceStart = Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / (1000 * 60 * 60 * 24));
      if (daysSinceStart >= 7) {
        const phaseNum = user.programmePhase || 1;
        const phaseConfig = PHASE_CONFIG[phaseNum];
        const calTarget = user.calorieTarget || 2000;
        const protTarget = user.proteinTarget || 150;
        await storage.updateUser(user.id, { baselineWeekActive: false, baselineWeekComplete: true });
        const userName = user.name || "coach";
        const baselineReply = `${userName} — your baseline week is done. I have seen your patterns. Your full personalised programme starts now.\n\nHere is your setup:\nGoal: ${user.goalType || "General Fitness"}\nTraining: ${user.trainingMode || "home"}\nPhase: ${phaseNum} — ${phaseConfig.name}\n\nYour daily targets:\nCalories: ${calTarget}kcal\nProtein: ${protTarget}g\nSteps: ${(phaseConfig.stepTarget || 7000).toLocaleString()}\n\nThe real work starts today. Type WORKOUT to get your first session.`;
        await storage.logChat(user.id, message, baselineReply, "BASELINE_COMPLETE");
        return res.type('text/xml').send(`<Response><Message>${baselineReply}</Message></Response>`);
      }
    }

    // ── Priority 7.5: AGE DETECTION ──
    const ageMatch = lowerMsg.match(/(?:i am|im|i'm)\s*(\d{1,2})\s*(?:years?\s*old)?/) || lowerMsg.match(/(\d{1,2})\s*years?\s*old/);
    if (ageMatch) {
      const detectedAge = parseInt(ageMatch[1]);
      if (detectedAge >= 14 && detectedAge <= 17) {
        await storage.updateUser(user.id, { age: detectedAge });
        const reply = `Got you — ${detectedAge} years old. At your age we focus on building healthy habits, not extreme diets. Eat enough protein, stay active, and get your sleep. No skipping meals. What did you eat today?`;
        await storage.logChat(user.id, message, reply, "AGE_DETECTED_TEEN");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      } else if (detectedAge >= 1 && detectedAge <= 100) {
        await storage.updateUser(user.id, { age: detectedAge });
      }
    }

    // ── Priority 8: RESET command ──
    if (cleanMsg === "RESET") {
      await storage.updateUser(user.id, { awaitingInputType: null });
      const menu = `Reset done. ${getMenuText(user)}`;
      await storage.logChat(user.id, message, menu, "COACH_RESET");
      return res.type('text/xml').send(`<Response><Message>${menu}</Message></Response>`);
    }

    // ── Priority 8.5: HELP command ──
    if (cleanMsg === "HELP") {
      const helpReply = "Here to help.\n\n- Reply RESET if something seems off\n- Reply 7 to update your goal or training mode\n- Just type what you ate, your steps, or your workout — anytime\n\nReply SUPPORT and we will get back to you within 24 hours.";
      await storage.logChat(user.id, message, helpReply, "HELP");
      return res.type('text/xml').send(`<Response><Message>${helpReply}</Message></Response>`);
    }

    // ── Priority 8.51: SUPPORT command ──
    if (cleanMsg === "SUPPORT") {
      const supportReply = "Your support request has been noted. We will follow up with you within 24 hours. In the meantime reply MENU to continue or RESET if something seems stuck.";
      await storage.logChat(user.id, message, supportReply, "SUPPORT_REQUEST");
      return res.type('text/xml').send(`<Response><Message>${supportReply}</Message></Response>`);
    }

    // ── Priority 8.55: CANCEL command ──
    if (cleanMsg === "CANCEL") {
      const cancelReply = "Before you go — tell us why you want to cancel. Reply:\n1) Too expensive\n2) Not getting results\n3) Too busy\nOr reply CONFIRM to cancel.";
      await storage.updateUser(user.id, { awaitingInputType: "awaiting_cancel" });
      await storage.logChat(user.id, message, cancelReply, "CANCEL_INIT");
      return res.type('text/xml').send(`<Response><Message>${cancelReply}</Message></Response>`);
    }

    // ── Priority 8.56: REFER command ──
    if (cleanMsg === "REFER") {
      if (user.referralCode) {
        const code = user.referralCode;
        const reply = `Your referral code is ${code}. Share this with a friend — they get 7 days free when they sign up. When they join you get one week free added to your account. Share this number and tell them to message: REFER ${code} when they sign up.`;
        await storage.logChat(user.id, message, reply, "REFERRAL_CODE");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
      const namePart = (user.name || "KAM").replace(/\s+/g, "").toUpperCase().slice(0, 4);
      const phonePart = phoneNumber.slice(-4);
      let code = `${namePart}${phonePart}`;
      const existing = await storage.getUserByReferralCode(code);
      if (existing && existing.id !== user.id) {
        code = `${namePart}${phonePart}${Math.floor(Math.random() * 90 + 10)}`;
      }
      await storage.updateUser(user.id, { referralCode: code });
      const reply = `Your referral code is ${code}. Share this with a friend — they get 7 days free when they sign up. When they join you get one week free added to your account. Share this number and tell them to message: REFER ${code} when they sign up.`;
      await storage.logChat(user.id, message, reply, "REFERRAL_CODE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 8.57: REJOIN command ──
    if (cleanMsg === "REJOIN") {
      await storage.updateUser(user.id, { subscriptionStatus: "active", cancelledAt: null });
      const reply = "Welcome back. That took courage. Let us pick up where you left off. What do you need?";
      await storage.logChat(user.id, message, reply, "REJOIN");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 8.6: MEAL SUGGESTIONS ──
    const mealTriggers = ["WHAT SHOULD I EAT", "MEAL IDEAS", "FOOD SUGGESTIONS", "WHAT CAN I EAT"];
    if (mealTriggers.some(t => cleanMsg.includes(t))) {
      try {
        const mealRes = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          max_tokens: 200,
          messages: [
            {
              role: "system",
              content: `You are KamLife Coach. Generate a specific one day meal plan for a South African person. Use SA foods — pap, samp, pilchards, eggs, chicken, beans, vetkoek alternatives, oats. Give breakfast, lunch, dinner and one snack. Keep it affordable, practical and high protein. Calorie target: ${user.calorieTarget || 2000}. Goal: ${user.goalType || "general fitness"}. Max 150 words. Firm and specific, no fluff.`
            },
            { role: "user", content: message }
          ]
        });
        const mealPlan = mealRes.choices[0]?.message?.content || "Eat eggs for breakfast, chicken and veg for lunch, pilchards with pap for dinner. Snack on biltong or fruit.";
        await storage.logChat(user.id, message, mealPlan, "MEAL_SUGGESTION");
        return res.type('text/xml').send(`<Response><Message>${mealPlan}</Message></Response>`);
      } catch {
        const fallback = "Eat eggs for breakfast, chicken and veg for lunch, pilchards with pap for dinner. Snack on biltong or fruit.";
        await storage.logChat(user.id, message, fallback, "MEAL_SUGGESTION");
        return res.type('text/xml').send(`<Response><Message>${fallback}</Message></Response>`);
      }
    }

    // ── Priority 8.7: PROGRESS command ──
    if (cleanMsg === "PROGRESS") {
      const weightLogs = await storage.getWeightLogs(user.id);
      const stepLogs = await storage.getStepLogs(user.id);
      const compliance = await calculateWeeklyCompliance(user.id);

      const currentWeight = weightLogs.length > 0 ? weightLogs[0].weight : user.currentWeight || "unknown";
      const fourWeeksAgoWeight = weightLogs.length >= 4 ? weightLogs[3].weight : (weightLogs.length > 0 ? weightLogs[weightLogs.length - 1].weight : "unknown");

      const recentSteps = stepLogs.slice(0, 7);
      const avgSteps = recentSteps.length > 0
        ? Math.round(recentSteps.reduce((sum, s) => sum + s.steps, 0) / recentSteps.length)
        : 0;

      const progressReply = `*Progress Report — ${user.name || "Hey"}*\n\nWeight: ${currentWeight}kg (was ${fourWeeksAgoWeight}kg 4 weeks ago)\nAvg Steps This Week: ${avgSteps.toLocaleString()}/day\nCompliance: ${compliance.score}/100 — ${compliance.level}\n\n${compliance.score >= 90 ? "You are locked in. Keep this standard." : compliance.score >= 70 ? "Solid progress. Tighten up the weak spots this week." : compliance.score >= 50 ? "Room to improve. Pick one area and fix it this week." : "We need to reset. Commit to showing up every day this week."}`;
      await storage.logChat(user.id, message, progressReply, "PROGRESS");
      return res.type('text/xml').send(`<Response><Message>${progressReply}</Message></Response>`);
    }

    // ── Priority 9: STATE HANDLING (single-exit routing) ──
    if (user.awaitingInputType) {
      const inputType = user.awaitingInputType;

      if (inputType === "awaiting_cancel") {
        if (cleanMsg === "CONFIRM") {
          await storage.updateUser(user.id, { awaitingInputType: null, subscriptionStatus: "inactive", cancelledAt: new Date() });
          const reply = "Cancelled. You can rejoin anytime at kamlifecoach.co.za. Stay consistent — even without us.";
          await storage.logChat(user.id, message, reply, "CANCEL_CONFIRMED");
          return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
        } else if (cleanMsg === "STAY") {
          await storage.updateUser(user.id, { awaitingInputType: null });
          const reply = `Great decision. Let's get back to work.\n\n${getMenuText(user)}`;
          await storage.logChat(user.id, message, reply, "CANCEL_STAYED");
          return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
        } else if (cleanMsg === "1") {
          const reply = "We hear you. Reply STAY and we will sort something out. Or reply CONFIRM to cancel.";
          await storage.logChat(user.id, message, reply, "CANCEL_REASON_PRICE");
          return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
        } else if (cleanMsg === "2") {
          const daysSinceJoin = user.createdAt ? Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24)) : 0;
          const reply = `Results come from consistency. You have been here ${daysSinceJoin} days. Give it 30 more — one month of full commitment. Reply STAY to continue or CONFIRM to cancel.`;
          await storage.logChat(user.id, message, reply, "CANCEL_REASON_RESULTS");
          return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
        } else if (cleanMsg === "3") {
          const reply = "KamLife Coach takes 5 minutes a day. Just log your food and steps. Reply STAY to continue or CONFIRM to cancel.";
          await storage.logChat(user.id, message, reply, "CANCEL_REASON_BUSY");
          return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
        } else {
          const reply = "Reply 1, 2, or 3 for your reason. Or reply CONFIRM to cancel, or STAY to keep going.";
          await storage.logChat(user.id, message, reply, "CANCEL_REPROMPT");
          return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
        }
      }

      if (inputType === "anything_else") {
        const anythingParsing = parseFoodMessage(message);
        if (anythingParsing.alcoholItems.length > 0) {
          const ctx = await buildUserContext(user);
          const { reply } = await getKamLifeFoodReply(message, user.calorieTarget || 2000, ctx, user.name || "there");
          await storage.updateUser(user.id, { awaitingInputType: null });
          await storage.logChat(user.id, message, reply, "ALCOHOL_FLAGGED");
          return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
        }
        if (cleanMsg.includes("YES")) {
          await storage.updateUser(user.id, { awaitingInputType: "food" });
          const reply = R.promptFood();
          return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
        } else if (cleanMsg.includes("NO") || cleanMsg === "MENU") {
          await storage.updateUser(user.id, { awaitingInputType: null });
          const menu = getMenuText(user);
          await storage.logChat(user.id, message, menu, "COACH_MENU");
          return res.type('text/xml').send(`<Response><Message>${menu}</Message></Response>`);
        } else {
          const ctx = await buildUserContext(user);
          const { reply } = await getKamLifeFoodReply(
            message,
            user.calorieTarget || 2000,
            ctx,
            user.name || "there"
          );
          await storage.updateUser(user.id, { awaitingInputType: null });
          await storage.logChat(user.id, message, reply, "EXTRA_LOG");
          return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
        }
      }

      if (inputType === "portion") {
        const portionMatch = cleanMsg.match(/[1-3]/);
        const level = portionMatch ? parseInt(portionMatch[0]) : 1;
        await storage.updateUser(user.id, { carbPortionLevel: level, awaitingInputType: "drink" });

        const cals = user.calorieTarget || 2000;
        let targetFists = "1";
        if (cals >= 1800 && cals <= 2400) targetFists = "1–2";
        else if (cals > 2400) targetFists = "2";

        let reaction = level === 1 ? R.portionGood() + " " : R.portionHigh(targetFists) + " ";
        reaction += R.promptDrink();

        await storage.logChat(user.id, message, reaction, "PORTION_LOGGED");
        return res.type('text/xml').send(`<Response><Message>${reaction}</Message></Response>`);
      }

      if (inputType === "drink") {
        if (cleanMsg === "MENU") {
          await storage.updateUser(user.id, { awaitingInputType: null });
          return res.type('text/xml').send(`<Response><Message>${getMenuText(user)}</Message></Response>`);
        }

        const ctx = await buildUserContext(user);
        const { reply } = await getKamLifeFoodReply(
          `They drank: ${message}`,
          user.calorieTarget || 2000,
          ctx,
          user.name || "there"
        );

        await storage.updateUser(user.id, { awaitingInputType: "anything_else" });
        const full = `${reply} Anything else to log? (yes/no)`;
        await storage.logChat(user.id, message, full, "DRINK_LOGGED");
        return res.type('text/xml').send(`<Response><Message>${full}</Message></Response>`);
      }

      if (inputType === "food") {
        const ctx = await buildUserContext(user);
        const { reply } = await getKamLifeFoodReply(
          message,
          user.calorieTarget || 2000,
          ctx,
          user.name || "there"
        );
        await storage.updateUser(user.id, { awaitingInputType: null });
        await storage.logChat(user.id, message, reply, "FOOD_LOGGED");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }

      if (inputType === "steps") {
        await storage.updateUser(user.id, { awaitingInputType: null });
        const kMatch = cleanMsg.match(/(\d+(\.\d+)?)\s*K\b/);
        let steps: number | null = null;
        if (kMatch) {
          steps = Math.round(parseFloat(kMatch[1]) * 1000);
        } else {
          const stepsMatch = cleanMsg.match(/\d+/);
          steps = stepsMatch ? parseInt(stepsMatch[0]) : (cleanMsg.includes("NO STEPS") ? 0 : null);
        }
        if (steps !== null) {
          await storage.createStepLog(user.id, steps);
          const prevLogs = await storage.getStepLogs(user.id);
          const yesterdaySteps = prevLogs.length > 1 ? prevLogs[1].steps : null;

          let reaction = "";
          if (steps < 2000) reaction = R.stepsLow();
          else if (steps >= (user.stepsTarget || 8000)) reaction = R.stepsTarget();
          else reaction = R.stepsGood();

          const comparison = yesterdaySteps !== null ? `\nYesterday: ${yesterdaySteps} steps. Today: ${steps}.` : "";
          let winMoment = "";
          const target = user.stepsTarget || 8000;
          if (prevLogs.length >= 7) {
            const now = new Date();
            let streakValid = true;
            for (let i = 0; i < 7; i++) {
              const log = prevLogs[i];
              if (!log.loggedAt || log.steps < target) { streakValid = false; break; }
              const logDate = new Date(log.loggedAt);
              const expectedDate = new Date(now);
              expectedDate.setDate(expectedDate.getDate() - i);
              if (logDate.toDateString() !== expectedDate.toDateString()) { streakValid = false; break; }
            }
            if (streakValid) {
              winMoment = "\n\n7 days straight hitting your target. That is elite discipline. Screenshot this.";
            }
          }
          const reply = `${reaction}${comparison}${winMoment}`;
          await storage.logChat(user.id, message, reply, "LOG_STEPS_FOLLOWUP");
          return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
        }
      }

      if (inputType === "sleep") {
        await storage.updateUser(user.id, { awaitingInputType: null });
        const sleepMatch = cleanMsg.match(/\d+/);
        const hours = sleepMatch ? parseInt(sleepMatch[0]) : null;
        if (hours !== null) {
          let reaction = "";
          if (hours < 5) reaction = R.sleepPoor();
          else if (hours < 7) reaction = R.sleepOk();
          else reaction = R.sleepGood();
          await storage.logChat(user.id, message, reaction, "LOG_SLEEP_FOLLOWUP");
          return res.type('text/xml').send(`<Response><Message>${reaction}</Message></Response>`);
        }
      }

      if (inputType === "weight") {
        await storage.updateUser(user.id, { awaitingInputType: null });
        const weightMatch = cleanMsg.match(/\d+(\.\d+)?/);
        if (weightMatch) {
          const val = weightMatch[0];
          await storage.createWeightLog(user.id, val);
          await storage.updateUser(user.id, { currentWeight: val });
          let reply = R.weightLogged(val);
          const allWeights = await storage.getWeightLogs(user.id);
          const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
          const baseline = allWeights
            .filter(w => w.loggedAt && (Date.now() - new Date(w.loggedAt).getTime()) >= fourteenDaysMs)
            .sort((a, b) => new Date(b.loggedAt!).getTime() - new Date(a.loggedAt!).getTime())[0];
          if (baseline && (parseFloat(baseline.weight) - parseFloat(val)) >= 2) {
            reply += "\n\nDown 2kg+ in the last 2 weeks. That is the work paying off. Screenshot this and share it.";
          }
          await storage.logChat(user.id, message, reply, "LOG_WEIGHT_FOLLOWUP");
          return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
        }
      }
    }

    // ── Priority 9.5: ONBOARDING GUARD ──
    if (!user.onboardingState || user.onboardingState !== "COMPLETED") {
      const currentState = user.onboardingState || "AWAITING_NAME";
      let reply = "";

      if (currentState === "AWAITING_NAME") {
        const nameInput = message.trim();
        if (/^\d+$/.test(nameInput) || nameInput.length < 2) {
          reply = "Please enter your name so we can get started.";
        } else {
          const formattedName = nameInput.toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase());
          await storage.updateUser(user.id, { name: formattedName, onboardingState: "AWAITING_WEIGHT" });
          reply = `Good to meet you, ${formattedName}. By continuing you agree to our coaching terms — KamLife Coach provides fitness guidance only, not medical advice. Consult a doctor before starting any programme.\n\nHow much do you weigh right now? Just the number in kg — no judgment here, just data.`;
        }
      } else if (currentState === "AWAITING_WEIGHT") {
        const weightVal = parseFloat(message);
        if (!weightVal || weightVal < 30 || weightVal > 300) {
          reply = "Please enter a valid weight in kg (e.g. 85).";
        } else {
          await storage.updateUser(user.id, { currentWeight: String(weightVal), onboardingState: "AWAITING_TRAINING_MODE" });
          reply = "Good. Where will you be training?\n1) Gym\n2) At home\n3) Walking only";
        }
      } else if (currentState === "AWAITING_TRAINING_MODE") {
        let mode: string | null = null;
        if (cleanMsg === "1" || cleanMsg.includes("GYM")) mode = "gym";
        else if (cleanMsg === "2" || cleanMsg.includes("HOME")) mode = "home";
        else if (cleanMsg === "3" || cleanMsg.includes("WALK")) mode = "walk_only";
        if (mode) {
          if (mode === "home") {
            await storage.updateUser(user.id, { trainingMode: mode, onboardingState: "AWAITING_EQUIPMENT" });
            reply = "What equipment do you have at home? Reply with numbers —\n1) No equipment\n2) Resistance bands\n3) Dumbbells\n4) Kettlebell\n5) Pull up bar\n6) Skipping rope\n7) Mix — tell me what you have";
          } else {
            await storage.updateUser(user.id, { trainingMode: mode, onboardingState: "AWAITING_GOAL" });
            reply = "What is your main goal?\n1) Lose fat\n2) Build muscle\n3) Body recomposition — lose fat and gain muscle simultaneously\n4) General fitness and health";
          }
        } else {
          reply = "Please reply 1, 2, or 3.\n1) Gym\n2) At home\n3) Walking only";
        }
      } else if (currentState === "AWAITING_EQUIPMENT") {
        let equipmentValue = message.trim();
        if (cleanMsg === "1") equipmentValue = "none";
        else if (cleanMsg === "2") equipmentValue = "resistance bands";
        else if (cleanMsg === "3") equipmentValue = "dumbbells";
        else if (cleanMsg === "4") equipmentValue = "kettlebell";
        else if (cleanMsg === "5") equipmentValue = "pull up bar";
        else if (cleanMsg === "6") equipmentValue = "skipping rope";
        else if (cleanMsg === "7") equipmentValue = message.trim();
        await storage.updateUser(user.id, { homeEquipment: equipmentValue, onboardingState: "AWAITING_GOAL" });
        reply = "What is your main goal?\n1) Lose fat\n2) Build muscle\n3) Body recomposition — lose fat and gain muscle simultaneously\n4) General fitness and health";
      } else if (currentState === "AWAITING_GOAL") {
        let goalValue = message;
        const weight = parseFloat(user.currentWeight as string) || 70;
        let notes = user.profileNotes || "";
        if (cleanMsg === "1") goalValue = "Fat Loss";
        else if (cleanMsg === "2") goalValue = "Muscle Gain";
        else if (cleanMsg === "3") {
          goalValue = "Recomposition";
          notes += "Recomposition client — scale may not move but body will transform. Measure progress with measurements and photos not weight. ";
        }
        else if (cleanMsg === "4") goalValue = "General Fitness";

        await storage.updateUser(user.id, { goalType: goalValue, profileNotes: notes || null, onboardingState: "AWAITING_ACTIVITY" });

        if ((goalValue === "Muscle Gain" || goalValue === "Recomposition")) {
          await storage.updateUser(user.id, { onboardingState: "AWAITING_FOCUS" });
          reply = "What is your priority focus area?\n1) Full body general\n2) Glutes and legs — bigger and stronger lower body\n3) Upper body strength\n4) Core and stomach";
        } else {
          reply = "How active are you during the day?\n1) Sedentary — desk job or mostly sitting\n2) Lightly active — some movement\n3) Moderately active\n4) Very active — on feet all day retail nursing teaching construction\n5) Extremely active — physical labour or train twice daily";
        }
      } else if (currentState === "AWAITING_FOCUS") {
        let focusValue = message.trim();
        if (cleanMsg === "1") focusValue = "full body";
        else if (cleanMsg === "2") focusValue = "glutes and legs";
        else if (cleanMsg === "3") focusValue = "upper body";
        else if (cleanMsg === "4") focusValue = "core and stomach";
        await storage.updateUser(user.id, { primaryFocusArea: focusValue, onboardingState: "AWAITING_ACTIVITY" });
        reply = "How active are you during the day?\n1) Sedentary — desk job or mostly sitting\n2) Lightly active — some movement\n3) Moderately active\n4) Very active — on feet all day retail nursing teaching construction\n5) Extremely active — physical labour or train twice daily";
      } else if (currentState === "AWAITING_ACTIVITY") {
        let actLevel: string | null = null;
        if (cleanMsg === "1") actLevel = "sedentary";
        else if (cleanMsg === "2") actLevel = "lightly active";
        else if (cleanMsg === "3") actLevel = "moderately active";
        else if (cleanMsg === "4") actLevel = "very active";
        else if (cleanMsg === "5") actLevel = "extremely active";
        if (actLevel) {
          await storage.updateUser(user.id, { activityLevel: actLevel, onboardingState: "AWAITING_JOB" });
          reply = "What do you do for work or study? Examples: student, retail, office, construction, domestic work, unemployed, nursing, driving. Just tell me briefly.";
        } else {
          reply = "Please reply 1, 2, 3, 4, or 5.\n1) Sedentary\n2) Lightly active\n3) Moderately active\n4) Very active\n5) Extremely active";
        }
      } else if (currentState === "AWAITING_JOB") {
        await storage.updateUser(user.id, { jobType: message.trim(), onboardingState: "AWAITING_LIFE_SITUATION" });
        reply = "Any of these apply to you? Reply with numbers —\n1) Student in res or shared house\n2) Domestic worker\n3) Night shift worker\n4) Long commute 2 plus hours daily\n5) Unemployed\n6) None of these";
      } else if (currentState === "AWAITING_LIFE_SITUATION") {
        let sitValue = message.trim();
        if (cleanMsg === "1") sitValue = "student in res";
        else if (cleanMsg === "2") sitValue = "domestic worker";
        else if (cleanMsg === "3") sitValue = "night shift";
        else if (cleanMsg === "4") sitValue = "long commute";
        else if (cleanMsg === "5") sitValue = "unemployed";
        else if (cleanMsg === "6") sitValue = "none";
        await storage.updateUser(user.id, { lifeSituation: sitValue, onboardingState: "AWAITING_AGE" });
        reply = "How old are you? This helps us personalise your programme.";
      } else if (currentState === "AWAITING_AGE") {
        const ageVal = parseInt(message);
        if (!ageVal || ageVal < 10 || ageVal > 100) {
          reply = "Please enter your age as a number (e.g. 32).";
        } else {
          await storage.updateUser(user.id, { age: ageVal, onboardingState: "AWAITING_CONDITIONS" });
          reply = "Any injuries, chronic conditions or health issues we should know about before we start? Examples: bad knee, diabetes, hypertension, pregnancy. Reply NONE if nothing to declare.";
        }
      } else if (currentState === "AWAITING_CONDITIONS") {
        const conditionText = cleanMsg === "NONE" || cleanMsg === "NO" || cleanMsg === "NOTHING" ? null : message;
        await storage.updateUser(user.id, { injuries: conditionText, onboardingState: "AWAITING_EXPERIENCE" });
        reply = "Last question — how long have you been training consistently?\n1) Never or just starting\n2) A few months on and off\n3) More than 6 months consistently";
      } else if (currentState === "AWAITING_EXPERIENCE") {
        let experience = message;
        let startingPhase = 1;
        if (cleanMsg === "1" || cleanMsg.includes("NEVER") || cleanMsg.includes("JUST START")) {
          experience = "beginner";
          startingPhase = 1;
        } else if (cleanMsg === "2" || cleanMsg.includes("FEW MONTHS") || cleanMsg.includes("ON AND OFF")) {
          experience = "intermediate";
          startingPhase = 2;
        } else if (cleanMsg === "3" || cleanMsg.includes("6 MONTHS") || cleanMsg.includes("CONSISTENTLY")) {
          experience = "advanced";
          startingPhase = 3;
        }

        const updatedUser = await storage.getUser(user.id);
        const weight = parseFloat((updatedUser?.currentWeight || user.currentWeight || "70") as string);
        const goalStr = (updatedUser?.goalType || user.goalType || "").toLowerCase();
        const actLevel = updatedUser?.activityLevel || user.activityLevel || "sedentary";

        const actMultipliers: Record<string, number> = {
          "sedentary": 1.2,
          "lightly active": 1.375,
          "moderately active": 1.55,
          "very active": 1.725,
          "extremely active": 1.9,
        };
        const multiplier = actMultipliers[actLevel] || 1.2;

        let calorieTarget: number;
        if (goalStr.includes("fat") || goalStr.includes("loss")) {
          calorieTarget = Math.max(1500, Math.round((weight * 22 - 500) * multiplier));
        } else if (goalStr.includes("recomp")) {
          calorieTarget = Math.round(weight * 24 * multiplier);
        } else if (goalStr.includes("muscle") || goalStr.includes("gain")) {
          calorieTarget = Math.round((weight * 22 + 300) * multiplier);
        } else {
          calorieTarget = Math.round(weight * 22 * multiplier);
        }
        const proteinTarget = Math.round((calorieTarget * 0.3) / 4);
        const phaseConfig = PHASE_CONFIG[startingPhase];

        if (experience === "intermediate" || experience === "advanced") {
          await storage.updateUser(user.id, {
            trainingExperience: experience,
            programmePhase: startingPhase,
            programmeWeek: 1,
            programmeDayInWeek: 1,
            calorieTarget,
            proteinTarget,
            stepsTarget: phaseConfig.stepTarget,
            onboardingState: "AWAITING_BASELINE",
          });
          reply = "Before I build your programme I want one week of real data. From today until Sunday send me your steps, food, water, and sleep daily. Do not change anything — just live normally. On Monday your full programme is ready.\n\nReply YES to do a baseline week or SKIP to start your programme today.";
        } else {
          await storage.updateUser(user.id, {
            trainingExperience: experience,
            programmePhase: startingPhase,
            programmeWeek: 1,
            programmeDayInWeek: 1,
            programmeStartDate: new Date(),
            calorieTarget,
            proteinTarget,
            stepsTarget: phaseConfig.stepTarget,
            onboardingState: "COMPLETED",
          });
          reply = buildOnboardingComplete(updatedUser || user, experience, calorieTarget, proteinTarget, phaseConfig, startingPhase);
        }
      } else if (currentState === "AWAITING_BASELINE") {
        if (cleanMsg === "YES" || cleanMsg === "Y") {
          await storage.updateUser(user.id, {
            baselineWeekActive: true,
            programmeStartDate: new Date(),
            onboardingState: "COMPLETED",
          });
          const userName = user.name || "coach";
          reply = `Baseline week started, ${userName}. From today until Sunday just live your normal life and log everything:\n\n- What you eat\n- Your steps\n- Your water\n- Your sleep\n\nDo not try to be perfect. I need your real data. On Monday your full personalised programme drops. Start by telling me what you ate today.`;
        } else if (cleanMsg === "SKIP" || cleanMsg === "NO" || cleanMsg === "N") {
          const updatedUser = await storage.getUser(user.id);
          const phaseNum = updatedUser?.programmePhase || user.programmePhase || 1;
          const phaseConfig = PHASE_CONFIG[phaseNum];
          await storage.updateUser(user.id, {
            baselineWeekActive: false,
            programmeStartDate: new Date(),
            onboardingState: "COMPLETED",
          });
          const calTarget = updatedUser?.calorieTarget || user.calorieTarget || 2000;
          const protTarget = updatedUser?.proteinTarget || user.proteinTarget || 150;
          reply = buildOnboardingComplete(updatedUser || user, updatedUser?.trainingExperience || "beginner", calTarget, protTarget, phaseConfig, phaseNum);
        } else {
          reply = "Reply YES to do a baseline week or SKIP to start your programme today.";
        }
      }

      if (reply) {
        await storage.logChat(user.id, message, reply, "ONBOARDING");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    // ── Priority 9.7: EMOTIONAL INTELLIGENCE ──
    const giveUpWords = ["GIVE UP", "GIVING UP", "CANT DO THIS", "NOT WORKING", "NO RESULTS", "WASTE OF MONEY", "USELESS"];
    if (giveUpWords.some(w => cleanMsg.includes(w))) {
      const reply = "I hear you. Results are not always visible on the scale — but they are happening. Tell me: are you sleeping? Are you moving? Are you eating protein? Answer those three and we fix this together.";
      await storage.logChat(user.id, message, reply, "EMOTIONAL_GIVEUP");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }
    const stressWords = ["STRESSED", "STRESS", "ANXIETY", "DEPRESSED", "SAD", "CANT COPE", "OVERWHELMED"];
    if (stressWords.some(w => cleanMsg.includes(w))) {
      const reply = "Your mental health matters more than any workout. Take today off if you need to — but do not disappear. Check in tomorrow. Even just a walk and water counts. I am here.";
      await storage.logChat(user.id, message, reply, "EMOTIONAL_STRESS");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.8: SUPPLEMENT GUIDANCE ──
    const suppWords = ["PROTEIN SHAKE", "PROTEIN POWDER", "CREATINE", "FAT BURNER", "PRE WORKOUT", "SUPPLEMENTS", "SUPPS"];
    if (suppWords.some(w => cleanMsg.includes(w))) {
      const reply = "Supplements are optional — food comes first. If your diet is clean and consistent, protein powder can help hit your daily target. Creatine is safe and effective for strength. Fat burners are mostly marketing — avoid them. Sort your food first, then we talk supplements.";
      await storage.logChat(user.id, message, reply, "SUPPLEMENT_ADVICE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.9: SA LIFE SCENARIO HANDLERS ──
    const funeralWords = ["FUNERAL", "UMNGCWABO", "BURIAL", "PASSED AWAY", "WE LOST", "MOURNING"];
    if (funeralWords.some(w => cleanMsg.includes(w))) {
      const reply = "Condolences on your loss. During this time do not stress about your programme. Eat what is available, stay hydrated, and come back when you are ready. We will be here.";
      await storage.logChat(user.id, message, reply, "FUNERAL_GRACE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    if (cleanMsg.includes("BRAAI")) {
      const reply = "Braai is life — here is how to navigate it. Load your plate with meat first — boerewors, chicken, chops. Skip the rolls. Limit pap to one fist. One beer maximum. Enjoy it and get back on track tomorrow morning.";
      await storage.logChat(user.id, message, reply, "BRAAI_STRATEGY");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    const brokeWords = ["NO MONEY", "BROKE", "MONTH END", "NO FOOD", "CANT AFFORD", "NO CASH"];
    if (brokeWords.some(w => cleanMsg.includes(w))) {
      const reply = "This is what you buy right now: 6 eggs R25, tin pilchards R12, sugar beans R20. That is R57 for 3 days of protein. Eggs for breakfast, beans for lunch, pilchards for dinner. Simple and effective.";
      await storage.logChat(user.id, message, reply, "MONTH_END_HUNGER");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    const tavernWords = ["TAVERN", "SHEBEEN"];
    if (tavernWords.some(w => cleanMsg.includes(w))) {
      const reply = "Tavern nights happen. If you are going — eat a full protein meal before you go. Limit to 2 drinks. Drink water between drinks. Get back on track tomorrow morning — not Monday.";
      await storage.logChat(user.id, message, reply, "TAVERN_CULTURE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    const churchWords = ["CHURCH", "SUNDAY LUNCH", "AFTER CHURCH"];
    if (churchWords.some(w => cleanMsg.includes(w))) {
      const reply = "Church lunch is a social reality. Fill half your plate with protein — chicken, meat. Take one small scoop of starchy sides. Enjoy the fellowship and log what you ate after.";
      await storage.logChat(user.id, message, reply, "CHURCH_SUNDAY");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    const holidayWords = ["DECEMBER", "HOLIDAYS", "VACATION", "ON HOLIDAY"];
    if (holidayWords.some(w => cleanMsg.includes(w))) {
      const reply = "Holiday mode does not mean stop. Walk every morning — 20 minutes minimum. Watch the alcohol. Eat protein at every meal. You will come back in January ahead of everyone else.";
      await storage.logChat(user.id, message, reply, "DECEMBER_HOLIDAY");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.91: BINGE EATING DETECTION ──
    const bingeWords = ["ATE EVERYTHING", "COULDNT STOP EATING", "ATE THE WHOLE", "LOST CONTROL", "ATE UNTIL SICK", "BINGED"];
    if (bingeWords.some(w => cleanMsg.includes(w))) {
      const reply = "What you are describing sounds like a binge episode. This is not about willpower — it is often triggered by restriction or stress. Do not punish yourself with less food tomorrow. Eat normally, add protein, and tell me what triggered it today.";
      await storage.logChat(user.id, message, reply, "BINGE_DETECTION");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.92: SCALE OBSESSION ──
    const weightMention = /\b\d{2,3}\s*(kg|kilos?)\b/i.test(message) || /^[\d.]+\s*kg$/i.test(message.trim());
    if (weightMention && user.awaitingInputType !== "weight") {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const weightLogs = await storage.getWeightLogs(user.id);
      const loggedToday = weightLogs.some(l => l.loggedAt && new Date(l.loggedAt) >= todayStart);
      if (loggedToday) {
        const reply = "You already logged your weight today. Weighing multiple times daily creates anxiety and gives false readings. Once per week same day same time is the standard. Step away from the scale.";
        await storage.logChat(user.id, message, reply, "SCALE_OBSESSION");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    // ── Priority 9.93: ALL OR NOTHING THINKING ──
    const allOrNothingWords = ["RUINED IT", "MESSED UP", "FAILED", "STARTING OVER", "STARTING MONDAY", "START FRESH MONDAY"];
    if (allOrNothingWords.some(w => cleanMsg.includes(w))) {
      const reply = "One bad meal does not ruin a week. One bad week does not ruin a month. Get back on track with your very next meal — not Monday. What are you eating in the next 2 hours?";
      await storage.logChat(user.id, message, reply, "ALL_OR_NOTHING");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.94: COMPARISON CLIENT ──
    const comparisonWords = ["MY FRIEND LOST", "EVERYONE ELSE", "WHY IS SHE LOSING", "LOSING FASTER THAN ME", "NOT LOSING AS FAST"];
    if (comparisonWords.some(w => cleanMsg.includes(w))) {
      const reply = "Stop comparing. Different bodies, different hormones, different histories. Your job is to beat last week's version of you — nobody else. What did you do better this week than last week?";
      await storage.logChat(user.id, message, reply, "COMPARISON_CLIENT");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.95: CHRONIC CONDITIONS ──
    if (cleanMsg.includes("PCOS") || cleanMsg.includes("POLYCYSTIC")) {
      const reply = "PCOS makes fat loss harder but not impossible. Key focus: reduce refined carbs significantly, prioritise strength training over cardio, manage stress and sleep aggressively. Weight loss will be slower — that is normal. Consistency over months is what works.";
      await storage.logChat(user.id, message, reply, "CHRONIC_PCOS");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    if (cleanMsg.includes("THYROID") || cleanMsg.includes("HYPOTHYROID") || cleanMsg.includes("HYPERTHYROID")) {
      const reply = "Thyroid conditions affect metabolism significantly. Get your medication sorted with your doctor first. From our side — focus on protein, manage portions strictly, and keep training consistently. Progress will be slower but it will come. Do not compare your speed to anyone else.";
      await storage.logChat(user.id, message, reply, "CHRONIC_THYROID");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.96: NIGHT SHIFT ──
    const nightShiftWords = ["NIGHT SHIFT", "NIGHTSHIFT", "WORK NIGHTS", "WORKING NIGHTS"];
    if (nightShiftWords.some(w => cleanMsg.includes(w))) {
      const reply = "Night shift changes everything. Your meal 1 is when you wake up — treat it like breakfast regardless of the time. Avoid heavy carbs before your shift. Sleep is your biggest challenge — protect it aggressively. Walk for 20 minutes after your shift before sleeping.";
      await storage.logChat(user.id, message, reply, "NIGHT_SHIFT");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.97: MENSTRUAL CYCLE AWARENESS ──
    const periodWords = ["PERIOD", "TIME OF MONTH", "PMS", "BLOATED", "WATER RETENTION"];
    if (periodWords.some(w => cleanMsg.includes(w))) {
      const reply = "Completely normal. Week 3 and 4 of your cycle causes water retention of up to 2kg. The scale will go up — ignore it. Stay on programme, reduce sodium, increase water. It will drop after your period. Do not panic.";
      await storage.logChat(user.id, message, reply, "MENSTRUAL_CYCLE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.971: FAMILY SABOTAGE ──
    const familySabotageWords = ["HUSBAND DOESNT SUPPORT", "HUSBAND DOESN'T SUPPORT", "FAMILY DOESNT SUPPORT", "FAMILY DOESN'T SUPPORT", "MY MOTHER COOKS", "MY WIFE COOKS", "THEY DONT UNDERSTAND", "THEY DON'T UNDERSTAND", "EATING ALONE", "NO ONE SUPPORTS ME"];
    if (familySabotageWords.some(w => cleanMsg.includes(w))) {
      const reply = "This is one of the hardest parts of the journey — changing when people around you aren't. You cannot control what they cook. You can control your portion. Eat your protein first, take smaller carb portions, and never explain yourself. Results will say everything words cannot.";
      await storage.logChat(user.id, message, reply, "FAMILY_SABOTAGE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.972: BODY IMAGE LANGUAGE ──
    const bodyImageWords = ["I HATE MY BODY", "IM SO FAT", "I'M SO FAT", "IM DISGUSTING", "I'M DISGUSTING", "IM UGLY", "I'M UGLY", "HATE MYSELF", "HATE HOW I LOOK"];
    if (bodyImageWords.some(w => cleanMsg.includes(w))) {
      const reply = "What you just said about yourself — would you say that to someone you love? Your body has carried you through everything. We are here to make it stronger, not to punish it. One kind thing you can do for your body today: feed it protein and take a 10 minute walk.";
      await storage.logChat(user.id, message, reply, "BODY_IMAGE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.973: SHAME SPIRAL ──
    const shameSpiralWords = ["ATE EVERYTHING THIS WEEKEND", "COMPLETELY FAILED", "SO ASHAMED", "DISGUSTED WITH MYSELF", "FELL OFF COMPLETELY", "RUINED EVERYTHING"];
    if (shameSpiralWords.some(w => cleanMsg.includes(w))) {
      const reply = "Shame does not burn calories and it does not build muscle. What happened this weekend stays this weekend. Right now — today — what is your next meal? Tell me and we fix it together. One meal at a time.";
      await storage.logChat(user.id, message, reply, "SHAME_SPIRAL");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.974: PLATEAU EMOTIONAL CRISIS ──
    const plateauWords = ["NOTHING IS WORKING", "BEEN CONSISTENT AND NOTHING", "DOING EVERYTHING RIGHT", "SO FRUSTRATED", "WANT TO GIVE UP"];
    if (plateauWords.some(w => cleanMsg.includes(w))) {
      const reply = "Six weeks of consistency and the scale not moving is one of the most demoralising things in fitness. But your body is changing even when the scale lies. Measurements, energy levels, how clothes fit — these tell the real story. Have you noticed any of these changing? Tell me.";
      await storage.logChat(user.id, message, reply, "PLATEAU_CRISIS");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.975: SCALE TRAUMA ──
    const scaleTraumaWords = ["I HAVE ALWAYS BEEN FAT", "BEEN OVERWEIGHT MY WHOLE LIFE", "TRIED EVERYTHING MY WHOLE LIFE", "DIETED MY WHOLE LIFE"];
    if (scaleTraumaWords.some(w => cleanMsg.includes(w))) {
      const reply = "A lifetime of dieting creates a complicated relationship with food and your body. We are not doing another diet. We are building a sustainable way of eating that you can maintain forever. No restriction. No punishment. Just structure, protein, and consistency. Different approach, different results.";
      await storage.logChat(user.id, message, reply, "SCALE_TRAUMA");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.976: COMMON COACHING QUESTIONS ──
    if (cleanMsg.includes("HOW LONG TO LOSE 10KG") || cleanMsg.includes("HOW LONG WILL IT TAKE")) {
      const reply = "Sustainable fat loss is 0.5 to 1kg per week. At that rate, 10kg takes 10 to 20 weeks. Anyone promising faster is selling you something. Slow and consistent means it stays off.";
      await storage.logChat(user.id, message, reply, "FAQ_WEIGHT_LOSS_TIME");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (cleanMsg.includes("LOSE WEIGHT WITHOUT EXERCISE") || cleanMsg.includes("WITHOUT EXERCISING")) {
      const reply = "Yes — but it is harder and you will lose muscle with fat. Exercise preserves muscle while you lose fat. Even 20 minutes of walking daily makes a significant difference. Start there.";
      await storage.logChat(user.id, message, reply, "FAQ_NO_EXERCISE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (cleanMsg.includes("EATING AFTER 6PM") || cleanMsg.includes("EATING AT NIGHT") || cleanMsg.includes("EAT AFTER 6")) {
      const reply = "The 6pm myth is exactly that — a myth. Total calories over the day is what matters, not timing. If your daily target is met, eating at 9pm changes nothing. Do not skip meals to avoid eating late.";
      await storage.logChat(user.id, message, reply, "FAQ_EATING_LATE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (cleanMsg.includes("LOSE BELLY FAT") || cleanMsg.includes("SPOT REDUCE") || cleanMsg.includes("STOMACH FAT")) {
      const reply = "You cannot choose where you lose fat — spot reduction is a myth. Overall fat loss through calorie deficit reduces belly fat over time. Core exercises build muscle under the fat but do not burn the fat itself. Deficit plus consistency is the only answer.";
      await storage.logChat(user.id, message, reply, "FAQ_BELLY_FAT");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (cleanMsg.includes("CARDIO OR WEIGHTS FIRST") || cleanMsg.includes("WEIGHTS OR CARDIO")) {
      const reply = "Weights first — always. You need full energy for resistance training. Cardio after weights. If fat loss is the goal, walking is your cardio. Save the intense cardio for after you have built some muscle.";
      await storage.logChat(user.id, message, reply, "FAQ_CARDIO_WEIGHTS");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (cleanMsg.includes("IS FASTING BETTER") || cleanMsg.includes("INTERMITTENT FASTING")) {
      const reply = "Fasting works if it helps you maintain your calorie deficit. It does not have magical metabolic benefits beyond that. If skipping breakfast makes you binge at lunch — it is not for you. If it helps you control portions — use it. The best diet is the one you can sustain.";
      await storage.logChat(user.id, message, reply, "FAQ_FASTING");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.977: RELIGIOUS FASTING ──
    const religiousFastWords = ["RAMADAN", "FASTING FOR RELIGION", "RELIGIOUS FAST", "LENT FASTING"];
    if (religiousFastWords.some(w => cleanMsg.includes(w))) {
      const reply = "Ramadan and religious fasting can absolutely work with your fitness goals. Break your fast with protein and water first — eggs, chicken, dates. Avoid bingeing at iftar. Keep training light during fasting hours — walking only. Suhoor must include protein and slow carbs to sustain you. This is manageable.";
      await storage.logChat(user.id, message, reply, "RELIGIOUS_FASTING");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.978: VEGETARIAN AND VEGAN ──
    const veganWords = ["VEGETARIAN", "VEGAN", "NO MEAT", "PLANT BASED", "DONT EAT MEAT", "DON'T EAT MEAT"];
    if (veganWords.some(w => cleanMsg.includes(w))) {
      const reply = "Vegetarian and vegan fat loss is absolutely possible. Your protein sources are: eggs and dairy if vegetarian, tofu, tempeh, lentils, chickpeas, beans, edamame, soy milk if vegan. You need to be more deliberate about hitting protein targets without meat. What does a typical day of eating look like for you?";
      await storage.logChat(user.id, message, reply, "VEGETARIAN_VEGAN");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.979: HALAAL ──
    const halaalWords = ["HALAAL", "HALAL", "NO PORK", "MUSLIM", "HALAAL ONLY"];
    if (halaalWords.some(w => cleanMsg.includes(w))) {
      const reply = "All our meal recommendations are halaal friendly. We never recommend pork or non-halaal meat. Stick to chicken, beef, lamb, fish and eggs. Your programme works fully within halaal dietary requirements.";
      await storage.logChat(user.id, message, reply, "HALAAL");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.980: WHEELCHAIR AND SEVERE MOBILITY ──
    const wheelchairWords = ["WHEELCHAIR", "CANT WALK", "CANNOT WALK", "DISABLED", "PARALYSED", "PARALYZED"];
    if (wheelchairWords.some(w => cleanMsg.includes(w))) {
      const reply = "Your programme is fully adaptable. Upper body resistance training is highly effective for fat loss and strength. Seated exercises: chair push ups, seated dumbbell press, seated rows with resistance band, wheelchair push intervals. Food and calorie control becomes even more important. Let us build around what you can do.";
      await storage.logChat(user.id, message, reply, "WHEELCHAIR_MOBILITY");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.981: MORBIDLY OBESE MODIFICATIONS ──
    const obeseWords = ["VERY OVERWEIGHT", "MORBIDLY OBESE", "OVER 150KG", "OVER 130KG", "CANT GET OFF FLOOR", "KNEES CANT HANDLE"];
    if (obeseWords.some(w => cleanMsg.includes(w))) {
      const reply = "We start where you are — not where you think you should be. No floor exercises. No jumping. No high impact. Your programme is: seated exercises, wall push ups, chair squats, and walking — even 5 minutes to start. Food is 80% of your results at this stage. Protein at every meal. Small consistent steps. That is the plan.";
      await storage.logChat(user.id, message, reply, "MORBID_OBESITY");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.982: CULTURAL FOOD IDENTITY ──
    const culturalFoodWords = ["PAP IS OUR CULTURE", "CANT STOP EATING PAP", "ITS OUR TRADITION", "MY CULTURE", "TRADITIONAL FOOD", "GRANDMOTHER COOKS"];
    if (culturalFoodWords.some(w => cleanMsg.includes(w))) {
      const reply = "Pap is not the enemy — portions are. One fist of pap per meal fits into any fat loss plan. You do not have to abandon your culture to reach your goals. Eat your cultural foods in controlled portions with a strong protein source alongside. That is sustainable. That is real life.";
      await storage.logChat(user.id, message, reply, "CULTURAL_FOOD");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.983: STROKE AND LIMITED MOBILITY ──
    const strokeWords = ["HAD A STROKE", "STROKE", "ONE SIDE WEAK", "HEMIPLEGIA"];
    if (strokeWords.some(w => cleanMsg.includes(w))) {
      const reply = "Post stroke training requires care and patience. Focus on what the stronger side can do while gently working the affected side. Walking with support, seated exercises, resistance bands. Always train with doctor clearance after a stroke. We adapt everything to where you are today.";
      await storage.logChat(user.id, message, reply, "STROKE_MOBILITY");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.984: FLAT WITH NO OUTDOOR ACCESS ──
    const noSpaceWords = ["NO SPACE", "LIVE IN A FLAT", "NO GARDEN", "CANT GO OUTSIDE", "NO OUTDOOR ACCESS", "LOAD SHEDDING CANT TRAIN"];
    if (noSpaceWords.some(w => cleanMsg.includes(w))) {
      const reply = "No space is not an excuse — it is a challenge we solve. Your entire workout fits in 2 square metres: squats, push ups, lunges, plank, wall sit, mountain climbers. No equipment. No excuses. 20 minutes in your flat is enough to maintain progress.";
      await storage.logChat(user.id, message, reply, "NO_SPACE_FLAT");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.985: STEROID AND MEDICATION WEIGHT GAIN ──
    const medWeightWords = ["ON STEROIDS", "MEDICATION WEIGHT", "PILL WEIGHT", "ANTIDEPRESSANTS WEIGHT", "CORTISONE WEIGHT GAIN"];
    if (medWeightWords.some(w => cleanMsg.includes(w))) {
      const reply = "Medication induced weight gain is real and frustrating. It is not your fault and it does not mean fat loss is impossible. It means you have to be more consistent and patient than the average person. Do not stop medication for weight loss reasons — ever. Work with your doctor and work with us simultaneously.";
      await storage.logChat(user.id, message, reply, "MEDICATION_WEIGHT");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.986: LOADSHEDDING GRACE MODE ──
    const loadsheddingWords = ["LOAD SHEDDING", "LOADSHEDDING", "NO ELECTRICITY", "ESKOM"];
    if (loadsheddingWords.some(w => cleanMsg.includes(w))) {
      const reply = "Load shedding is SA life. If it disrupted your workout or meal prep — noted. Cold food still counts. Walking outside during load shedding counts. Do not use it as a reason to skip entirely. Adapt and keep moving.";
      await storage.logChat(user.id, message, reply, "LOADSHEDDING_GRACE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.987: POSTPARTUM ──
    const postpartumWords = ["JUST HAD A BABY", "POSTPARTUM", "POST NATAL", "AFTER BIRTH", "C SECTION", "CAESAREAN"];
    if (postpartumWords.some(w => cleanMsg.includes(w))) {
      const reply = "Congratulations. Your body just did something extraordinary. No crunches, no sit ups, no heavy lifting until cleared by your doctor — especially after C-section. Start with walking, pelvic floor exercises, and deep breathing. Food is your priority right now — high protein, no restriction. We build slowly and safely.";
      await storage.logChat(user.id, message, reply, "POSTPARTUM");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.988: DOMESTIC WORKER FOOD SITUATION ──
    const domesticWorkerWords = ["DOMESTIC WORKER", "WORK IN A HOUSE", "EMPLOYERS FOOD", "MADAM FOOD", "EAT THEIR LEFTOVERS", "EAT WHAT THEY GIVE ME"];
    if (domesticWorkerWords.some(w => cleanMsg.includes(w))) {
      const reply = "This is a real challenge many face. Prioritise protein from whatever is available — eggs, chicken, meat. Avoid finishing everything on the plate out of obligation. Eat slowly, stop at 80% full. If you can bring your own food — tinned pilchards and eggs are affordable and powerful. You have more control than you think.";
      await storage.logChat(user.id, message, reply, "DOMESTIC_WORKER");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.989: CANCER TREATMENT ──
    const cancerWords = ["CHEMOTHERAPY", "CHEMO", "CANCER TREATMENT", "RADIATION TREATMENT", "ONCOLOGY"];
    if (cancerWords.some(w => cleanMsg.includes(w))) {
      const reply = "Your health and treatment come first — always. Do not focus on fat loss during active treatment. Focus on eating enough protein to maintain muscle, staying hydrated, and gentle walking when energy allows. Please work closely with your oncologist. We are here to support you gently through this.";
      await storage.logChat(user.id, message, reply, "CANCER_TREATMENT");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.990: ARV MEDICATION ──
    const arvWords = ["ARVS", "ANTIRETROVIRAL", "HIV MEDICATION", "ON TREATMENT"];
    if (arvWords.some(w => cleanMsg.includes(w))) {
      const reply = "ARV medication affects appetite and metabolism for many people. This is manageable. Focus on protein at every meal to maintain muscle, stay hydrated, and be consistent with movement. Your programme works alongside your treatment. No judgment here — only support.";
      await storage.logChat(user.id, message, reply, "ARV_MEDICATION");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.991: PRISON RELEASE ──
    const prisonWords = ["JUST GOT OUT", "RELEASED FROM PRISON", "OUT OF JAIL", "EX CONVICT", "FRESH OUT"];
    if (prisonWords.some(w => cleanMsg.includes(w))) {
      const reply = "Welcome back. This is one of the best decisions you can make right now. Structure, discipline, and physical health will anchor everything else you are rebuilding. We start simple — walking daily, protein at every meal, sleep consistently. You have already done hard things. This is the good kind of hard.";
      await storage.logChat(user.id, message, reply, "PRISON_RELEASE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.992: TEENAGER EATING DISORDER SIGNS ──
    const edWords = ["NOT EATING AT ALL", "EATING NOTHING", "ONLY EATING 500", "ONLY EATING 300", "SCARED TO EAT", "AFRAID OF FOOD", "CANNOT EAT", "PURGING", "MAKING MYSELF SICK"];
    if (edWords.some(w => cleanMsg.includes(w))) {
      const reply = "What you are describing concerns me deeply. This is not about willpower or discipline — this needs proper support. Please speak to a trusted adult, a parent, a school counsellor, or call SADAG on 0800 567 567. You deserve real help, not a fitness programme right now.";
      await storage.logChat(user.id, message, reply, "EATING_DISORDER_FLAG");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 9.993: 12 HOUR SHIFT WORKERS ──
    const shiftWords = ["12 HOUR SHIFT", "TWELVE HOUR SHIFT", "LONG SHIFT", "DOUBLE SHIFT"];
    if (shiftWords.some(w => cleanMsg.includes(w))) {
      const reply = "Long shifts make meal timing hard. Pack these before your shift: boiled eggs, tinned fish, an apple, nuts if affordable. Eat every 4-5 hours even if just a small protein snack. Do not arrive home starving — that is when bad choices happen. Prep the night before.";
      await storage.logChat(user.id, message, reply, "LONG_SHIFT");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 10: INTENT ROUTING ──
    let detectedIntent: string | null = null;

    if (cleanMsg === "1") detectedIntent = "GET_WORKOUT";
    if (cleanMsg === "2") {
      await storage.updateUser(user.id, { awaitingInputType: "food" });
      return res.type('text/xml').send(`<Response><Message>${R.promptFood()}</Message></Response>`);
    }
    if (cleanMsg === "3") {
      await storage.updateUser(user.id, { awaitingInputType: "steps" });
      return res.type('text/xml').send(`<Response><Message>${R.promptSteps()}</Message></Response>`);
    }
    if (cleanMsg === "4") {
      await storage.updateUser(user.id, { awaitingInputType: "sleep" });
      return res.type('text/xml').send(`<Response><Message>${R.promptSleep()}</Message></Response>`);
    }
    if (cleanMsg === "5") {
      await storage.updateUser(user.id, { awaitingInputType: "weight" });
      return res.type('text/xml').send(`<Response><Message>${R.promptWeight()}</Message></Response>`);
    }
    if (cleanMsg === "6") detectedIntent = "SHOW_TARGETS";
    if (cleanMsg === "7") {
      await storage.updateUser(user.id, { onboardingState: "AWAITING_GOAL", awaitingInputType: null, primaryFocusArea: null });
      const reply = "Let's update your profile. What is your main goal?\n1) Lose fat\n2) Build muscle\n3) Body recomposition — lose fat and gain muscle simultaneously\n4) General fitness and health";
      await storage.logChat(user.id, message, reply, "PROFILE_UPDATE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    if (!detectedIntent) {
      const parsing = parseFoodMessage(message);
      const foodEvidence = parsing.proteinItems.length > 0 ||
                          parsing.carbItems.length > 0 ||
                          parsing.junkItems.length > 0 ||
                          parsing.drinks.length > 0 ||
                          parsing.mealHints.length > 0 ||
                          parsing.quantities.length > 0;

      if (/^(GYM DONE|WORKOUT DONE|DONE GYM|TRAINING DONE|SESSION DONE)$/.test(cleanMsg) || cleanMsg === "DONE") detectedIntent = "WORKOUT_DONE";
      else if (cleanMsg.startsWith("SWAP") || /SWAP THIS|DIFFERENT EXERCISE|CANT DO THIS EXERCISE|ALTERNATIVE EXERCISE|SUBSTITUTE/.test(cleanMsg)) detectedIntent = "EXERCISE_SWAP";
      else if (/NO EQUIPMENT|NO GYM TODAY|AT HOME TODAY|CANT MAKE GYM|SKIPPING GYM/.test(cleanMsg)) detectedIntent = "NO_EQUIPMENT";
      else if (cleanMsg === "HISTORY") detectedIntent = "WORKOUT_HISTORY";
      else if (cleanMsg === "PHASE") detectedIntent = "PHASE_PROGRESS";
      else if (cleanMsg === "REPEAT WEEK") detectedIntent = "REPEAT_WEEK";
      else if (cleanMsg === "READY") detectedIntent = "PHASE_READY";
      else if (cleanMsg === "REPEAT") detectedIntent = "PHASE_REPEAT";
      else if (cleanMsg === "SHARECARD" || /SHARE MY PROGRESS|SHARE CARD|PROGRESS CARD/.test(cleanMsg)) detectedIntent = "SHARECARD";
      else if (/^NUTRITION$|^FOOD PLAN$|^MEAL PLAN$|^DIET$|^EATING PLAN$/.test(cleanMsg)) detectedIntent = "NUTRITION_PLAN";
      else if (/GYM|WORKOUT|PROGRAM|TRAINING/.test(cleanMsg)) detectedIntent = "GET_WORKOUT";
      else if (/STEPS|WALK|NO STEPS/.test(cleanMsg)) detectedIntent = "LOG_STEPS";
      else if (/FOOD|MEAL|ATE|PAP|CHICKEN|OATS|BREAD/.test(cleanMsg) && foodEvidence) detectedIntent = "LOG_FOOD_INFORMAL";
      else if (/SLEEP|SLEPT/.test(cleanMsg)) detectedIntent = "LOG_SLEEP";
      else if (/WEIGHT|KG/.test(cleanMsg)) detectedIntent = "LOG_WEIGHT";
      else if (/TARGETS|MACROS|CALORIES/.test(cleanMsg)) detectedIntent = "SHOW_TARGETS";
      else if (/^(ATE |HAD |JUST ATE|EATING NOW|EATING |I ATE )/.test(cleanMsg)) detectedIntent = "LOG_FOOD_INFORMAL";
      else if (foodEvidence) detectedIntent = "LOG_FOOD_INFORMAL";

      if (/WHAT CAN I EAT|FOOD SUGGESTIONS|MEAL IDEAS/.test(cleanMsg)) {
        const advice = "For fat loss, focus on high-protein and fibre: \n- Oats or Eggs for breakfast\n- Grilled chicken or tinned fish with veg for lunch/dinner\n- Limit pap/rice to one fist size per meal.\nWhat are you planning to eat next?";
        await storage.logChat(user.id, message, advice, "FOOD_ADVICE");
        return res.type('text/xml').send(`<Response><Message>${advice}</Message></Response>`);
      }
    }

    console.log("INTENT:", detectedIntent);

    // ── Priority 11: INTENT HANDLERS ──

    if (detectedIntent === "LOG_FOOD" || detectedIntent === "LOG_FOOD_INFORMAL") {
      const nothingWords = ["NOTHING", "DIDNT EAT", "SKIPPED", "NO FOOD", "NONE"];
      if (nothingWords.some(w => cleanMsg.includes(w))) {
        const reply = "Skipping meals slows fat loss and triggers cravings. Get 2 eggs or a tin of fish in now. Reply DONE after eating.";
        await storage.logChat(user.id, message, reply, "FOOD_SKIPPED");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }

      const fullCtx = await buildUserContext(user);
      const { reply: coachReply, nextState } = await getKamLifeFoodReply(message, user.calorieTarget || 2000, fullCtx, user.name || "there");

      if (detectedIntent === "LOG_FOOD_INFORMAL") {
        const foodPattern = await checkFoodPatterns(user.id);
        const perfectDay = await checkPerfectDay(user);
        const full = `${coachReply}${foodPattern}${perfectDay}`;
        await storage.logChat(user.id, message, full, "LOG_FOOD");
        return res.type('text/xml').send(`<Response><Message>${full}</Message></Response>`);
      }

      if (nextState === "portion") {
        await storage.updateUser(user.id, { awaitingInputType: "portion" });
        const full = `${coachReply}\nPortion check: 1 / 2 / 3+ fists?`;
        await storage.logChat(user.id, message, full, "PORTION_CHECK");
        return res.type('text/xml').send(`<Response><Message>${full}</Message></Response>`);
      }

      await storage.updateUser(user.id, { awaitingInputType: "drink" });
      const full = `${coachReply} What did you drink?`;
      await storage.logChat(user.id, message, full, "LOG_FOOD");
      return res.type('text/xml').send(`<Response><Message>${full}</Message></Response>`);
    }

    if (detectedIntent === "GET_WORKOUT") {
      let stalePrefix = "";
      if (user.lastWorkoutDate) {
        const daysSinceWorkout = Math.floor((Date.now() - new Date(user.lastWorkoutDate).getTime()) / (1000 * 60 * 60 * 24));
        if (daysSinceWorkout > 7) {
          const phase = user.programmePhase || 1;
          const phaseConfig = PHASE_CONFIG[phase] || PHASE_CONFIG[1];
          const day = user.programDayIndex || 1;
          stalePrefix = `Welcome back. You have been away for ${daysSinceWorkout} days. We are not going backwards — pick up exactly where you left off. Day ${day} of Phase ${phase}: ${phaseConfig.name}. Here is today's session:\n\n`;
        }
      }

      const { exercises, isRestDay } = getExercisesForDay(user);
      const workoutMsg = stalePrefix + formatWorkoutMessage(user, exercises, isRestDay);

      if (!isRestDay && exercises.length > 0) {
        try {
          const ctx = await buildUserContext(user);
          const motivationCompletion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            max_tokens: 60,
            messages: [
              { role: "system", content: `${KAMLIFE_MASTER_PROMPT}\n\nCONTEXT:\n${ctx}\n\nWrite ONE short motivational sentence (max 15 words) specific to this user — their age, goal, phase, and conditions. No generic motivation. Be direct and personal.` },
              { role: "user", content: "Give me one motivational line for today's workout." },
            ],
          });
          const motivation = motivationCompletion.choices[0]?.message?.content?.trim();
          if (motivation) {
            const reply = workoutMsg.replace("Reply DONE when finished.", `${motivation}\n\nReply DONE when finished.`);
            await storage.logChat(user.id, message, reply, "GET_WORKOUT");
            return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
          }
        } catch (e) {
          console.error("[GET_WORKOUT] GPT motivation failed:", e);
        }
      }

      await storage.logChat(user.id, message, workoutMsg, "GET_WORKOUT");
      return res.type('text/xml').send(`<Response><Message>${workoutMsg}</Message></Response>`);
    }

    // ── EXERCISE SWAP ──
    if (detectedIntent === "EXERCISE_SWAP") {
      const swapChoice = cleanMsg.match(/^SWAP\s*(\d)$/);
      if (swapChoice) {
        const choiceNum = parseInt(swapChoice[1]);
        if (choiceNum >= 1 && choiceNum <= 3) {
          const reply = `Swap ${choiceNum} selected. Use that exercise for today's session. Reply DONE when finished.`;
          await storage.logChat(user.id, message, reply, "EXERCISE_SWAP");
          return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
        }
      }

      const mode = getModeKey((user.trainingMode as string) || "home");
      const { exercises: currentExercises } = getExercisesForDay(user);
      const currentIds = new Set(currentExercises.map(e => e.id));
      const currentMuscleGroups = new Set(currentExercises.map(e => e.muscleGroup));

      const lib = mode === "gym" ? EXERCISE_LIBRARY.gym : EXERCISE_LIBRARY.home;
      const allEntries: ExerciseEntry[] = [...lib.push, ...lib.pull, ...lib.legs, ...lib.core];
      const filtered = filterEntriesForInjuries(allEntries, user);
      const sameGroupAlts = filtered.filter(e => !currentIds.has(e.id) && currentMuscleGroups.has(e.muscleGroup));
      let pool = [...sameGroupAlts];
      if (pool.length < 3) {
        const others = filtered.filter(e => !currentIds.has(e.id) && !pool.some(p => p.id === e.id));
        pool.push(...others);
      }
      const picked = pool.slice(0, 3);

      if (picked.length === 0) {
        const reply = "No alternative exercises available for your current setup. Try a different training mode or speak to Coach.";
        await storage.logChat(user.id, message, reply, "EXERCISE_SWAP");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }

      let reply = "Here are alternatives for today:\n";
      picked.forEach((ex: ExerciseEntry, i: number) => {
        reply += `${i + 1}) ${ex.name} — ${ex.plainEnglish}\n`;
      });
      reply += "\nReply SWAP 1, SWAP 2, or SWAP 3 to choose.";
      await storage.logChat(user.id, message, reply, "EXERCISE_SWAP");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── NO EQUIPMENT FALLBACK ──
    if (detectedIntent === "NO_EQUIPMENT") {
      const userMode = getModeKey((user.trainingMode as string) || "home");
      if (userMode !== "gym") {
        const reply = "You are already training at home. Reply WORKOUT to get today's session.";
        await storage.logChat(user.id, message, reply, "NO_EQUIPMENT");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
      const tempUser = { ...user, trainingMode: "home" };
      const { exercises: homeExercises } = getExercisesForDay(tempUser);
      const phase = user.programmePhase || 1;
      const workoutMsg = formatWorkoutMessage(tempUser, homeExercises, false);
      const reply = `No gym today — no problem. Here is your home session for Phase ${phase}:\n\n${workoutMsg}`;
      await storage.logChat(user.id, message, reply, "NO_EQUIPMENT");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── WORKOUT HISTORY ──
    if (detectedIntent === "WORKOUT_HISTORY") {
      const logs = await storage.getWorkoutLogs(user.id);
      const last7 = logs.slice(0, 7);
      const completedCount = last7.filter(l => l.workoutCompleted).length;
      const phase = user.programmePhase || 1;
      const phaseConfig = PHASE_CONFIG[phase] || PHASE_CONFIG[1];
      let reply = `${user.name || "Coach"} — Last 7 workouts:\n`;
      if (last7.length === 0) {
        reply += "No workouts logged yet. Reply WORKOUT to get started.\n";
      } else {
        for (let idx = 0; idx < last7.length; idx++) {
          const log = last7[idx];
          const dateStr = log.loggedAt ? format(new Date(log.loggedAt), "dd MMM") : "Unknown";
          const status = log.workoutCompleted ? "DONE" : "SKIPPED";
          const dayNum = (user.programDayIndex || 1) - idx;
          const desc = `Phase ${phase}: ${phaseConfig.name} Day ${Math.max(1, dayNum)}`;
          reply += `${dateStr}: ${desc} — ${status}\n`;
        }
        reply += `\nCompleted ${completedCount} of last ${last7.length} days. `;
        if (completedCount >= 6) reply += "Elite consistency. You are in the top 5% of clients.";
        else if (completedCount >= 4) reply += "Solid effort. Push for 5+ next week.";
        else if (completedCount >= 2) reply += "Room to improve. Consistency is what separates results from excuses.";
        else reply += "We need more from you. Show up. The programme only works if you do.";
      }
      await storage.logChat(user.id, message, reply, "WORKOUT_HISTORY");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── PHASE PROGRESS ──
    if (detectedIntent === "PHASE_PROGRESS") {
      const phase = user.programmePhase || 1;
      const phaseConfig = PHASE_CONFIG[phase] || PHASE_CONFIG[1];
      const week = user.programmeWeek || 1;
      const totalWeeks = phaseConfig.weeks;
      const daysRemaining = (totalWeeks - week) * 7 + (7 - (user.programmeDayInWeek || 1));
      const nextPhase = phase === 4 ? 5 : phase === 5 ? 2 : phase + 1;
      const nextPhaseConfig = PHASE_CONFIG[nextPhase] || PHASE_CONFIG[1];

      const daysIntoPhase = ((week - 1) * 7) + (user.programmeDayInWeek || 1);
      const phaseStartDate = new Date(Date.now() - daysIntoPhase * 24 * 60 * 60 * 1000);

      const allWorkoutLogs = await storage.getWorkoutLogs(user.id);
      const workoutsThisPhase = allWorkoutLogs.filter(l => l.workoutCompleted && l.loggedAt && new Date(l.loggedAt) >= phaseStartDate).length;

      const allStepLogs = await storage.getStepLogs(user.id);
      const phaseSteps = allStepLogs.filter(l => l.loggedAt && new Date(l.loggedAt) >= phaseStartDate);
      const avgSteps = phaseSteps.length > 0 ? Math.round(phaseSteps.reduce((sum, l) => sum + l.steps, 0) / phaseSteps.length) : 0;

      let motiveLine = "";
      if (week <= 1) motiveLine = "You are just getting started. Build momentum this week.";
      else if (week >= totalWeeks) motiveLine = "Final week of this phase. Finish strong and earn the next one.";
      else motiveLine = "You are in the middle of the work. This is where results are built.";

      const reply = `Phase ${phase}: ${phaseConfig.name}\nWeek ${week} of ${totalWeeks}\n${daysRemaining} days until Phase ${nextPhase}: ${nextPhaseConfig.name}\nWorkouts this phase: ${workoutsThisPhase}\nStep average this phase: ${avgSteps.toLocaleString()}\n\n${motiveLine}`;
      await storage.logChat(user.id, message, reply, "PHASE_PROGRESS");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── REPEAT WEEK ──
    if (detectedIntent === "REPEAT_WEEK") {
      const week = user.programmeWeek || 1;
      const phase = user.programmePhase || 1;
      const nextPhase = phase === 4 ? 5 : phase === 5 ? 2 : phase + 1;
      const newProgramDayIndex = Math.max(1, (user.programDayIndex || 1) - 7);
      await storage.updateUser(user.id, {
        programmeDayInWeek: 1,
        programDayIndex: newProgramDayIndex,
      });
      const reply = `Week ${week} reset. Sometimes you need to own a week before moving forward. Show up every day this week and earn Phase ${nextPhase} properly.`;
      await storage.logChat(user.id, message, reply, "REPEAT_WEEK");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── PHASE READY (advance) ──
    if (detectedIntent === "PHASE_READY") {
      if (!user.phaseReadyToAdvance) {
        const reply = "You are not at a phase transition point. Keep going with your current phase. Reply WORKOUT to get today's session.";
        await storage.logChat(user.id, message, reply, "PHASE_READY");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
      const phase = user.programmePhase || 1;
      let nextPhase = phase;
      if (phase === 4) nextPhase = 5;
      else if (phase === 5) nextPhase = 2;
      else if (phase < 4) nextPhase = phase + 1;
      const nextConfig = PHASE_CONFIG[nextPhase] || PHASE_CONFIG[1];
      await storage.updateUser(user.id, {
        programmePhase: nextPhase,
        programmeWeek: 1,
        programmeDayInWeek: 1,
        phaseReadyToAdvance: false,
      });
      const reply = `Phase ${nextPhase}: ${nextConfig.name} starts now. ${nextConfig.theme}. New step target: ${nextConfig.stepTarget.toLocaleString()} per day. New workout frequency: ${nextConfig.weeklyWorkouts} per week. You earned this. Show up.`;
      await storage.logChat(user.id, message, reply, "PHASE_READY");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── PHASE REPEAT (stay same phase) ──
    if (detectedIntent === "PHASE_REPEAT") {
      if (!user.phaseReadyToAdvance) {
        const reply = "You are not at a phase transition point. Reply REPEAT WEEK if you want to redo this week.";
        await storage.logChat(user.id, message, reply, "PHASE_REPEAT");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
      const phase = user.programmePhase || 1;
      const phaseConfig = PHASE_CONFIG[phase] || PHASE_CONFIG[1];
      await storage.updateUser(user.id, {
        programmeWeek: 1,
        programmeDayInWeek: 1,
        phaseReadyToAdvance: false,
      });
      const reply = `Phase ${phase} reset. Smart decision. Owning a phase before advancing is what separates serious people from everyone else. Start Week 1 again — this time leave nothing on the table.`;
      await storage.logChat(user.id, message, reply, "PHASE_REPEAT");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── SHARECARD ──
    if (detectedIntent === "SHARECARD") {
      const sharecard = await buildSharecard(user);
      const reply = `${sharecard}\n\nScreenshot this and share it. Every person you inspire is proof the work is real.`;
      await storage.logChat(user.id, message, reply, "SHARECARD");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── NUTRITION PLAN ──
    if (detectedIntent === "NUTRITION_PLAN") {
      const phase = user.programmePhase || 1;
      const nutrition = NUTRITION_BY_PHASE[phase] || NUTRITION_BY_PHASE[1];
      const calories = user.calorieTarget || 2000;
      const protein = Math.round(calories / 8);
      const trainingDayCarbs = phase <= 2 ? "moderate — rice, pap or bread with meals around training" : phase <= 4 ? "high — carbs at every training-day meal for fuel" : "reduced — lighter carbs this week";
      const reply = `Phase ${phase} Nutrition — ${nutrition.name}\n\nFocus: ${nutrition.focus}\nCarb timing: ${nutrition.carbTiming}\nThis week's habit: ${nutrition.keyHabit}\nWeekly target: ${nutrition.weeklyTarget}\n\nYour daily targets:\nCalories: ${calories}kcal\nProtein: ${protein}g\nCarbs: ${trainingDayCarbs}`;
      await storage.logChat(user.id, message, reply, "NUTRITION_PLAN");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    if (detectedIntent === "LOG_STEPS") {
      const kMatchIntent = cleanMsg.match(/(\d+(\.\d+)?)\s*K\b/);
      let steps: number | null = null;
      if (kMatchIntent) {
        steps = Math.round(parseFloat(kMatchIntent[1]) * 1000);
      } else {
        const stepsMatch = cleanMsg.match(/\d+/);
        steps = stepsMatch ? parseInt(stepsMatch[0]) : (cleanMsg.includes("NO STEPS") ? 0 : null);
      }

      if (steps !== null) {
        await storage.createStepLog(user.id, steps);
        const prevLogs = await storage.getStepLogs(user.id);
        const yesterdaySteps = prevLogs.length > 1 ? prevLogs[1].steps : null;

        let reaction = "";
        if (steps < 2000) reaction = R.stepsLow();
        else if (steps >= (user.stepsTarget || 8000)) reaction = R.stepsTarget();
        else reaction = R.stepsGood();

        const comparison = yesterdaySteps !== null ? `\nYesterday: ${yesterdaySteps} steps. Today: ${steps}.` : "";
        let winMoment = "";
        const target = user.stepsTarget || 8000;
        if (prevLogs.length >= 7) {
          const now = new Date();
          let streakValid = true;
          for (let i = 0; i < 7; i++) {
            const log = prevLogs[i];
            if (!log.loggedAt || log.steps < target) { streakValid = false; break; }
            const logDate = new Date(log.loggedAt);
            const expectedDate = new Date(now);
            expectedDate.setDate(expectedDate.getDate() - i);
            if (logDate.toDateString() !== expectedDate.toDateString()) { streakValid = false; break; }
          }
          if (streakValid) {
            winMoment = "\n\n7 days straight hitting your target. That is elite discipline. Screenshot this.";
          }
        }
        const streak = await getConsistencyStreak(user.id);
        const streakMsg = getStreakMessage(streak);
        const perfectDay = await checkPerfectDay(user);
        const reply = `${reaction}${comparison}${winMoment}${streakMsg}${perfectDay}`;
        await storage.logChat(user.id, message, reply, "LOG_STEPS");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    if (detectedIntent === "LOG_SLEEP") {
      const sleepMatch = cleanMsg.match(/\d+/);
      const hours = sleepMatch ? parseInt(sleepMatch[0]) : null;
      if (hours !== null) {
        let reaction = "";
        if (hours < 5) reaction = R.sleepPoor();
        else if (hours < 7) reaction = R.sleepOk();
        else reaction = R.sleepGood();
        await storage.logChat(user.id, message, reaction, "LOG_SLEEP");
        return res.type('text/xml').send(`<Response><Message>${reaction}</Message></Response>`);
      }
    }

    if (detectedIntent === "LOG_WEIGHT") {
      const weightMatch = cleanMsg.match(/\d+(\.\d+)?/);
      if (weightMatch) {
        const val = weightMatch[0];
        await storage.createWeightLog(user.id, val);
        await storage.updateUser(user.id, { currentWeight: val });
        let reply = R.weightLogged(val);
        const allWeights = await storage.getWeightLogs(user.id);
        const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
        const baseline = allWeights
          .filter(w => w.loggedAt && (Date.now() - new Date(w.loggedAt).getTime()) >= fourteenDaysMs)
          .sort((a, b) => new Date(b.loggedAt!).getTime() - new Date(a.loggedAt!).getTime())[0];
        if (baseline && (parseFloat(baseline.weight) - parseFloat(val)) >= 2) {
          reply += "\n\nDown 2kg+ in the last 2 weeks. That is the work paying off. Screenshot this and share it.";
        }
        const wStreak = await getConsistencyStreak(user.id);
        reply += getStreakMessage(wStreak);
        await storage.logChat(user.id, message, reply, "LOG_WEIGHT");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    if (detectedIntent === "SHOW_TARGETS") {
      const reply = R.targets(user.calorieTarget || 2000, user.proteinTarget || 150, user.stepsTarget || 8000);
      await storage.logChat(user.id, message, reply, "SHOW_TARGETS");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    if (detectedIntent === "WORKOUT_DONE") {
      await storage.createWorkoutLog(user.id, true);
      const { phaseTransitionMsg, newPhase, newWeek } = await advanceProgram(user);
      const woStreak = await getConsistencyStreak(user.id);
      const phaseConfig = PHASE_CONFIG[newPhase] || PHASE_CONFIG[1];
      let reply = `${R.workoutDone()} Phase ${newPhase}: ${phaseConfig.name}, Week ${newWeek}.${getStreakMessage(woStreak)}`;
      reply += `\n\n${getPostWorkoutNutrition(newPhase)}`;
      if (phaseTransitionMsg) {
        reply += `\n\n${phaseTransitionMsg}`;
      }
      const milestone = getMilestoneMessage(user);
      if (milestone) {
        reply += `\n\n${milestone}`;
      }
      const perfectDay = await checkPerfectDay(user);
      reply += perfectDay;
      await storage.logChat(user.id, message, reply, "WORKOUT_DONE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 12: INTELLIGENT FALLBACK ──
    const fallbackCtx = await buildUserContext(user);
    const { reply } = await getKamLifeFoodReply(
      message,
      user.calorieTarget || 2000,
      fallbackCtx,
      user.name || "there"
    );
    await storage.logChat(user.id, message, reply, "INTELLIGENT_FALLBACK");
    return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
  });

  // ============================================================
  // API Routes
  // ============================================================
  app.get(api.users.list.path, async (req, res) => {
    const users = await storage.getAllUsers();
    res.json(users);
  });

  app.get(api.users.flagged.path, async (req, res) => {
    const flagged = await storage.getFlaggedUsers();
    res.json(flagged);
  });

  app.get(api.users.betaTesters.path, async (req, res) => {
    const allUsers = await storage.getAllUsers();
    const betaTesters = allUsers.filter(u => u.betaBypassUntil !== null);
    res.json(betaTesters);
  });

  app.post("/functions/v1/admin-actions", async (req, res) => {
    const { action } = req.query;
    
    if (action === "trigger_daily") {
      const globalOutboundPaused = process.env.GLOBAL_OUTBOUND_PAUSED === "true";
      if (globalOutboundPaused) {
        return res.status(403).json({ success: false, message: "Outbound messages are globally paused." });
      }

      const users = await storage.getAllUsers();
      let count = 0;
      for (const user of users) {
        if (user.subscriptionStatus === "active") {
          let msg = "";
          if (user.onboardingState === "COMPLETED" && !user.trainingMode) {
            msg = "Where will you train?\n1) Gym\n2) Home\n3) I can only walk";
          } else {
            const phase = user.programmePhase || 1;
            const phaseConfig = PHASE_CONFIG[phase] || PHASE_CONFIG[1];
            const summary = formatDailyWorkoutSummary(user);
            msg = `Morning ${user.name || "there"}. Phase ${phase}: ${phaseConfig.name}, Week ${user.programmeWeek || 1}. ${summary}`;
            const triggerNow = new Date();
            if (triggerNow.getDay() === 1) {
              msg += `\n\nWeek ${user.programmeWeek || 1} of Phase ${phaseConfig.name}. This week: ${phaseConfig.theme}. Show up every day this week — consistency compounds.`;
            }
            const milestone = getMilestoneMessage(user);
            if (milestone) {
              msg += `\n\n${milestone}`;
            }
          }
          await storage.logChat(user.id, "", msg, "DAILY_TRIGGER");
          count++;
        }
      }
      return res.json({ success: true, count });
    }
    
    res.status(400).json({ success: false, message: "Unknown action" });
  });

  // ============================================================
  // Schedulers
  // ============================================================

  // Daily scheduler
  setInterval(async () => {
    const now = new Date();
    // Daily 07:00
    if (now.getHours() === 7 && now.getMinutes() === 0) {
      const users = await storage.getAllUsers();
      for (const user of users) {
        if (user.subscriptionStatus === "active") {
          let msg = "";
          if (user.onboardingState === "COMPLETED" && !user.trainingMode) {
            msg = "Where will you train?\n1) Gym\n2) Home\n3) I can only walk";
          } else {
            const phase = user.programmePhase || 1;
            const phaseConfig = PHASE_CONFIG[phase] || PHASE_CONFIG[1];
            const summary = formatDailyWorkoutSummary(user);
            msg = `Morning ${user.name || "there"}. Phase ${phase}: ${phaseConfig.name}, Week ${user.programmeWeek || 1}. ${summary}`;
            if (now.getDay() === 1) {
              const nutrition = NUTRITION_BY_PHASE[phase] || NUTRITION_BY_PHASE[1];
              msg += `\n\nWeek ${user.programmeWeek || 1} of Phase ${phaseConfig.name}. This week: ${phaseConfig.theme}. Show up every day this week — consistency compounds.`;
              msg += `\n\nThis week nutrition focus: ${nutrition.keyHabit}`;
            }
            const milestone = getMilestoneMessage(user);
            if (milestone) {
              msg += `\n\n${milestone}`;
            }
          }
          console.log(`[SCHEDULE] Sending daily check-in to ${user.phoneNumber}`);
          await sendWhatsAppMessage(user.phoneNumber, msg);
          await storage.logChat(user.id, "", msg, "DAILY_MORNING");
        }
      }
    }
    // Daily 10:00 — Re-engagement (once per 3 days max)
    if (now.getHours() === 10 && now.getMinutes() === 0) {
      const users = await storage.getAllUsers();
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      for (const user of users) {
        if (user.subscriptionStatus === "active" && user.lastActiveAt && new Date(user.lastActiveAt) < threeDaysAgo) {
          const recentChats = await storage.getChatHistory(user.id, 10);
          const lastReengagement = recentChats.find(c => c.intent === "RE_ENGAGEMENT");
          if (lastReengagement && lastReengagement.createdAt && (Date.now() - new Date(lastReengagement.createdAt).getTime()) < 3 * 24 * 60 * 60 * 1000) {
            continue;
          }
          const msg = "You've gone quiet. Your body doesn't take days off — and neither should your mindset. Log one thing today: food, steps, or a workout. One thing. That's all it takes.";
          console.log(`[SCHEDULE] Re-engagement nudge to ${user.phoneNumber}`);
          await sendWhatsAppMessage(user.phoneNumber, msg);
          await storage.logChat(user.id, "", msg, "RE_ENGAGEMENT");
        }
      }
    }
    // Daily 11:00 — Win-back sequence for cancelled users
    if (now.getHours() === 11 && now.getMinutes() === 0) {
      const allUsers = await storage.getAllUsers();
      for (const u of allUsers) {
        if (u.subscriptionStatus === "inactive" && u.cancelledAt) {
          const daysSinceCancel = Math.floor((Date.now() - new Date(u.cancelledAt).getTime()) / (1000 * 60 * 60 * 24));
          const recentChats = await storage.getChatHistory(u.id, 20);
          const sentIntents = recentChats.filter(c => c.intent && c.intent.startsWith("WINBACK_DAY_")).map(c => c.intent);
          let winBackMsg = "";
          let winBackIntent = "";
          if (daysSinceCancel >= 3 && daysSinceCancel < 7 && !sentIntents.includes("WINBACK_DAY_3")) {
            winBackMsg = "You have been gone 3 days. Your body has not forgotten the progress you made. Come back — reply REJOIN to reactivate.";
            winBackIntent = "WINBACK_DAY_3";
          } else if (daysSinceCancel >= 7 && daysSinceCancel < 14 && !sentIntents.includes("WINBACK_DAY_7")) {
            winBackMsg = "One week since you left. Most people who quit wish they had stayed consistent. Reply REJOIN to come back at the same rate.";
            winBackIntent = "WINBACK_DAY_7";
          } else if (daysSinceCancel >= 14 && !sentIntents.includes("WINBACK_DAY_14")) {
            winBackMsg = "Two weeks gone. This is your last nudge from us. Reply REJOIN to restart your journey. After this we will not message again.";
            winBackIntent = "WINBACK_DAY_14";
          }
          if (winBackMsg) {
            console.log(`[SCHEDULE] Win-back ${winBackIntent} to ${u.phoneNumber}`);
            await sendWhatsAppMessage(u.phoneNumber, winBackMsg);
            await storage.logChat(u.id, "", winBackMsg, winBackIntent);
          }
        }
      }
    }
    // Daily 16:00
    if (now.getHours() === 16 && now.getMinutes() === 0) {
      const users = await storage.getAllUsers();
      for (const user of users) {
        if (user.subscriptionStatus === "active") {
          if (now.getDay() === 5) {
            const msg = "Weekend is coming. This is where most people lose their progress. Plan your Saturday meal right now — what will you eat? Reply and I will tell you if it works.";
            console.log(`[SCHEDULE] Friday weekend warning to ${user.phoneNumber}`);
            await sendWhatsAppMessage(user.phoneNumber, msg);
            await storage.logChat(user.id, "", msg, "FRIDAY_WARNING");
          } else {
            const msg = "Gym reminder: even 20 minutes counts. Reply DONE when finished.";
            console.log(`[SCHEDULE] Sending gym reminder to ${user.phoneNumber}`);
            await sendWhatsAppMessage(user.phoneNumber, msg);
            await storage.logChat(user.id, "", msg, "DAILY_GYM");
          }
        }
      }
    }
  }, 60000);

  async function calculateWeeklyCompliance(userId: string) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [steps, workouts, chat] = await Promise.all([
      storage.getStepLogs(userId),
      storage.getWorkoutLogs(userId),
      db.select().from(chatHistory).where(and(eq(chatHistory.userId, userId), gte(chatHistory.createdAt, sevenDaysAgo)))
    ]);

    const user = await storage.getUser(userId);
    if (!user) return { score: 0, level: "RESET" };

    // 1) Steps (25%)
    const stepsTarget = user.stepsTarget || 8000;
    const daysStepsMet = steps.filter(s => s.loggedAt && new Date(s.loggedAt) >= sevenDaysAgo && s.steps >= stepsTarget).length;
    const stepsScore = Math.min(25, (daysStepsMet / 7) * 25);

    // 2) Workouts (25%)
    const workoutsDone = workouts.filter(w => w.loggedAt && new Date(w.loggedAt) >= sevenDaysAgo && w.workoutCompleted).length;
    const workoutScore = Math.min(25, (workoutsDone / 3) * 25);

    // 3) Food (25%) - Days without junk/alcohol mentions in logs
    const foodLogs = chat.filter(c => c.intent === "LOG_FOOD_FOLLOWUP" || c.intent === "log_food");
    const badFoodDays = new Set(foodLogs.filter(c => /JUNK|ALCOHOL|SWEETS|CAKE|BEER|WINE/.test(c.messageIn?.toUpperCase() || "")).map(c => new Date(c.createdAt!).toDateString())).size;
    const foodScore = Math.max(0, 25 - (badFoodDays * 5));

    // 4) Logging consistency (25%)
    const activeDays = new Set(chat.map(c => new Date(c.createdAt!).toDateString())).size;
    const loggingScore = Math.min(25, (activeDays / 7) * 25);

    const totalScore = Math.round(stepsScore + workoutScore + foodScore + loggingScore);
    
    let level = "RESET";
    if (totalScore >= 90) level = "LOCKED IN";
    else if (totalScore >= 70) level = "CONSISTENT";
    else if (totalScore >= 40) level = "BUILDING";

    const weekSteps = steps.filter(s => s.loggedAt && new Date(s.loggedAt) >= sevenDaysAgo);
    const avgSteps = weekSteps.length > 0 ? Math.round(weekSteps.reduce((sum, s) => sum + s.steps, 0) / weekSteps.length) : 0;
    const foodLogDays = new Set(foodLogs.map(c => new Date(c.createdAt!).toDateString())).size;

    return { score: totalScore, level, workoutsDone, avgSteps, foodLogDays, activeDays };
  }

  async function getConsistencyStreak(userId: string): Promise<number> {
    const chats = await storage.getChatHistory(userId, 100);
    const logIntents = ["LOG_FOOD", "LOG_FOOD_FOLLOWUP", "LOG_STEPS", "LOG_STEPS_FOLLOWUP", "LOG_WEIGHT", "LOG_WEIGHT_FOLLOWUP", "WORKOUT_DONE", "FOOD_PORTION", "LOG_SLEEP"];
    const loggedDates = new Set(
      chats.filter(c => c.intent && logIntents.includes(c.intent) && c.createdAt)
        .map(c => new Date(c.createdAt!).toDateString())
    );
    let streak = 0;
    const today = new Date();
    for (let i = 0; i < 60; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      if (loggedDates.has(d.toDateString())) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }

  function getStreakMessage(streak: number): string {
    if (streak === 7) return "\n\nDay 7 streak. You have logged every single day this week. That is the 1% habit. Keep it going.";
    if (streak === 30) return "\n\n30 day streak. You are no longer trying to build a habit — you have one. Screenshot this.";
    return "";
  }

  // Weekly scheduler
  setInterval(async () => {
    const now = new Date();
    // Sunday 18:00
    if (now.getDay() === 0 && now.getHours() === 18 && now.getMinutes() === 0) {
      const users = await storage.getAllUsers();
      for (const user of users) {
        if (user.subscriptionStatus === "active") {
          const { score, level, workoutsDone, avgSteps, foodLogDays, activeDays } = await calculateWeeklyCompliance(user.id);
          await storage.updateUser(user.id, { weeklyScore: score, complianceLevel: level });

          const levelMsg = level === "LOCKED IN" ? R.weeklyLockedIn() :
            level === "CONSISTENT" ? R.weeklyConsistent() :
            level === "BUILDING" ? R.weeklyBuilding() :
            R.weeklyReset();
          const fDays = foodLogDays || 0;
          const aSteps = avgSteps || 0;
          const aDays = activeDays || 0;
          const foodConsistency = fDays >= 5 ? "Yes — solid tracking" : fDays >= 3 ? "Partial — log every meal" : "No — you need to track daily";
          let report = `*Weekly Report — ${user.name || "Hey"}*\n\n${user.name || "Hey"}, here's your week:\n\nScore: ${score}/100\nLevel: ${level}\n\nWorkouts: ${workoutsDone}/3 completed\nAvg Steps: ${aSteps.toLocaleString()}/day\nFood Logged Consistently: ${foodConsistency}\nDays Active: ${aDays}/7\n\n${levelMsg}`;

          const daysSinceJoin = user.createdAt ? Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24)) : 0;
          if (daysSinceJoin >= 14 && daysSinceJoin <= 21) {
            report += "\n\nYou are in week 3 — the hardest week of any programme. Motivation is low, results feel slow, life is getting in the way. This is exactly where most people quit. The ones who push through week 3 are the ones who get results. You are not most people. Show up this week.";
          }
          if (daysSinceJoin >= 28) {
            const prevChats = await storage.getChatHistory(user.id, 50);
            const alreadyPrompted = prevChats.some(c => c.intent === "PHOTO_PROMPT");
            if (!alreadyPrompted) {
              report += "\n\nYou have been on this programme for 4 weeks. Take a front and side photo today — same time, same lighting. This is your progress marker. You will thank yourself in 4 more weeks.";
              await storage.logChat(user.id, "", "Photo prompt sent", "PHOTO_PROMPT");
            }
          }

          console.log(`[SCHEDULE] Sending weekly report to ${user.phoneNumber}`);
          await sendWhatsAppMessage(user.phoneNumber, report);
          await storage.logChat(user.id, "", report, "WEEKLY_REPORT");
        }
      }
    }
  }, 60000);

  return httpServer;
}
