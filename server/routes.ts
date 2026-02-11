import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import OpenAI from "openai";
import { format } from "date-fns";

// Replit's OpenAI integration is pre-configured
const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

async function parseIntent(message: string): Promise<{ intent: string; data?: any; reply: string }> {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.1",
      messages: [
        {
          role: "system",
          content: `You are 'KamLife Coach', a fitness assistant.
          Analyze the user's message and extract data.
          Possible intents: 'LOG_STEPS', 'LOG_WEIGHT', 'SUBSCRIBE', 'STOP', 'CHAT'.
          
          If the user provides steps (e.g., "5000 steps"), intent is LOG_STEPS.
          If the user provides weight (e.g., "70kg"), intent is LOG_WEIGHT.
          If the user wants to join/pay, intent is SUBSCRIBE.
          If the user wants to quit, intent is STOP.
          Otherwise, intent is CHAT.
          
          Return JSON format: { "intent": "...", "data": { "steps": number, "weight": number }, "reply": "short friendly response" }
          The reply should be encouraging.`
        },
        { role: "user", content: message }
      ],
      response_format: { type: "json_object" }
    });

    const content = completion.choices[0].message.content || "{}";
    return JSON.parse(content);
  } catch (e) {
    console.error("OpenAI parse error:", e);
    return { intent: "CHAT", reply: "I'm having trouble understanding right now, but keep moving!" };
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // === ADMIN API ===
  app.get(api.users.list.path, async (req, res) => {
    const users = await storage.getAllUsers();
    res.json(users);
  });

  app.get(api.users.get.path, async (req, res) => {
    const user = await storage.getUser(Number(req.params.id));
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  });

  app.get(api.users.getLogs.path, async (req, res) => {
    const logs = await storage.getDailyLogs(Number(req.params.id));
    res.json(logs);
  });

  app.get(api.users.flagged.path, async (req, res) => {
    const flagged = await storage.getFlaggedUsers();
    res.json(flagged);
  });

  // === WEBHOOKS ===

  // WhatsApp Webhook (Twilio style)
  app.post(api.webhooks.whatsapp.path, async (req, res) => {
    const { From, Body } = req.body;
    const phoneNumber = From; // e.g., whatsapp:+27123456789
    const message = Body;

    console.log(`Received WhatsApp from ${phoneNumber}: ${message}`);

    let user = await storage.getUserByPhone(phoneNumber);
    if (!user) {
      // Create simplified user
      user = await storage.createUser({
        phoneNumber,
        name: "New User",
        subscriptionStatus: "inactive"
      });
    }

    // Parse Intent
    const { intent, data, reply } = await parseIntent(message);
    let finalReply = reply;

    // Handle Intent
    if (intent === "SUBSCRIBE") {
      finalReply = "Ready to transform? Click here to subscribe for R99/month: https://payfast.co.za/process?cmd=_paynow&receiver=YOUR_ID"; // Mock link
    } else if (intent === "STOP") {
      await storage.updateUser(user.id, { isActive: false });
      finalReply = "You've been unsubscribed. We'll miss you!";
    } else if (user.subscriptionStatus !== "active" && user.subscriptionStatus !== "trial") {
        // Paywall check
        finalReply = "You need an active subscription to use the coach. Please subscribe here: https://payfast.co.za/mock-link";
    } else {
        // Log Data if active
        if (intent === "LOG_STEPS" && data?.steps) {
            await storage.createDailyLog({
                userId: user.id,
                date: format(new Date(), 'yyyy-MM-dd'),
                steps: data.steps
            });
        }
        if (intent === "LOG_WEIGHT" && data?.weight) {
             await storage.createDailyLog({
                userId: user.id,
                date: format(new Date(), 'yyyy-MM-dd'),
                weight: String(data.weight)
            });
             await storage.updateUser(user.id, { currentWeight: String(data.weight) });
        }
    }

    // Log Chat
    await storage.logChat(user.id, message, finalReply, intent);

    // Send TwiML response
    res.type('text/xml');
    res.send(`
      <Response>
        <Message>${finalReply}</Message>
      </Response>
    `);
  });

  // PayFast Webhook (Mock)
  app.post(api.webhooks.payfast.path, async (req, res) => {
    // In a real app, verify signature and ip
    console.log("PayFast Webhook:", req.body);
    // Mock: find user by some ID in pass-through var and update
    res.sendStatus(200);
  });

  // Seed Data (if empty)
  await seedDatabase();

  // === SCHEDULER ===
  // Check every minute if it's Sunday 18:00
  setInterval(async () => {
    const now = new Date();
    // 0 = Sunday, 18 = 6 PM
    if (now.getDay() === 0 && now.getHours() === 18 && now.getMinutes() === 0) {
      console.log("Running Weekly Check-in...");
      const users = await storage.getAllUsers();
      for (const user of users) {
        if (user.subscriptionStatus === "active" && user.isActive) {
          // Send WhatsApp Message (Mocked here, but would use Twilio API)
          // In real implementation: await twilioClient.messages.create({ ... })
          console.log(`Sending check-in to ${user.phoneNumber}`);
          
          // Log intent to show interaction
          await storage.logChat(user.id, "", "It's check-in time! Please reply with your current weight and a photo if you like.", "WEEKLY_CHECKIN");
        }
      }
    }
  }, 60 * 1000);

  return httpServer;
}

async function seedDatabase() {
    const users = await storage.getAllUsers();
    if (users.length === 0) {
        console.log("Seeding database...");
        const user1 = await storage.createUser({
            phoneNumber: "whatsapp:+27111111111",
            name: "Thabo Mbeki",
            subscriptionStatus: "active",
            currentWeight: "85",
            weightGoal: "80"
        });
        
        const user2 = await storage.createUser({
            phoneNumber: "whatsapp:+27222222222",
            name: "Sarah Jones",
            subscriptionStatus: "inactive",
            currentWeight: "65",
            weightGoal: "60"
        });

        // Add logs for Thabo (Active)
        await storage.createDailyLog({ userId: user1.id, date: "2023-10-01", steps: 5000, weight: "85.0" });
        await storage.createDailyLog({ userId: user1.id, date: "2023-10-02", steps: 7000, weight: "84.8" });
        await storage.createDailyLog({ userId: user1.id, date: "2023-10-03", steps: 4000, weight: "84.9" });
        // He's doing okay

        // Add logs for Sarah (Inactive/Plateau dummy)
        await storage.createDailyLog({ userId: user2.id, date: "2023-09-01", steps: 2000, weight: "65.0" });
        // She hasn't logged in a month
        
        console.log("Database seeded!");
    }
}
