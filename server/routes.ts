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

async function getKamLifeFoodReply(
  userMessage: string,
  userCalories: number,
  recentHistory: string,
  userName: string
): Promise<{reply: string, nextState: string}> {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 150,
      messages: [
        {
          role: "system",
          content: `You are KamLife Coach — a firm, direct South African fitness coach operating on WhatsApp.

FOOD KNOWLEDGE:
You understand ALL South African foods including pap, samp, umngqusho, morogo, chakalaka, vetkoek, magwinya, kota, gatsbys, braai meat, wors, boerewors, tripe, mogodu, umleqwa, pilchards, tinned fish, Spar pies, Shoprite specials, amagwinya, umqombothi, Savanna, Hunters, Black Label, street food, township food, suburban food — everything.
You understand portion sizes, cooking methods, and how SA people actually eat.

COACHING RULES:
- Max 2 sentences. Firm. Direct. No emojis. No fluff.
- Never say "Got it", "Nice", "Great job" generically.
- Respond to exactly what they ate — be specific.
- Junk food: call it out firmly, tell them exactly what next meal must be.
- Alcohol: be strict, state the cost to their progress.
- No protein: name exactly what to add (eggs/chicken/pilchards/beans).
- Balanced meal: brief acknowledgement + reinforce one habit.
- Skipped meal: firm instruction to eat protein now.
- Sound like a real coach who knows SA food culture, not a foreign app.

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

Recent context: ${recentHistory || "First log today."}
User calorie target: ${userCalories}kcal
User name: ${userName}`
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
      model: "gpt-5.1",
      messages: [
        {
          role: "system",
          content: `You are 'KamLife Coach' Intent Parser.
          Supported intents: onboarding_answer, log_steps, log_workout, log_weight, weekly_checkin_response, hungry, general_question.
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

async function generateReply(message: string, intent: string, context: any): Promise<string> {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.1",
      messages: [
        {
          role: "system",
          content: `You are 'KamLife Coach'. 
          Write short, direct, motivational replies in South African English. No fluff. No 'AI' mentions.
          Context: ${JSON.stringify(context)}`
        },
        { role: "user", content: message }
      ]
    });
    return completion.choices[0].message.content || "Keep pushing!";
  } catch (e) {
    return "Keep pushing!";
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

    // ── Priority 2: CANARY (PING) ──
    if (cleanMsg === "PING") {
      return res.type('text/xml').send(`<Response><Message>PONG v2 ✅ Replit webhook live</Message></Response>`);
    }

    // ── Priority 3: New user check ──
    let user = await storage.getUserByPhone(phoneNumber);
    const betaTesters = (process.env.BETA_TESTERS || "").split(",").map(p => p.trim());
    const isBetaTester = betaTesters.includes(phoneNumber);

    if (!user) {
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
        return res.type('text/xml').send(`<Response><Message>Welcome to KamLife Coach! Let's get started. What is your full name?</Message></Response>`);
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

    // ── Priority 8: RESET command ──
    if (cleanMsg === "RESET") {
      await storage.updateUser(user.id, { awaitingInputType: null });
      const menu = `Reset done. ${menuText}`;
      await storage.logChat(user.id, message, menu, "COACH_RESET");
      return res.type('text/xml').send(`<Response><Message>${menu}</Message></Response>`);
    }

    // ── Priority 8.5: HELP command ──
    if (cleanMsg === "HELP") {
      const helpReply = "Here to help.\n\n- Reply MENU to see your options\n- Reply RESET if something seems off\n- Reply 7 to update your goal or training mode\n- Just type what you ate, your steps, or your workout — anytime\n\nKamLife Coach is with you 24/7. Keep pushing.";
      await storage.logChat(user.id, message, helpReply, "HELP");
      return res.type('text/xml').send(`<Response><Message>${helpReply}</Message></Response>`);
    }

    // ── Priority 8.55: CANCEL command ──
    if (cleanMsg === "CANCEL") {
      const cancelReply = "Before you go — tell us why you want to cancel. Reply:\n1) Too expensive\n2) Not getting results\n3) Too busy\nOr reply CONFIRM to cancel.";
      await storage.updateUser(user.id, { awaitingInputType: "awaiting_cancel" });
      await storage.logChat(user.id, message, cancelReply, "CANCEL_INIT");
      return res.type('text/xml').send(`<Response><Message>${cancelReply}</Message></Response>`);
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
          await storage.updateUser(user.id, { awaitingInputType: null, subscriptionStatus: "inactive" });
          const reply = "Cancelled. You can rejoin anytime at kamlifecoach.co.za. Keep pushing — even without us.";
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
          const context = await getRecentFoodContext(user.id);
          const { reply } = await getKamLifeFoodReply(message, user.calorieTarget || 2000, context, user.name || "there");
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
          const context = await getRecentFoodContext(user.id);
          const { reply } = await getKamLifeFoodReply(
            message,
            user.calorieTarget || 2000,
            context,
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

        const context = await getRecentFoodContext(user.id);
        const { reply } = await getKamLifeFoodReply(
          `They drank: ${message}`,
          user.calorieTarget || 2000,
          context,
          user.name || "there"
        );

        await storage.updateUser(user.id, { awaitingInputType: "anything_else" });
        const full = `${reply} Anything else to log? (yes/no)`;
        await storage.logChat(user.id, message, full, "DRINK_LOGGED");
        return res.type('text/xml').send(`<Response><Message>${full}</Message></Response>`);
      }

      if (inputType === "food") {
        const context = await getRecentFoodContext(user.id);
        const { reply } = await getKamLifeFoodReply(
          message,
          user.calorieTarget || 2000,
          context,
          user.name || "there"
        );
        await storage.updateUser(user.id, { awaitingInputType: null });
        await storage.logChat(user.id, message, reply, "FOOD_LOGGED");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }

      if (inputType === "steps") {
        await storage.updateUser(user.id, { awaitingInputType: null });
        const stepsMatch = cleanMsg.match(/\d+/);
        const steps = stepsMatch ? parseInt(stepsMatch[0]) : (cleanMsg.includes("NO STEPS") ? 0 : null);
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
        reply = R.onboardingName(message);
      } else if (currentState === "AWAITING_GOAL") {
        let goalValue = message;
        if (cleanMsg === "1") goalValue = "Fat Loss";
        else if (cleanMsg === "2") goalValue = "Muscle Gain";
        await storage.updateUser(user.id, { goalType: goalValue, onboardingState: "AWAITING_WEIGHT" });
        reply = R.onboardingGoal();
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
          reply = "Where will you train?\n1) Gym\n2) Home\n3) Walking only";
        }
      } else if (currentState === "AWAITING_TRAINING_MODE") {
        let mode: string | null = null;
        if (cleanMsg === "1" || cleanMsg.includes("GYM")) mode = "gym";
        else if (cleanMsg === "2" || cleanMsg.includes("HOME")) mode = "home";
        else if (cleanMsg === "3" || cleanMsg.includes("WALK")) mode = "walk_only";
        if (mode) {
          await storage.updateUser(user.id, { trainingMode: mode, onboardingState: "COMPLETED" });
          const isProfileUpdate = !!user.name;
          reply = isProfileUpdate
            ? `Profile updated. You are ready. Let's get to work.\n\n${menuText}`
            : `${R.onboardingComplete()}\n\n${menuText}`;
        } else {
          reply = "Please reply 1, 2, or 3.\n1) Gym\n2) Home\n3) Walking only";
        }
      }

      if (reply) {
        await storage.logChat(user.id, message, reply, "ONBOARDING");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
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

      if (/GYM|WORKOUT|PROGRAM|TRAINING/.test(cleanMsg)) detectedIntent = "GET_WORKOUT";
      else if (/STEPS|WALK|NO STEPS/.test(cleanMsg)) detectedIntent = "LOG_STEPS";
      else if (/FOOD|MEAL|ATE|PAP|CHICKEN|OATS|BREAD/.test(cleanMsg) && foodEvidence) detectedIntent = "LOG_FOOD";
      else if (/SLEEP|SLEPT/.test(cleanMsg)) detectedIntent = "LOG_SLEEP";
      else if (/WEIGHT|KG/.test(cleanMsg)) detectedIntent = "LOG_WEIGHT";
      else if (/TARGETS|MACROS|CALORIES/.test(cleanMsg)) detectedIntent = "SHOW_TARGETS";
      else if (cleanMsg === "DONE") detectedIntent = "WORKOUT_DONE";
      else if (foodEvidence) detectedIntent = "LOG_FOOD";

      if (/WHAT CAN I EAT|FOOD SUGGESTIONS|MEAL IDEAS/.test(cleanMsg)) {
        const advice = "For fat loss, focus on high-protein and fibre: \n- Oats or Eggs for breakfast\n- Grilled chicken or tinned fish with veg for lunch/dinner\n- Limit pap/rice to one fist size per meal.\nWhat are you planning to eat next?";
        await storage.logChat(user.id, message, advice, "FOOD_ADVICE");
        return res.type('text/xml').send(`<Response><Message>${advice}</Message></Response>`);
      }
    }

    console.log("INTENT:", detectedIntent);

    // ── Priority 11: INTENT HANDLERS ──

    if (detectedIntent === "LOG_FOOD") {
      const nothingWords = ["NOTHING", "DIDNT EAT", "SKIPPED", "NO FOOD", "NONE"];
      if (nothingWords.some(w => cleanMsg.includes(w))) {
        const reply = "Skipping meals slows fat loss and triggers cravings. Get 2 eggs or a tin of fish in now. Reply DONE after eating.";
        await storage.logChat(user.id, message, reply, "FOOD_SKIPPED");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }

      const recentContext = await getRecentFoodContext(user.id);
      const { reply: coachReply, nextState } = await getKamLifeFoodReply(message, user.calorieTarget || 2000, recentContext, user.name || "there");

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
      const stepsMatch = cleanMsg.match(/\d+/);
      const steps = stepsMatch ? parseInt(stepsMatch[0]) : (cleanMsg.includes("NO STEPS") ? 0 : null);

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
      const reply = `${R.workoutDone()} Tomorrow is Day ${nextDay}.`;
      await storage.logChat(user.id, message, reply, "WORKOUT_DONE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    // ── Priority 12: DEFAULT ──
    await storage.logChat(user.id, message, menuText, "COACH_MENU");
    return res.type('text/xml').send(`<Response><Message>${menuText}</Message></Response>`);
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
          await storage.logChat(user.id, "", msg, "RE_ENGAGEMENT");
        }
      }
    }
    // Daily 16:00
    if (now.getHours() === 16 && now.getMinutes() === 0) {
      const users = await storage.getAllUsers();
      for (const user of users) {
        if (user.subscriptionStatus === "active") {
          const msg = "Gym reminder: even 20 minutes counts. Reply DONE when finished.";
          console.log(`[SCHEDULE] Sending gym reminder to ${user.phoneNumber}`);
          // await storage.logChat(user.id, "", msg, "DAILY_GYM");
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
          const report = `*Weekly Compliance Report*\n\n${user.name || "Hey"}, here's your week:\n\nScore: ${score}/100\nLevel: ${level}\n\nWorkouts: ${workoutsDone}/3 completed\nAvg Steps: ${aSteps.toLocaleString()}/day\nFood Logged Consistently: ${foodConsistency}\nDays Active: ${aDays}/7\n\n${levelMsg}\n\nReply MENU to continue.`;

          console.log(`[SCHEDULE] Sending weekly report to ${user.phoneNumber}`);
          await storage.logChat(user.id, "", report, "WEEKLY_REPORT");
        }
      }
    }
  }, 60000);

  return httpServer;
}
