import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import OpenAI from "openai";
import { format } from "date-fns";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

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

  // Twilio WhatsApp Webhook
  app.post("/twilio/whatsapp", async (req, res) => {
    const { From, Body } = req.body;
    const phoneNumber = From;
    const message = Body || "";

    // CANARY v2
    const canaryMsg = message.trim().toUpperCase();
    if (canaryMsg === "PING") {
      return res.type('text/xml').send(`<Response><Message>PONG v2 ✅ Replit webhook live</Message></Response>`);
    }

    let user = await storage.getUserByPhone(phoneNumber);
    const paymentLink = "https://payfast.co.za/mock-pay";

    // Beta Tester Logic
    const betaTesters = (process.env.BETA_TESTERS || "").split(",").map(p => p.trim());
    const isBetaTester = betaTesters.includes(phoneNumber);

    // ADMIN BYPASS COMMANDS
    if (canaryMsg === "BYPASS ON") {
      if (user) {
        await storage.updateUser(user.id, { subscriptionStatus: "active" });
      } else {
        user = await storage.createUser({
          phoneNumber,
          subscriptionStatus: "active",
          onboardingState: "AWAITING_NAME"
        });
      }
      return res.type('text/xml').send(`<Response><Message>Admin Bypass: ON ✅ You are now an active user.</Message></Response>`);
    }
    if (canaryMsg === "BYPASS OFF") {
      if (user) {
        await storage.updateUser(user.id, { subscriptionStatus: "inactive" });
      }
      return res.type('text/xml').send(`<Response><Message>Admin Bypass: OFF ❌ Subscription required.</Message></Response>`);
    }

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
        return res.type('text/xml').send(`<Response><Message>Welcome to KamLife! Let's get started. What is your full name?</Message></Response>`);
      } else {
        return res.type('text/xml').send(`<Response><Message>Welcome to KamLife. Subscribe here: ${paymentLink}</Message></Response>`);
      }
    }

    if (user.subscriptionStatus !== "active" && !isBetaTester) {
      return res.type('text/xml').send(`<Response><Message>To continue, subscribe here: ${paymentLink}</Message></Response>`);
    }

    // Process Beta Bypass for existing inactive users
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

    await storage.updateUser(user.id, { lastActiveAt: new Date() });

    const cleanMsg = message.trim().toUpperCase();
    
    // 1) Logic Priority
    let detectedIntent = null;
    const menuKeywords = ["HI", "HELLO", "START", "HELP", "MENU"];
    if (menuKeywords.includes(cleanMsg)) detectedIntent = "COACH_MENU";

    // Map 1-6 to intents
    if (cleanMsg === "1") detectedIntent = "GET_WORKOUT";
    if (cleanMsg === "2") detectedIntent = "LOG_FOOD";
    if (cleanMsg === "3") detectedIntent = "LOG_STEPS";
    if (cleanMsg === "4") detectedIntent = "LOG_SLEEP";
    if (cleanMsg === "5") detectedIntent = "LOG_WEIGHT";
    if (cleanMsg === "6") detectedIntent = "SHOW_TARGETS";

    // Keyword mapping
    if (!detectedIntent) {
      if (/GYM|WORKOUT|PROGRAM|TRAINING/.test(cleanMsg)) detectedIntent = "GET_WORKOUT";
      if (/STEPS|WALK|NO STEPS/.test(cleanMsg)) detectedIntent = "LOG_STEPS";
      if (/FOOD|MEAL|ATE|PAP|CHICKEN|OATS|BREAD/.test(cleanMsg)) detectedIntent = "LOG_FOOD";
      if (/SLEEP|SLEPT/.test(cleanMsg)) detectedIntent = "LOG_SLEEP";
      if (/WEIGHT|KG/.test(cleanMsg)) detectedIntent = "LOG_WEIGHT";
      if (/TARGETS|MACROS|CALORIES/.test(cleanMsg)) detectedIntent = "SHOW_TARGETS";
      if (cleanMsg === "DONE") detectedIntent = "WORKOUT_DONE";
    }

    console.log("INTENT:", detectedIntent);

    // 2) Handle Intents
    if (detectedIntent === "COACH_MENU" || !detectedIntent) {
      // Onboarding Logic
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
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }

      const menu = `KamLife Coach ✅ What do you want to do?\n1) Today's workout\n2) Log food\n3) Log steps\n4) Log sleep\n5) Log weight\n6) Show my targets\nReply 1–6.`;
      await storage.logChat(user.id, message, menu, "COACH_MENU");
      return res.type('text/xml').send(`<Response><Message>${menu}</Message></Response>`);
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
        if (steps < 2000) reaction = "Firm push: You need to move. Do a 5-min walk now. Reply DONE.";
        else if (steps < 6000) reaction = "Good start. Try to squeeze in a 10-min walk later today.";
        else if (steps < (user.stepsTarget || 8000)) reaction = "Great work! Almost at your target. Keep pushing!";
        else reaction = "Amazing! You hit your target. Consistency is key.";

        const comparison = yesterdaySteps !== null ? `\nYesterday: ${yesterdaySteps} steps. Today: ${steps}.` : "";
        const reply = `${reaction}${comparison}`;
        await storage.logChat(user.id, message, reply, "LOG_STEPS");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    if (detectedIntent === "LOG_FOOD") {
      let advice = "Got it! ";
      if (/PAP|BREAD|RICE/.test(cleanMsg)) advice += "Try to keep the portion to about the size of your fist. ";
      if (!/CHICKEN|EGGS|FISH|BEANS|MEAT|PROTEIN/.test(cleanMsg)) advice += "Try adding some protein like eggs, chicken, or beans next time. ";
      advice += "What did you drink today?";
      await storage.logChat(user.id, message, advice, "LOG_FOOD");
      return res.type('text/xml').send(`<Response><Message>${advice}</Message></Response>`);
    }

    if (detectedIntent === "LOG_SLEEP") {
      const sleepMatch = cleanMsg.match(/\d+/);
      const hours = sleepMatch ? parseInt(sleepMatch[0]) : null;
      if (hours !== null) {
        let reaction = "";
        if (hours < 5) reaction = "Warning: Lack of sleep can trigger cravings. Try to get to bed 30 mins earlier tonight.";
        else if (hours < 7) reaction = "Not bad, but try to aim for 7-8 hours for better recovery.";
        else reaction = "Perfect! Great sleep is the foundation of your progress.";
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
        const reply = `Logged ${val}kg! Consistency is what brings results. Keep it up!`;
        await storage.logChat(user.id, message, reply, "LOG_WEIGHT");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    if (detectedIntent === "SHOW_TARGETS") {
      const reply = `Your targets:\nCalories: ${user.calorieTarget || 2000}kcal\nProtein: ${user.proteinTarget || 150}g\nSteps: ${user.stepsTarget || 8000}`;
      await storage.logChat(user.id, message, reply, "SHOW_TARGETS");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    if (detectedIntent === "WORKOUT_DONE") {
      await storage.createWorkoutLog(user.id, true);
      let nextDay = (user.programDayIndex || 1) + 1;
      if (nextDay > 3) nextDay = 1;
      await storage.updateUser(user.id, { programDayIndex: nextDay });
      const reply = `Good job! Workout logged. Tomorrow is Day ${nextDay}. Small wins lead to big changes.`;
      await storage.logChat(user.id, message, reply, "WORKOUT_DONE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }
  });

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
      // Check global kill switch
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

  app.post(api.webhooks.whatsapp.path, async (req, res) => {
    const { From, Body } = req.body;
    const phoneNumber = From;
    const message = Body || "";

    // CANARY v2
    const canaryMsg = message.trim().toUpperCase();
    if (canaryMsg === "PING") {
      return res.type('text/xml').send(`<Response><Message>PONG v2 ✅ Coach Brain is deployed</Message></Response>`);
    }
    if (canaryMsg === "MENU") {
      const menu = `KamLife Coach ✅ What do you want to do?\n1) Today's workout\n2) Log food\n3) Log steps\n4) Log sleep\n5) Log weight\n6) Show my targets\nReply 1–6.`;
      return res.type('text/xml').send(`<Response><Message>${menu}</Message></Response>`);
    }

    let user = await storage.getUserByPhone(phoneNumber);
    const paymentLink = "https://payfast.co.za/mock-pay";

    // Beta Tester Logic
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
        return res.type('text/xml').send(`<Response><Message>Welcome to KamLife! Let's get started. What is your full name?</Message></Response>`);
      } else {
        return res.type('text/xml').send(`<Response><Message>Welcome to KamLife. Subscribe here: ${paymentLink}</Message></Response>`);
      }
    }

    if (user.subscriptionStatus !== "active" && !isBetaTester) {
      return res.type('text/xml').send(`<Response><Message>To continue, subscribe here: ${paymentLink}</Message></Response>`);
    }

    // Process Beta Bypass for existing inactive users
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

    await storage.updateUser(user.id, { lastActiveAt: new Date() });

    const cleanMsg = message.trim().toUpperCase();
    
    // 1) Logic Priority
    let detectedIntent = null;
    const menuKeywords = ["HI", "HELLO", "START", "HELP", "MENU"];
    if (menuKeywords.includes(cleanMsg)) detectedIntent = "COACH_MENU";

    // Map 1-6 to intents
    if (cleanMsg === "1") detectedIntent = "GET_WORKOUT";
    if (cleanMsg === "2") detectedIntent = "LOG_FOOD";
    if (cleanMsg === "3") detectedIntent = "LOG_STEPS";
    if (cleanMsg === "4") detectedIntent = "LOG_SLEEP";
    if (cleanMsg === "5") detectedIntent = "LOG_WEIGHT";
    if (cleanMsg === "6") detectedIntent = "SHOW_TARGETS";

    // Keyword mapping
    if (!detectedIntent) {
      if (/GYM|WORKOUT|PROGRAM|TRAINING/.test(cleanMsg)) detectedIntent = "GET_WORKOUT";
      if (/STEPS|WALK|NO STEPS/.test(cleanMsg)) detectedIntent = "LOG_STEPS";
      if (/FOOD|MEAL|ATE|PAP|CHICKEN|OATS|BREAD/.test(cleanMsg)) detectedIntent = "LOG_FOOD";
      if (/SLEEP|SLEPT/.test(cleanMsg)) detectedIntent = "LOG_SLEEP";
      if (/WEIGHT|KG/.test(cleanMsg)) detectedIntent = "LOG_WEIGHT";
      if (/TARGETS|MACROS|CALORIES/.test(cleanMsg)) detectedIntent = "SHOW_TARGETS";
      if (cleanMsg === "DONE") detectedIntent = "WORKOUT_DONE";
    }

    console.log("INTENT:", detectedIntent);

    // 2) Handle Intents
    if (detectedIntent === "COACH_MENU" || !detectedIntent) {
      const menu = `KamLife Coach ✅ What do you want to do?\n1) Today's workout\n2) Log food\n3) Log steps\n4) Log sleep\n5) Log weight\n6) Show my targets\nReply 1–6.`;
      await storage.logChat(user.id, message, menu, "COACH_MENU");
      return res.type('text/xml').send(`<Response><Message>${menu}</Message></Response>`);
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
        if (steps < 2000) reaction = "Firm push: You need to move. Do a 5-min walk now. Reply DONE.";
        else if (steps < 6000) reaction = "Good start. Try to squeeze in a 10-min walk later today.";
        else if (steps < (user.stepsTarget || 8000)) reaction = "Great work! Almost at your target. Keep pushing!";
        else reaction = "Amazing! You hit your target. Consistency is key.";

        const comparison = yesterdaySteps !== null ? `\nYesterday: ${yesterdaySteps} steps. Today: ${steps}.` : "";
        const reply = `${reaction}${comparison}`;
        await storage.logChat(user.id, message, reply, "LOG_STEPS");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    if (detectedIntent === "LOG_FOOD") {
      let advice = "Got it! ";
      if (/PAP|BREAD|RICE/.test(cleanMsg)) advice += "Try to keep the portion to about the size of your fist. ";
      if (!/CHICKEN|EGGS|FISH|BEANS|MEAT|PROTEIN/.test(cleanMsg)) advice += "Try adding some protein like eggs, chicken, or beans next time. ";
      advice += "What did you drink today?";
      await storage.logChat(user.id, message, advice, "LOG_FOOD");
      return res.type('text/xml').send(`<Response><Message>${advice}</Message></Response>`);
    }

    if (detectedIntent === "LOG_SLEEP") {
      const sleepMatch = cleanMsg.match(/\d+/);
      const hours = sleepMatch ? parseInt(sleepMatch[0]) : null;
      if (hours !== null) {
        let reaction = "";
        if (hours < 5) reaction = "Warning: Lack of sleep can trigger cravings. Try to get to bed 30 mins earlier tonight.";
        else if (hours < 7) reaction = "Not bad, but try to aim for 7-8 hours for better recovery.";
        else reaction = "Perfect! Great sleep is the foundation of your progress.";
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
        const reply = `Logged ${val}kg! Consistency is what brings results. Keep it up!`;
        await storage.logChat(user.id, message, reply, "LOG_WEIGHT");
        return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    if (detectedIntent === "SHOW_TARGETS") {
      const reply = `Your targets:\nCalories: ${user.calorieTarget || 2000}kcal\nProtein: ${user.proteinTarget || 150}g\nSteps: ${user.stepsTarget || 8000}`;
      await storage.logChat(user.id, message, reply, "SHOW_TARGETS");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    if (detectedIntent === "WORKOUT_DONE") {
      await storage.createWorkoutLog(user.id, true);
      let nextDay = (user.programDayIndex || 1) + 1;
      if (nextDay > 3) nextDay = 1;
      await storage.updateUser(user.id, { programDayIndex: nextDay });
      const reply = `Good job! Workout logged. Tomorrow is Day ${nextDay}. Small wins lead to big changes.`;
      await storage.logChat(user.id, message, reply, "WORKOUT_DONE");
      return res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
    }

    const { intent, data } = await parseIntent(message);

    // Onboarding Logic
    if (intent === "onboarding_answer" || !user.onboardingState || user.onboardingState !== "COMPLETED") {
      const currentState = user.onboardingState || "AWAITING_NAME";
      let nextState = currentState;
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

      const coachingReply = await generateReply(message, intent, { user, onboarding: true });
      await storage.logChat(user.id, message, coachingReply, "onboarding");
      return res.type('text/xml').send(`<Response><Message>${coachingReply || reply}</Message></Response>`);
    }
    
    if (intent === "log_steps" && data?.steps) await storage.createStepLog(user.id, data.steps);
    if (intent === "log_weight" && data?.weight) {
      await storage.createWeightLog(user.id, String(data.weight));
      await storage.updateUser(user.id, { currentWeight: String(data.weight) });
    }
    if (intent === "log_workout") await storage.createWorkoutLog(user.id, data.completed ?? true);
    
    if (intent === "weekly_checkin_response") {
      const checkin = await storage.createWeeklyCheckin({
        userId: user.id,
        weekStartDate: format(new Date(), 'yyyy-MM-dd'),
        weight: data.weight ? String(data.weight) : user.currentWeight,
        waistCm: data.waist ? String(data.waist) : null,
        workoutsCompleted: data.workouts || 0,
        avgSteps: data.avg_steps || 0,
        hungerScore: data.hunger || 5,
        autoAdjustmentNote: "",
        escalationFlag: false
      });

      const { updatedTargets, adjustments, escalationFlag } = runRulesEngine(user, [], [checkin]);
      await storage.updateUser(user.id, {
        calorieTarget: updatedTargets.calorieTarget,
        stepsTarget: updatedTargets.stepsTarget,
        proteinTarget: updatedTargets.proteinTarget
      });
      await storage.createWeeklyCheckin({
        ...checkin,
        id: undefined, // Create a new entry or update existing? Let's update if we had a proper update method
        autoAdjustmentNote: adjustments.join(" "),
        escalationFlag
      } as any); // Simplified for MVP
    }

    const reply = await generateReply(message, intent, { user });
    await storage.logChat(user.id, message, reply, intent);

    console.log("PROVIDER DETECTED: Twilio");
    res.type('text/xml').send(`<Response><Message>${reply}</Message></Response>`);
  });

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

  // Weekly scheduler
  setInterval(async () => {
    const now = new Date();
    // Sunday 18:00
    if (now.getDay() === 0 && now.getHours() === 18 && now.getMinutes() === 0) {
      const users = await storage.getAllUsers();
      for (const user of users) {
        if (user.subscriptionStatus === "active") {
          console.log(`Sending check-in prompt to ${user.phoneNumber}`);
          // Mock send: await storage.logChat(user.id, "", "Time for your weekly check-in! Reply with weight, waist, workouts, and steps.", "CHECKIN_PROMPT");
        }
      }
    }
  }, 60000);

  return httpServer;
}
