import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { api } from "@shared/routes";
import { format } from "date-fns";

export function registerAdminTestRoutes(app: Express) {
  app.post(api.admin.runTest.path, async (req: Request, res: Response) => {
    const { testId, liveMode } = req.body;
    const logs: string[] = [];
    let dbChanges: any = {};
    let whatsappSent = "";

    const log = (msg: string) => {
      console.log(`[Test ${testId}] ${msg}`);
      logs.push(msg);
    };

    try {
      if (testId === 'A') {
        const phone = "whatsapp:+27000000001";
        log(`Simulating new user not subscribed: ${phone}`);
        const user = await storage.getUserByPhone(phone);
        if (user) await storage.updateUser(user.id, { subscriptionStatus: 'inactive' });
        
        // Mock incoming webhook
        const response = await fetch(`http://localhost:5000${api.webhooks.whatsapp.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ From: phone, Body: "Hello" })
        });
        whatsappSent = await response.text();
        log("Received WhatsApp response (TwiML)");
      } 
      
      else if (testId === 'B') {
        const phone = "whatsapp:+27111111111"; // Seeded active user
        log(`Simulating active user logs steps: ${phone}`);
        const user = await storage.getUserByPhone(phone);
        if (!user) throw new Error("Seed user not found");
        
        const response = await fetch(`http://localhost:5000${api.webhooks.whatsapp.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ From: phone, Body: "I did 7500 steps" })
        });
        whatsappSent = await response.text();
        const logs_data = await storage.getStepLogs(user.id);
        dbChanges = { stepLogs: logs_data[0] };
        log("Step log created and reply generated");
      }

      else if (testId === 'C') {
        const phone = "whatsapp:+27111111111";
        log(`Simulating missed workout: ${phone}`);
        const user = await storage.getUserByPhone(phone);
        if (!user) throw new Error("Seed user not found");

        const response = await fetch(`http://localhost:5000${api.webhooks.whatsapp.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ From: phone, Body: "I skipped gym" })
        });
        whatsappSent = await response.text();
        const logs_data = await storage.getWorkoutLogs(user.id);
        dbChanges = { workoutLogs: logs_data[0] };
        log("Workout log created (completed=false) and accountability reply generated");
      }

      else if (testId === 'D') {
        const phone = "whatsapp:+27111111111";
        log(`Simulating weekly check-in parse: ${phone}`);
        const user = await storage.getUserByPhone(phone);
        if (!user) throw new Error("Seed user not found");

        const response = await fetch(`http://localhost:5000${api.webhooks.whatsapp.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ From: phone, Body: "Weight 92, waist 95, workouts 3, steps 6500, hunger 6" })
        });
        whatsappSent = await response.text();
        const checkins = await storage.getWeeklyCheckins(user.id);
        dbChanges = { weeklyCheckin: checkins[0] };
        log("Weekly check-in created and rules engine triggered");
      }

      else if (testId === 'E') {
        const phone = "whatsapp:+27333333333";
        log("Simulating plateau...");
        let user = await storage.getUserByPhone(phone);
        if (!user) {
          user = await storage.createUser({
            phoneNumber: phone,
            name: "Plateau Test",
            subscriptionStatus: 'active',
            calorieTarget: 2000
          });
        } else {
          await storage.updateUser(user.id, { calorieTarget: 2000 });
        }

        // Insert 2 checkins with same weight
        await storage.createWeeklyCheckin({
          userId: user.id,
          weekStartDate: "2023-10-01",
          weight: "90",
          waistCm: "100",
          workoutsCompleted: 3,
          avgSteps: 7000,
          hungerScore: 5,
          autoAdjustmentNote: "",
          escalationFlag: false
        });

        const response = await fetch(`http://localhost:5000${api.webhooks.whatsapp.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ From: phone, Body: "Weight 90, waist 100, workouts 3, steps 7000, hunger 5" })
        });
        
        const updatedUser = await storage.getUser(user.id);
        const checkins = await storage.getWeeklyCheckins(user.id);
        dbChanges = { 
          oldCalorieTarget: 2000, 
          newCalorieTarget: updatedUser?.calorieTarget,
          adjustmentNote: checkins[0].autoAdjustmentNote 
        };
        whatsappSent = await response.text();
        log("Plateau detected: calories reduced");
      }

      else if (testId === 'F') {
        const phone = "whatsapp:+27444444444";
        log("Simulating inactivity...");
        let user = await storage.getUserByPhone(phone);
        const eightDaysAgo = new Date();
        eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
        
        if (!user) {
          user = await storage.createUser({
            phoneNumber: phone,
            name: "Inactivity Test",
            subscriptionStatus: 'active',
            lastActiveAt: eightDaysAgo
          });
        } else {
          await storage.updateUser(user.id, { lastActiveAt: eightDaysAgo });
        }

        const flagged = await storage.getFlaggedUsers();
        const isFlagged = flagged.some(u => u.id === user?.id);
        dbChanges = { lastActiveAt: eightDaysAgo, isFlagged };
        log(`Inactivity check complete. User flagged: ${isFlagged}`);
      }

      res.json({ success: true, logs, dbChanges, whatsappSent });
    } catch (err: any) {
      log(`Error: ${err.message}`);
      res.status(500).json({ success: false, logs, error: err.message });
    }
  });
}
