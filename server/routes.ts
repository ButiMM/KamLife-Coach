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

  app.post(api.webhooks.whatsapp.path, async (req, res) => {
    const { From, Body } = req.body;
    const phoneNumber = From;
    const message = Body;

    let user = await storage.getUserByPhone(phoneNumber);
    const paymentLink = "https://payfast.co.za/mock-pay";

    // Beta Tester Logic
    const betaTesters = (process.env.BETA_TESTERS || "").split(",").map(p => p.trim());
    const isBetaTester = betaTesters.includes(phoneNumber);

    if (!user && isBetaTester) {
      const bypassExpiry = new Date();
      bypassExpiry.setDate(bypassExpiry.getDate() + 14);
      user = await storage.createUser({
        phoneNumber,
        subscriptionStatus: "active",
        betaBypassUntil: bypassExpiry,
      });
      console.log(`[BETA BYPASS] Created new beta user: ${phoneNumber}, expires: ${bypassExpiry}`);
    } else if (user && isBetaTester && (!user.betaBypassUntil || new Date(user.betaBypassUntil) > new Date())) {
      if (user.subscriptionStatus !== "active") {
        const bypassExpiry = user.betaBypassUntil || new Date();
        if (!user.betaBypassUntil) {
          bypassExpiry.setDate(bypassExpiry.getDate() + 14);
        }
        await storage.updateUser(user.id, { 
          subscriptionStatus: "active",
          betaBypassUntil: bypassExpiry 
        });
        user.subscriptionStatus = "active";
        console.log(`[BETA BYPASS] Activated existing beta user: ${phoneNumber}, expires: ${bypassExpiry}`);
      }
    }

    if (!user) {
      return res.type('text/xml').send(`<Response><Message>Welcome to KamLife. Subscribe here: ${paymentLink}</Message></Response>`);
    }

    if (user.subscriptionStatus !== "active") {
      return res.type('text/xml').send(`<Response><Message>To continue, subscribe here: ${paymentLink}</Message></Response>`);
    }

    await storage.updateUser(user.id, { lastActiveAt: new Date() });
    const { intent, data } = await parseIntent(message);
    
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
