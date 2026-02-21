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

const WORKOUTS_21DAY: Record<string, string[]> = {
  gym: [
    "Bike 10 min warm up. Chest press 3x10. Seated row 3x10. Shoulder press 3x10. Rest 60 seconds between sets.",
    "Treadmill 15 min incline walk. Leg press 3x12. Leg curl 3x12. Calf raises 3x15.",
    "Rest day — 20 min walk outside. Stretch for 10 minutes.",
    "Bike 10 min. Bicep curls 3x12. Tricep pushdown 3x12. Lat pulldown 3x10.",
    "Full body circuit — 3 rounds: 10 squats, 10 push ups, 10 rows, 10 shoulder press. 90 sec rest between rounds.",
    "Cardio day — 30 min treadmill or bike at moderate pace.",
    "Rest day — light walk and stretch.",
    "Bike 10 min. Chest press 4x10. Seated row 4x10. Shoulder press 4x10. Rest 60 sec.",
    "Treadmill 15 min incline. Leg press 3x14. Leg curl 3x14. Calf raises 3x17.",
    "Rest day — 25 min walk outside. Stretch 10 minutes.",
    "Bike 10 min. Bicep curls 3x14. Tricep pushdown 3x14. Lat pulldown 3x12.",
    "Full body circuit — 3 rounds: 12 squats, 12 push ups, 12 rows, 12 shoulder press. 90 sec rest.",
    "Cardio day — 35 min treadmill or bike at moderate pace.",
    "Rest day — light walk and stretch.",
    "Bike 10 min. Chest press 4x12. Seated row 4x12. Shoulder press 4x12. Rest 60 sec.",
    "Treadmill 20 min incline. Leg press 4x12. Leg curl 4x12. Calf raises 4x15.",
    "Rest day — 30 min walk outside. Stretch 10 minutes.",
    "Bike 10 min. Bicep curls 4x12. Tricep pushdown 4x12. Lat pulldown 4x10.",
    "Full body circuit — 4 rounds: 12 squats, 12 push ups, 12 rows, 12 shoulder press. 90 sec rest.",
    "Cardio day — 40 min treadmill or bike at moderate pace.",
    "Rest day — light walk and full body stretch. You earned it."
  ],
  home: [
    "Squats 3x10. Push ups 3x10 (or knees). Wall sit 30 sec x3. Plank 30 sec x3.",
    "Lunges 3x10 each leg. Mountain climbers 3x20. Push ups 3x10. Plank 45 sec x3.",
    "Rest day — 20 min walk outside. Stretch for 10 minutes.",
    "Squats 3x12. Push ups 3x12. Step ups on chair 3x10 each leg. Plank 45 sec x3.",
    "Full body circuit — 3 rounds: 10 squats, 10 push ups, 10 lunges, 20 mountain climbers. 90 sec rest.",
    "Cardio day — 30 min brisk walk or jog. Keep moving the whole time.",
    "Rest day — light walk and stretch.",
    "Squats 4x10. Push ups 4x10. Wall sit 45 sec x3. Plank 45 sec x3.",
    "Lunges 3x12 each leg. Mountain climbers 3x25. Push ups 3x12. Plank 60 sec x3.",
    "Rest day — 25 min walk outside. Stretch 10 minutes.",
    "Squats 3x14. Push ups 3x14. Step ups 3x12 each leg. Plank 60 sec x3.",
    "Full body circuit — 3 rounds: 12 squats, 12 push ups, 12 lunges, 25 mountain climbers. 90 sec rest.",
    "Cardio day — 35 min brisk walk or jog.",
    "Rest day — light walk and stretch.",
    "Squats 4x12. Push ups 4x12. Wall sit 60 sec x3. Plank 60 sec x3.",
    "Lunges 4x12 each leg. Mountain climbers 4x25. Push ups 4x12. Plank 60 sec x3.",
    "Rest day — 30 min walk outside. Stretch 10 minutes.",
    "Squats 4x14. Push ups 4x14. Step ups 4x12 each leg. Plank 60 sec x3.",
    "Full body circuit — 4 rounds: 12 squats, 12 push ups, 12 lunges, 25 mountain climbers. 90 sec rest.",
    "Cardio day — 40 min brisk walk or jog.",
    "Rest day — light walk and full body stretch. You earned it."
  ],
  walk_only: [
    "Walk 10 minutes at easy pace. Focus on posture — head up, shoulders back.",
    "Walk 12 minutes. Slightly faster than yesterday.",
    "Walk 15 minutes. Find a route with a gentle hill if you can.",
    "Rest day — 10 min easy walk and stretch.",
    "Walk 18 minutes at a steady pace. No stopping.",
    "Walk 20 minutes. Push the pace for the last 5 minutes.",
    "Rest day — light 10 min walk.",
    "Walk 22 minutes. Keep a brisk pace the whole way.",
    "Walk 25 minutes. Add an incline or stairs if possible.",
    "Walk 25 minutes at a steady pace. No stopping.",
    "Rest day — 15 min easy walk and stretch.",
    "Walk 28 minutes. Push pace for the last 8 minutes.",
    "Walk 30 minutes. Find a new route to keep it interesting.",
    "Rest day — 15 min easy walk.",
    "Walk 30 minutes brisk pace. No stopping.",
    "Walk 33 minutes. Push pace for the last 10 minutes.",
    "Walk 35 minutes. Add incline or stairs.",
    "Rest day — 15 min easy walk and stretch.",
    "Walk 38 minutes at a brisk pace.",
    "Walk 40 minutes. Push hard for the last 10 minutes.",
    "Walk 45 minutes. Full effort. You earned this distance."
  ]
};

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

    return `
CLIENT PROFILE:
Name: ${user.name || 'unknown'}
Age: ${user.age || 'unknown'}
Goal: ${user.goalType || 'fat loss'}
Training mode: ${user.trainingMode || 'home'}
Days on programme: ${joinedDaysAgo}
Compliance level: ${user.complianceLevel || 'BUILDING'}
Weekly score: ${user.weeklyScore || 0}/100
Calorie target: ${user.calorieTarget || 2000}kcal
Step target: ${user.stepsTarget || 8000}
Current weight: ${user.currentWeight || 'unknown'}kg
Weight trend: ${weightTrend}
Average steps this week: ${avgSteps}
Step trend: ${stepTrend}
Days since last active: ${daysSinceActive}
Day of week: ${dayOfWeek}
Health conditions noted: ${user.injuries || 'none'}
Recent food: ${recentFood || 'nothing logged recently'}
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

    const menuText = `KamLife Coach ✅ What do you want to do?\n1) Today's workout\n2) Log food\n3) Log steps\n4) Log sleep\n5) Log weight\n6) Show my targets\n7) Update my profile\nReply 1–7.`;

    // ── Priority 1: GREETING GUARD ──
    const rawMsg = message.trim().toLowerCase().replace(/[^\w\s]/g, "");
    const greetings = ["hi", "hello", "hey", "howzit", "sup", "yo", "sawubona", "dumela", "molo", "molweni"];
    const rawWords = rawMsg.split(/\s+/);
    const isGreeting = greetings.includes(rawMsg) || (message.length <= 20 && rawWords.some(w => greetings.includes(w)) && !/\d/.test(message));

    if (isGreeting) {
      let user = await storage.getUserByPhone(phoneNumber);
      if (user) {
        await storage.updateUser(user.id, { awaitingInputType: null, lastActiveAt: new Date() });
        await storage.logChat(user.id, message, menuText, "COACH_MENU");
        return res.type('text/xml').send(`<Response><Message>${menuText}</Message></Response>`);
      }
    }

    // ── Priority 1.5: INFORMAL SA LANGUAGE ──
    const saAckWords = ["YEBO", "JA", "AWEH", "SHO", "LEKKER", "SHARP", "SHARP SHARP", "KE SHARP"];
    if (saAckWords.includes(cleanMsg)) {
      let user = await storage.getUserByPhone(phoneNumber);
      if (user) {
        await storage.updateUser(user.id, { awaitingInputType: null, lastActiveAt: new Date() });
        await storage.logChat(user.id, message, menuText, "SA_SLANG_ACK");
        return res.type('text/xml').send(`<Response><Message>${menuText}</Message></Response>`);
      }
    }
    const saNoWords = ["NEE", "AIKONA"];
    if (saNoWords.includes(cleanMsg)) {
      let user = await storage.getUserByPhone(phoneNumber);
      if (user) {
        const reply = "Noted. Reply MENU when you are ready.";
        await storage.logChat(user.id, message, reply, "SA_SLANG_NO");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
    }
    const saGreetWords = ["EITA", "AIGHT", "AITE"];
    if (saGreetWords.includes(cleanMsg)) {
      let user = await storage.getUserByPhone(phoneNumber);
      if (user) {
        await storage.updateUser(user.id, { awaitingInputType: null, lastActiveAt: new Date() });
        await storage.logChat(user.id, message, menuText, "SA_SLANG_GREET");
        return res.type('text/xml').send(`<Response><Message>${menuText}</Message></Response>`);
      }
    }
    const saCoachWords = ["YEBO COACH", "SHARP COACH", "LEKKER COACH"];
    if (saCoachWords.includes(cleanMsg)) {
      let user = await storage.getUserByPhone(phoneNumber);
      if (user) {
        const motivation = getRotatingMotivation();
        const reply = `${motivation}\n\n${menuText}`;
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
          return res.type('text/xml').send(`<Response><Message>Welcome to KamLife Coach. No fad diets. No detox teas. No shortcuts. Just real coaching that works. Your 7 free days are activated — courtesy of a friend who believes in you. What is your name?</Message></Response>`);
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
        return res.type('text/xml').send(`<Response><Message>Welcome to KamLife Coach. No fad diets. No detox teas. No shortcuts. Just real coaching that works. Let's build your profile. What is your name?</Message></Response>`);
      } else {
        return res.type('text/xml').send(`<Response><Message>Welcome to KamLife Coach. Subscribe here: ${paymentLink}</Message></Response>`);
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
      const menu = `Reset done. ${menuText}`;
      await storage.logChat(user.id, message, menu, "COACH_RESET");
      return res.type('text/xml').send(`<Response><Message>${menu}</Message></Response>`);
    }

    // ── Priority 8.5: HELP command ──
    if (cleanMsg === "HELP") {
      const helpReply = "Here to help.\n\n- Reply MENU to see your options\n- Reply RESET if something seems off\n- Reply 7 to update your goal or training mode\n- Just type what you ate, your steps, or your workout — anytime\n\nReply SUPPORT and we will get back to you within 24 hours.";
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
      const reply = "Welcome back. That took courage. Let us pick up where you left off. Reply MENU to continue.";
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

      const progressReply = `*Progress Report — ${user.name || "Hey"}*\n\nWeight: ${currentWeight}kg (was ${fourWeeksAgoWeight}kg 4 weeks ago)\nAvg Steps This Week: ${avgSteps.toLocaleString()}/day\nCompliance: ${compliance.score}/100 — ${compliance.level}\n\n${compliance.score >= 90 ? "You are locked in. Keep this standard." : compliance.score >= 70 ? "Solid progress. Tighten up the weak spots this week." : compliance.score >= 50 ? "Room to improve. Pick one area and fix it this week." : "We need to reset. Commit to showing up every day this week."}\n\nReply MENU to continue.`;
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
          const reply = `Great decision. Let's get back to work.\n\n${menuText}`;
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
          await storage.logChat(user.id, message, menuText, "COACH_MENU");
          return res.type('text/xml').send(`<Response><Message>${menuText}</Message></Response>`);
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
          return res.type('text/xml').send(`<Response><Message>${menuText}</Message></Response>`);
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
        await storage.updateUser(user.id, { name: message, onboardingState: "AWAITING_GOAL" });
        reply = `Good to meet you, ${message}. By continuing you agree to our coaching terms — KamLife Coach provides fitness guidance only, not medical advice. Consult a doctor before starting any programme.\n\nOne question — what is your main goal right now?\n1) Lose fat\n2) Build muscle\n3) Get fit and healthy`;
      } else if (currentState === "AWAITING_GOAL") {
        let goalValue = message;
        if (cleanMsg === "1") goalValue = "Fat Loss";
        else if (cleanMsg === "2") goalValue = "Muscle Gain";
        else if (cleanMsg === "3") goalValue = "General Fitness";
        await storage.updateUser(user.id, { goalType: goalValue, onboardingState: "AWAITING_WEIGHT" });
        reply = "Understood. How much do you weigh right now? Just the number in kg — no judgment here, just data.";
      } else if (currentState === "AWAITING_WEIGHT") {
        const weightVal = parseFloat(message);
        if (!weightVal || weightVal < 30 || weightVal > 300) {
          reply = "Please enter a valid weight in kg (e.g. 85).";
        } else {
          const goalStr = (user.goalType || "").toLowerCase();
          let calorieTarget: number;
          if (goalStr.includes("fat") || goalStr.includes("loss")) {
            calorieTarget = Math.max(1500, Math.round(weightVal * 22 - 500));
          } else {
            calorieTarget = Math.round(weightVal * 22 + 300);
          }
          await storage.updateUser(user.id, { currentWeight: String(weightVal), onboardingState: "AWAITING_TRAINING_MODE", calorieTarget });
          reply = "Good. Where will you be training?\n1) Gym\n2) At home\n3) Walking only";
        }
      } else if (currentState === "AWAITING_TRAINING_MODE") {
        let mode: string | null = null;
        if (cleanMsg === "1" || cleanMsg.includes("GYM")) mode = "gym";
        else if (cleanMsg === "2" || cleanMsg.includes("HOME")) mode = "home";
        else if (cleanMsg === "3" || cleanMsg.includes("WALK")) mode = "walk_only";
        if (mode) {
          await storage.updateUser(user.id, { trainingMode: mode, onboardingState: "AWAITING_AGE" });
          reply = "How old are you? This helps us personalise your programme.";
        } else {
          reply = "Please reply 1, 2, or 3.\n1) Gym\n2) At home\n3) Walking only";
        }
      } else if (currentState === "AWAITING_AGE") {
        const ageVal = parseInt(message);
        if (!ageVal || ageVal < 10 || ageVal > 100) {
          reply = "Please enter your age as a number (e.g. 32).";
        } else {
          await storage.updateUser(user.id, { age: ageVal, onboardingState: "AWAITING_CONDITIONS" });
          reply = "Last thing — any injuries, chronic conditions or health issues we should know about before we start? Examples: bad knee, diabetes, hypertension, pregnancy. Reply NONE if nothing to declare.";
        }
      } else if (currentState === "AWAITING_CONDITIONS") {
        const conditionText = cleanMsg === "NONE" || cleanMsg === "NO" || cleanMsg === "NOTHING" ? null : message;
        await storage.updateUser(user.id, { injuries: conditionText, onboardingState: "COMPLETED" });
        const calTarget = user.calorieTarget || 2000;
        const proteinTarget = Math.round((calTarget * 0.3) / 4);
        const userName = user.name || "coach";
        reply = `Profile complete, ${userName}. Here is your plan:\n\nCalorie target: ${calTarget}kcal daily\nProtein target: ${proteinTarget}g daily\nStep target: 8,000 steps daily\nWorkouts: minimum 3x per week\n\nStart right now:\n1) Log what you ate today\n2) Check your first workout\n3) Log your steps\n\nThe work starts today — not tomorrow. Reply MENU to begin.`;
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
      const loggedToday = weightLogs.some(l => new Date(l.createdAt!) >= todayStart);
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
      await storage.updateUser(user.id, { onboardingState: "AWAITING_GOAL", awaitingInputType: null });
      const reply = "Let's update your profile. What is your main goal?\n1) Fat Loss\n2) Muscle Gain";
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
        const full = `${coachReply}\n\nReply MENU to see your options.`;
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
      const day = user.programDayIndex || 1;
      const mode = (user.trainingMode as string) || "home";
      const program = WORKOUTS_21DAY[mode] || WORKOUTS_21DAY.home;
      const workout = program[(day - 1) % 21];
      const reply = `Day ${day} — ${workout} Get it done. Reply DONE when finished.`;
      await storage.logChat(user.id, message, reply, "GET_WORKOUT");
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
        const reply = `${reaction}${comparison}${winMoment}${streakMsg}`;
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
      let nextDay = (user.programDayIndex || 1) + 1;
      if (nextDay > 21) nextDay = 1;
      await storage.updateUser(user.id, { programDayIndex: nextDay });
      const woStreak = await getConsistencyStreak(user.id);
      const reply = `${R.workoutDone()} Tomorrow is Day ${nextDay}.${getStreakMessage(woStreak)}`;
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
    return res.type('text/xml').send(`<Response><Message>${reply}\n\nReply MENU to see your options.</Message></Response>`);
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
            const day = user.programDayIndex || 1;
            const mode = (user.trainingMode as string) || "home";
            const program = WORKOUTS_21DAY[mode] || WORKOUTS_21DAY.home;
            const workout = program[(day - 1) % 21];
            msg = `Morning ${user.name || "there"}. Today is Day ${day}: ${workout}. Reply DONE when finished.`;
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
            const day = user.programDayIndex || 1;
            const mode = (user.trainingMode as string) || "home";
            const program = WORKOUTS_21DAY[mode] || WORKOUTS_21DAY.home;
            const workout = program[(day - 1) % 21];
            msg = `Morning ${user.name || "there"}. Today is Day ${day}: ${workout}. Reply DONE when finished.`;
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
          let report = `*Weekly Report — ${user.name || "Hey"}*\n\n${user.name || "Hey"}, here's your week:\n\nScore: ${score}/100\nLevel: ${level}\n\nWorkouts: ${workoutsDone}/3 completed\nAvg Steps: ${aSteps.toLocaleString()}/day\nFood Logged Consistently: ${foodConsistency}\nDays Active: ${aDays}/7\n\n${levelMsg}\n\nReply MENU to continue.`;

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
