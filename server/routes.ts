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

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

function parseFoodMessage(text: string) {
  const upper = text.toUpperCase();
  const tokens = upper.split(/[\s,.;]+/).filter(t => t.length > 1);
  
  const foods: string[] = [];
  const drinks: string[] = [];
  const mealHints: string[] = [];
  const carbItems: string[] = [];
  const junkItems: string[] = [];
  const proteinItems: string[] = [];
  
  // South African food keywords
  const proteinKeywords = ["CHICKEN", "EGGS", "FISH", "BEANS", "LENTILS", "LIVER", "PILCHARDS", "BEEF", "STEW", "TRIPE", "WORS", "STEAK"];
  const junkKeywords = ["PIZZA", "DONUT", "CHOCOLATE", "CHIPS", "FRIES", "MAGWINYA", "KOTA", "BURGER", "SWEETS", "CAKE", "BISCUITS", "COKE", "PEPSI", "FANTA", "SPRITE", "SAVANNA", "HUNTERS", "BEER", "WINE", "WHISKY"];
  const carbKeywords = ["PAP", "RICE", "PASTA", "BREAD", "SAMP", "POTATO", "DUMPLING", "KOTA", "PIZZA", "BURGER"];
  const drinkKeywords = ["WATER", "COKE", "PEPSI", "FANTA", "SPRITE", "JUICE", "SODA", "BEER", "WINE", "WHISKY", "TEA", "COFFEE", "MILK"];
  const mealKeywords = ["BREAKFAST", "LUNCH", "DINNER", "SNACK"];

  tokens.forEach(t => {
    if (proteinKeywords.includes(t)) proteinItems.push(t);
    if (carbKeywords.includes(t)) carbItems.push(t);
    if (junkKeywords.includes(t)) junkItems.push(t);
    if (drinkKeywords.includes(t)) drinks.push(t);
    if (mealKeywords.includes(t)) mealHints.push(t);
  });

  // Extract quantities (simple regex)
  const quantities = text.match(/\d+(\.\d+)?\s*(L|ML|KG|G|FISTS?|PLATES?|BEERS?|GLASSES?)/gi) || [];

  const isDailyDump = mealHints.length >= 2 || tokens.length >= 6 || mealHints.some(m => ["BREAKFAST", "LUNCH", "DINNER"].includes(m));

  return {
    foods: tokens.filter(t => !drinkKeywords.includes(t) && !mealKeywords.includes(t)),
    drinks,
    mealHints,
    quantities,
    carbItems: Array.from(new Set(carbItems)),
    junkItems: Array.from(new Set(junkItems)),
    proteinItems: Array.from(new Set(proteinItems)),
    isDailyDump,
    tokenCount: tokens.length
  };
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

    const menuText = `KamLife Coach ✅ What do you want to do?\n1) Today's workout\n2) Log food\n3) Log steps\n4) Log sleep\n5) Log weight\n6) Show my targets\nReply 1–6.`;

    // ── Priority 1: GREETING GUARD ──
    const rawMsg = message.trim().toLowerCase().replace(/[^\w\s]/g, "");
    const greetings = ["hi", "hello", "hey", "howzit", "sup", "yo", "sawubona", "dumela", "molo", "molweni"];
    const rawWords = rawMsg.split(/\s+/);
    const isGreeting = greetings.includes(rawMsg) || (message.length <= 20 && rawWords.some(w => greetings.includes(w)) && !/\d/.test(message));

    if (isGreeting) {
      let user = await storage.getUserByPhone(phoneNumber);
      if (user) {
        await storage.updateUser(user.id, { awaitingInputType: null, lastActiveAt: new Date() });
        await storage.logChat(user.id, message, menuText + " [STATE: none]", "COACH_MENU");
        return res.type('text/xml').send(`<Response><Message>${menuText} [STATE: none]</Message></Response>`);
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
        return res.type('text/xml').send(`<Response><Message>Welcome to KamLife! Let's get started. What is your full name? [STATE: none]</Message></Response>`);
      } else {
        return res.type('text/xml').send(`<Response><Message>Welcome to KamLife. Subscribe here: ${paymentLink} [STATE: none]</Message></Response>`);
      }
    }

    // ── Priority 4: ADMIN BYPASS (BYPASS ON/OFF) ──
    if (cleanMsg === "BYPASS ON") {
      await storage.updateUser(user.id, { subscriptionStatus: "active" });
      return res.type('text/xml').send(`<Response><Message>Admin Bypass: ON ✅ You are now an active user. [STATE: none]</Message></Response>`);
    }
    if (cleanMsg === "BYPASS OFF") {
      await storage.updateUser(user.id, { subscriptionStatus: "inactive" });
      return res.type('text/xml').send(`<Response><Message>Admin Bypass: OFF ❌ Subscription required. [STATE: none]</Message></Response>`);
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
      return res.type('text/xml').send(`<Response><Message>To continue, subscribe here: ${paymentLink} [STATE: none]</Message></Response>`);
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

    const debugState = user.awaitingInputType ? ` [STATE: ${user.awaitingInputType}]` : " [STATE: none]";

    // ── Priority 8: RESET command ──
    if (cleanMsg === "RESET") {
      await storage.updateUser(user.id, { awaitingInputType: null });
      const menu = `Reset done. ${menuText}`;
      await storage.logChat(user.id, message, menu + " [STATE: none]", "COACH_RESET");
      return res.type('text/xml').send(`<Response><Message>${menu} [STATE: none]</Message></Response>`);
    }

    // ── Priority 9: STATE HANDLING (single-exit routing) ──
    if (user.awaitingInputType) {
      const inputType = user.awaitingInputType;

      if (inputType === "anything_else") {
        if (cleanMsg.includes("YES")) {
          await storage.updateUser(user.id, { awaitingInputType: "food" });
          const reply = "What did you eat?";
          return res.type('text/xml').send(`<Response><Message>${reply} [STATE: food]</Message></Response>`);
        } else if (cleanMsg.includes("NO") || cleanMsg === "MENU") {
          await storage.updateUser(user.id, { awaitingInputType: null });
          await storage.logChat(user.id, message, menuText + " [STATE: none]", "COACH_MENU");
          return res.type('text/xml').send(`<Response><Message>${menuText} [STATE: none]</Message></Response>`);
        } else {
          await storage.updateUser(user.id, { awaitingInputType: null });
          user.awaitingInputType = null;
          await storage.logChat(user.id, message, menuText + " [STATE: none]", "COACH_MENU");
          return res.type('text/xml').send(`<Response><Message>${menuText} [STATE: none]</Message></Response>`);
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

        let reaction = level === 1 ? "Perfect portion. " : `That's a lot of carbs. Your target is ${targetFists} fist(s) carbs per meal for fat loss. `;
        reaction += "What did you drink?";

        await storage.logChat(user.id, message, reaction + " [STATE: drink]", "PORTION_LOGGED");
        return res.type('text/xml').send(`<Response><Message>${reaction} [STATE: drink]</Message></Response>`);
      }

      if (inputType === "drink") {
        if (cleanMsg === "MENU") {
          await storage.updateUser(user.id, { awaitingInputType: null });
          await storage.logChat(user.id, message, menuText + " [STATE: none]", "COACH_MENU");
          return res.type('text/xml').send(`<Response><Message>${menuText} [STATE: none]</Message></Response>`);
        }
        const reply = "Nice! Hydration is key. Anything else to log? (yes/no)";
        await storage.updateUser(user.id, { awaitingInputType: "anything_else" });
        await storage.logChat(user.id, message, reply + " [STATE: anything_else]", "DRINK_LOGGED");
        return res.type('text/xml').send(`<Response><Message>${reply} [STATE: anything_else]</Message></Response>`);
      }

      if (inputType === "food" && !/^\d+$/.test(cleanMsg)) {
        if (cleanMsg === "MENU") {
          await storage.updateUser(user.id, { awaitingInputType: null });
          await storage.logChat(user.id, message, menuText + " [STATE: none]", "COACH_MENU");
          return res.type('text/xml').send(`<Response><Message>${menuText} [STATE: none]</Message></Response>`);
        }

        const parsing = parseFoodMessage(message);

        if (parsing.isDailyDump) {
          await storage.updateUser(user.id, { awaitingInputType: null });
          let reply = `Logged: ${parsing.mealHints.length || 1} meals, ${parsing.foods.length} items, ${parsing.drinks.length} drinks.`;

          if (parsing.carbItems.length > 0) {
            const carb = parsing.carbItems[0];
            await storage.updateUser(user.id, { awaitingInputType: "portion" });
            reply += `\nPortion check for ${carb}: 1 / 2 / 3+ fists`;
            return res.type('text/xml').send(`<Response><Message>${reply} [STATE: portion]</Message></Response>`);
          }

          await storage.logChat(user.id, message, reply + " [STATE: none]", "DAILY_DUMP_LOGGED");
          return res.type('text/xml').send(`<Response><Message>${reply} [STATE: none]</Message></Response>`);
        }

        const nothingWords = ["NOTHING", "DIDN'T EAT", "SKIPPED", "NO FOOD", "NONE"];
        if (nothingWords.some(word => cleanMsg.includes(word))) {
          await storage.updateUser(user.id, { awaitingInputType: null });
          const reply = "Skipping meals slows fat loss and causes cravings. Have 1 protein source now (2 eggs / yogurt / tinned fish). Reply DONE after eating.";
          await storage.logChat(user.id, message, reply + " [STATE: none]", "FOOD_SKIPPED");
          return res.type('text/xml').send(`<Response><Message>${reply} [STATE: none]</Message></Response>`);
        }

        if (parsing.carbItems.length > 0) {
          await storage.updateUser(user.id, { awaitingInputType: "portion" });
          const portionCheck = `Portion check for ${parsing.carbItems[0]}: how much was it?\n1) 1 fist\n2) 2 fists\n3) 3+ fists`;
          await storage.logChat(user.id, message, portionCheck + " [STATE: portion]", "PORTION_CHECK");
          return res.type('text/xml').send(`<Response><Message>${portionCheck} [STATE: portion]</Message></Response>`);
        }

        let advice = "Logged. ";
        if (parsing.proteinItems.length === 0) advice += "Add protein (eggs/chicken/beans) next time. ";

        if (parsing.drinks.length > 0) {
          await storage.updateUser(user.id, { awaitingInputType: "anything_else" });
          advice += "Anything else to log? (yes/no)";
          await storage.logChat(user.id, message, advice + " [STATE: anything_else]", "LOG_FOOD_FOLLOWUP");
          return res.type('text/xml').send(`<Response><Message>${advice} [STATE: anything_else]</Message></Response>`);
        } else {
          await storage.updateUser(user.id, { awaitingInputType: "drink" });
          advice += "What did you drink?";
          await storage.logChat(user.id, message, advice + " [STATE: drink]", "LOG_FOOD_FOLLOWUP");
          return res.type('text/xml').send(`<Response><Message>${advice} [STATE: drink]</Message></Response>`);
        }
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
          if (steps < 2000) reaction = "Firm push: You need to move. Do a 5-min walk now. Reply DONE.";
          else if (steps < 6000) reaction = "Good start. Try to squeeze in a 10-min walk later today.";
          else if (steps < (user.stepsTarget || 8000)) reaction = "Great work! Almost at your target. Keep pushing!";
          else reaction = "Amazing! You hit your target. Consistency is key.";
          const comparison = yesterdaySteps !== null ? `\nYesterday: ${yesterdaySteps} steps. Today: ${steps}.` : "";
          const reply = `${reaction}${comparison}`;
          await storage.logChat(user.id, message, reply + " [STATE: none]", "LOG_STEPS_FOLLOWUP");
          return res.type('text/xml').send(`<Response><Message>${reply} [STATE: none]</Message></Response>`);
        }
      }

      if (inputType === "sleep") {
        await storage.updateUser(user.id, { awaitingInputType: null });
        const sleepMatch = cleanMsg.match(/\d+/);
        const hours = sleepMatch ? parseInt(sleepMatch[0]) : null;
        if (hours !== null) {
          let reaction = "";
          if (hours < 5) reaction = "Warning: Lack of sleep can trigger cravings. Try to get to bed 30 mins earlier tonight.";
          else if (hours < 7) reaction = "Not bad, but try to aim for 7-8 hours for better recovery.";
          else reaction = "Perfect! Great sleep is the foundation of your progress.";
          await storage.logChat(user.id, message, reaction + " [STATE: none]", "LOG_SLEEP_FOLLOWUP");
          return res.type('text/xml').send(`<Response><Message>${reaction} [STATE: none]</Message></Response>`);
        }
      }

      if (inputType === "weight") {
        await storage.updateUser(user.id, { awaitingInputType: null });
        const weightMatch = cleanMsg.match(/\d+(\.\d+)?/);
        if (weightMatch) {
          const val = weightMatch[0];
          await storage.createWeightLog(user.id, val);
          await storage.updateUser(user.id, { currentWeight: val });
          const reply = `Logged ${val}kg! Consistency is what brings results. Keep it up!`;
          await storage.logChat(user.id, message, reply + " [STATE: none]", "LOG_WEIGHT_FOLLOWUP");
          return res.type('text/xml').send(`<Response><Message>${reply} [STATE: none]</Message></Response>`);
        }
      }
    }

    // ── Priority 9.5: ONBOARDING GUARD ──
    if (!user.onboardingState || user.onboardingState !== "COMPLETED") {
      const currentState = user.onboardingState || "AWAITING_NAME";
      let reply = "";

      if (currentState === "AWAITING_NAME") {
        await storage.updateUser(user.id, { name: message, onboardingState: "AWAITING_GOAL" });
        reply = `Thanks ${message}! What is your main fitness goal? (Fat Loss or Muscle Gain)`;
      } else if (currentState === "AWAITING_GOAL") {
        await storage.updateUser(user.id, { goalType: message, onboardingState: "AWAITING_WEIGHT" });
        reply = "Got it. What is your current weight in kg?";
      } else if (currentState === "AWAITING_WEIGHT") {
        await storage.updateUser(user.id, { currentWeight: message, onboardingState: "COMPLETED" });
        reply = "Onboarding complete! You can now log your steps, workouts, and weight daily. I'll check in with you every Sunday!";
      }

      if (reply) {
        await storage.logChat(user.id, message, reply + " [STATE: none]", "ONBOARDING");
        return res.type('text/xml').send(`<Response><Message>${reply} [STATE: none]</Message></Response>`);
      }
    }

    // ── Priority 10: INTENT ROUTING ──
    let detectedIntent: string | null = null;

    if (cleanMsg === "1") detectedIntent = "GET_WORKOUT";
    if (cleanMsg === "2") {
      await storage.updateUser(user.id, { awaitingInputType: "food" });
      return res.type('text/xml').send(`<Response><Message>What did you eat? [STATE: food]</Message></Response>`);
    }
    if (cleanMsg === "3") {
      await storage.updateUser(user.id, { awaitingInputType: "steps" });
      return res.type('text/xml').send(`<Response><Message>How many steps today? [STATE: steps]</Message></Response>`);
    }
    if (cleanMsg === "4") {
      await storage.updateUser(user.id, { awaitingInputType: "sleep" });
      return res.type('text/xml').send(`<Response><Message>How many hours did you sleep? [STATE: sleep]</Message></Response>`);
    }
    if (cleanMsg === "5") {
      await storage.updateUser(user.id, { awaitingInputType: "weight" });
      return res.type('text/xml').send(`<Response><Message>What is your weight today (kg)? [STATE: weight]</Message></Response>`);
    }
    if (cleanMsg === "6") detectedIntent = "SHOW_TARGETS";

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
      else if (/FOOD|MEAL|ATE|PAP|CHICKEN|OATS|BREAD/.test(cleanMsg)) detectedIntent = "LOG_FOOD";
      else if (/SLEEP|SLEPT/.test(cleanMsg)) detectedIntent = "LOG_SLEEP";
      else if (/WEIGHT|KG/.test(cleanMsg)) detectedIntent = "LOG_WEIGHT";
      else if (/TARGETS|MACROS|CALORIES/.test(cleanMsg)) detectedIntent = "SHOW_TARGETS";
      else if (cleanMsg === "DONE") detectedIntent = "WORKOUT_DONE";
      else if (foodEvidence) detectedIntent = "LOG_FOOD";

      if (/WHAT CAN I EAT|FOOD SUGGESTIONS|MEAL IDEAS/.test(cleanMsg)) {
        const advice = "For fat loss, focus on high-protein and fibre: \n- Oats or Eggs for breakfast\n- Grilled chicken or tinned fish with veg for lunch/dinner\n- Limit pap/rice to one fist size per meal.\nWhat are you planning to eat next?";
        await storage.logChat(user.id, message, advice + " [STATE: none]", "FOOD_ADVICE");
        return res.type('text/xml').send(`<Response><Message>${advice} [STATE: none]</Message></Response>`);
      }
    }

    console.log("INTENT:", detectedIntent);

    // ── Priority 11: INTENT HANDLERS ──

    if (detectedIntent === "LOG_FOOD") {
      const parsing = parseFoodMessage(message);

      if (parsing.isDailyDump) {
        let reply = `Logged: ${parsing.mealHints.length || 1} meals, ${parsing.foods.length} items, ${parsing.drinks.length} drinks.`;
        if (parsing.carbItems.length > 0) {
          const carb = parsing.carbItems[0];
          await storage.updateUser(user.id, { awaitingInputType: "portion" });
          reply += `\nPortion check for ${carb}: 1 / 2 / 3+ fists`;
          return res.type('text/xml').send(`<Response><Message>${reply} [STATE: portion]</Message></Response>`);
        }
        await storage.logChat(user.id, message, reply + " [STATE: none]", "DAILY_DUMP_LOGGED");
        return res.type('text/xml').send(`<Response><Message>${reply} [STATE: none]</Message></Response>`);
      }

      if (parsing.carbItems.length > 0) {
        await storage.updateUser(user.id, { awaitingInputType: "portion" });
        const portionCheck = `Portion check for ${parsing.carbItems[0]}: how much was it?\n1) 1 fist\n2) 2 fists\n3) 3+ fists`;
        await storage.logChat(user.id, message, portionCheck + " [STATE: portion]", "PORTION_CHECK");
        return res.type('text/xml').send(`<Response><Message>${portionCheck} [STATE: portion]</Message></Response>`);
      }

      let advice = "Got it! ";
      if (parsing.proteinItems.length === 0) advice += "Try adding some protein like eggs, chicken, or beans next time. ";

      if (parsing.drinks.length > 0) {
        advice += "Logged your food and drink. Anything else to log? (yes/no)";
        await storage.updateUser(user.id, { awaitingInputType: "anything_else" });
      } else {
        advice += "What did you drink today?";
        await storage.updateUser(user.id, { awaitingInputType: "drink" });
      }

      await storage.logChat(user.id, message, advice + debugState, "LOG_FOOD");
      return res.type('text/xml').send(`<Response><Message>${advice}${debugState}</Message></Response>`);
    }

    if (detectedIntent === "GET_WORKOUT") {
      const day = user.programDayIndex || 1;
      const workouts = {
        walk_only: ["Walk 10–20 minutes. Easy pace. Stop if dizzy.", "Walk 10–20 minutes.", "Walk 15–25 minutes."],
        home: ["Chair sit-to-stand 5–10 times. Wall push-ups 5–10. Walk 5–10 minutes.", "Walk 10–20 minutes.", "Chair sit-to-stand 5–10. Wall push-ups 5–10. March in place 2 minutes."],
        gym: ["Bike 10 min + Leg press 2 sets + Chest press 2 sets + Row 2 sets.", "Walk 10 min + Light full body circuit.", "Repeat Day 1."]
      };
      const mode = (user.trainingMode as keyof typeof workouts) || "home";
      const workout = workouts[mode][(day - 1) % 3];
      const reply = `Today is Day ${day}: ${workout}\nReply DONE when finished.`;
      await storage.logChat(user.id, message, reply + " [STATE: none]", "GET_WORKOUT");
      return res.type('text/xml').send(`<Response><Message>${reply} [STATE: none]</Message></Response>`);
    }

    if (detectedIntent === "LOG_STEPS") {
      const stepsMatch = cleanMsg.match(/\d+/);
      const steps = stepsMatch ? parseInt(stepsMatch[0]) : (cleanMsg.includes("NO STEPS") ? 0 : null);

      if (steps !== null) {
        await storage.createStepLog(user.id, steps);
        const prevLogs = await storage.getStepLogs(user.id);
        const yesterdaySteps = prevLogs.length > 1 ? prevLogs[1].steps : null;

        let reaction = "";
        if (steps < 2000) reaction = "Firm push: You need to move. Do a 5-min walk now. Reply DONE.";
        else if (steps < 6000) reaction = "Good start. Try to squeeze in a 10-min walk later today.";
        else if (steps < (user.stepsTarget || 8000)) reaction = "Great work! Almost at your target. Keep pushing!";
        else reaction = "Amazing! You hit your target. Consistency is key.";

        const comparison = yesterdaySteps !== null ? `\nYesterday: ${yesterdaySteps} steps. Today: ${steps}.` : "";
        const reply = `${reaction}${comparison}`;
        await storage.logChat(user.id, message, reply + " [STATE: none]", "LOG_STEPS");
        return res.type('text/xml').send(`<Response><Message>${reply} [STATE: none]</Message></Response>`);
      }
    }

    if (detectedIntent === "LOG_SLEEP") {
      const sleepMatch = cleanMsg.match(/\d+/);
      const hours = sleepMatch ? parseInt(sleepMatch[0]) : null;
      if (hours !== null) {
        let reaction = "";
        if (hours < 5) reaction = "Warning: Lack of sleep can trigger cravings. Try to get to bed 30 mins earlier tonight.";
        else if (hours < 7) reaction = "Not bad, but try to aim for 7-8 hours for better recovery.";
        else reaction = "Perfect! Great sleep is the foundation of your progress.";
        await storage.logChat(user.id, message, reaction + " [STATE: none]", "LOG_SLEEP");
        return res.type('text/xml').send(`<Response><Message>${reaction} [STATE: none]</Message></Response>`);
      }
    }

    if (detectedIntent === "LOG_WEIGHT") {
      const weightMatch = cleanMsg.match(/\d+(\.\d+)?/);
      if (weightMatch) {
        const val = weightMatch[0];
        await storage.createWeightLog(user.id, val);
        await storage.updateUser(user.id, { currentWeight: val });
        const reply = `Logged ${val}kg! Consistency is what brings results. Keep it up!`;
        await storage.logChat(user.id, message, reply + " [STATE: none]", "LOG_WEIGHT");
        return res.type('text/xml').send(`<Response><Message>${reply} [STATE: none]</Message></Response>`);
      }
    }

    if (detectedIntent === "SHOW_TARGETS") {
      const reply = `Your targets:\nCalories: ${user.calorieTarget || 2000}kcal\nProtein: ${user.proteinTarget || 150}g\nSteps: ${user.stepsTarget || 8000}`;
      await storage.logChat(user.id, message, reply + " [STATE: none]", "SHOW_TARGETS");
      return res.type('text/xml').send(`<Response><Message>${reply} [STATE: none]</Message></Response>`);
    }

    if (detectedIntent === "WORKOUT_DONE") {
      await storage.createWorkoutLog(user.id, true);
      let nextDay = (user.programDayIndex || 1) + 1;
      if (nextDay > 3) nextDay = 1;
      await storage.updateUser(user.id, { programDayIndex: nextDay });
      const reply = `Good job! Workout logged. Tomorrow is Day ${nextDay}. Small wins lead to big changes.`;
      await storage.logChat(user.id, message, reply + " [STATE: none]", "WORKOUT_DONE");
      return res.type('text/xml').send(`<Response><Message>${reply} [STATE: none]</Message></Response>`);
    }

    // ── Priority 12: DEFAULT ──
    await storage.logChat(user.id, message, menuText + " [STATE: none]", "COACH_MENU");
    return res.type('text/xml').send(`<Response><Message>${menuText} [STATE: none]</Message></Response>`);
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
            const workouts = {
              walk_only: ["Walk 10–20 minutes. Easy pace. Stop if dizzy.", "Walk 10–20 minutes.", "Walk 15–25 minutes."],
              home: ["Chair sit-to-stand 5–10 times. Wall push-ups 5–10. Walk 5–10 minutes.", "Walk 10–20 minutes.", "Chair sit-to-stand 5–10. Wall push-ups 5–10. March in place 2 minutes."],
              gym: ["Bike 10 min + Leg press 2 sets + Chest press 2 sets + Row 2 sets.", "Walk 10 min + Light full body circuit.", "Repeat Day 1."]
            };
            const mode = (user.trainingMode as keyof typeof workouts) || "home";
            const workout = workouts[mode][(day - 1) % 3];
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
            const workouts = {
              walk_only: ["Walk 10–20 minutes. Easy pace. Stop if dizzy.", "Walk 10–20 minutes.", "Walk 15–25 minutes."],
              home: ["Chair sit-to-stand 5–10 times. Wall push-ups 5–10. Walk 5–10 minutes.", "Walk 10–20 minutes.", "Chair sit-to-stand 5–10. Wall push-ups 5–10. March in place 2 minutes."],
              gym: ["Bike 10 min + Leg press 2 sets + Chest press 2 sets + Row 2 sets.", "Walk 10 min + Light full body circuit.", "Repeat Day 1."]
            };
            const mode = (user.trainingMode as keyof typeof workouts) || "home";
            const workout = workouts[mode][(day - 1) % 3];
            msg = `Morning ${user.name || "there"}. Today is Day ${day}: ${workout}. Reply DONE when finished.`;
          }
          console.log(`[SCHEDULE] Sending daily check-in to ${user.phoneNumber}`);
          await storage.logChat(user.id, "", msg, "DAILY_MORNING");
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

    return { score: totalScore, level };
  }

  // Weekly scheduler
  setInterval(async () => {
    const now = new Date();
    // Sunday 18:00
    if (now.getDay() === 0 && now.getHours() === 18 && now.getMinutes() === 0) {
      const users = await storage.getAllUsers();
      for (const user of users) {
        if (user.subscriptionStatus === "active") {
          const { score, level } = await calculateWeeklyCompliance(user.id);
          await storage.updateUser(user.id, { weeklyScore: score, complianceLevel: level });

          const report = `📊 *Weekly Compliance Report*\n\nScore: ${score}/100\nLevel: ${level}\n\n${
            level === "LOCKED IN" ? "Elite performance. Keep this intensity." :
            level === "CONSISTENT" ? "Solid work. You're building real momentum." :
            level === "BUILDING" ? "Room for improvement. Let's tighten up next week." :
            "Time to reset. We start again tomorrow. No excuses."
          }\n\nReply MENU to continue.`;

          console.log(`[SCHEDULE] Sending weekly report to ${user.phoneNumber}`);
          await storage.logChat(user.id, "", report, "WEEKLY_REPORT");
        }
      }
    }
  }, 60000);

  return httpServer;
}
