import type { Express } from "express";
import { db } from "../db";
import { users, weightLogs, workoutLogs, stepLogs, chatHistory, escalations, abExperiments, abAssignments } from "../../shared/schema";
import { eq, desc, asc, and, gte, lt, sql, count } from "drizzle-orm";
import twilio from "twilio";
import { PRICING, calculateMRR, calculateARPU, calculateLTV, calculateTrialConversion } from "../../shared/pricing";
import { calculateTargets } from "../targets";
import { getDayType } from "../programme";
import { requireAdminKey } from "./auth";
import type { RouteDeps } from "./types";

export function registerDashboardRoutes(app: Express, deps: Pick<RouteDeps, "logChat">) {
  const { logChat } = deps;

  // ── Client list ──
  app.get("/api/dashboard/clients", requireAdminKey, async (req: any, res) => {
    try {
      const page = Math.max(0, parseInt(req.query.page as string) || 0);
      const limit = 200;
      const all = await db.select().from(users).where(eq(users.onboardingState, "COMPLETE")).orderBy(desc(users.lastActiveAt)).limit(limit).offset(page * limit);
      const now = Date.now();
      const weekAgo = new Date(now - 7 * 86400000);

      const result = await Promise.all(all.map(async (u) => {
        const thisWeekLogs = await db.select().from(chatHistory)
          .where(and(eq(chatHistory.userId, u.id), gte(chatHistory.createdAt, weekAgo)))
          .limit(50);
        const lastActive = u.lastActiveAt ? new Date(u.lastActiveAt).getTime() : 0;
        const sinceLastMsg = now - lastActive;
        const status = sinceLastMsg < 24 * 3600000 ? "green" : sinceLastMsg < 48 * 3600000 ? "yellow" : "red";
        const programmeDays = u.programmeStartDate
          ? Math.floor((now - new Date(u.programmeStartDate).getTime()) / 86400000) : 0;
        return {
          id: u.id,
          name: u.name,
          phone: u.phoneNumber,
          onboardingState: u.onboardingState,
          lastMessageAt: u.lastActiveAt,
          programmeDays,
          thisWeekLogCount: thisWeekLogs.length,
          status,
        };
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch clients" });
    }
  });

  // ── Single client detail ──
  app.get("/api/dashboard/client/:phone", requireAdminKey, async (req, res) => {
    try {
      const phoneParam = decodeURIComponent(req.params.phone);
      const [client] = await db.select().from(users).where(eq(users.phoneNumber, phoneParam)).limit(1);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000);
      const [weights, steps, workouts, chats] = await Promise.all([
        db.select().from(weightLogs).where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, fourteenDaysAgo))).orderBy(asc(weightLogs.loggedAt)),
        db.select().from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, fourteenDaysAgo))).orderBy(asc(stepLogs.loggedAt)),
        db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, fourteenDaysAgo))).orderBy(desc(workoutLogs.loggedAt)),
        db.select().from(chatHistory).where(eq(chatHistory.userId, client.id)).orderBy(desc(chatHistory.createdAt)).limit(100),
      ]);
      const liveTargets = calculateTargets(parseFloat(client.currentWeight || "75"), client.goalType || "fat_loss", client.lifeSituation || "office", client.trainingDaysPerWeek || 3);
      const programmeDays = client.programmeStartDate ? Math.floor((Date.now() - new Date(client.programmeStartDate).getTime()) / 86400000) : 0;

      res.json({ client, weightLogs: weights, stepLogs: steps, workoutLogs: workouts, chatHistory: chats, liveTargets, programmeDays });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch client" });
    }
  });

  // ── Metrics ──
  app.get("/api/dashboard/metrics", requireAdminKey, async (_req, res) => {
    try {
      const allComplete = await db.select().from(users).where(eq(users.onboardingState, "COMPLETE"));
      const now = Date.now();
      const weekAgo = new Date(now - 7 * 86400000);
      const twoWeeksAgo = new Date(now - 14 * 86400000);

      const activeClients = allComplete.length;
      const newThisWeek = allComplete.filter(u => u.createdAt && new Date(u.createdAt) >= weekAgo).length;
      const churnedThisWeek = allComplete.filter(u => u.lastActiveAt && new Date(u.lastActiveAt) < twoWeeksAgo).length;

      const allChats = await db.select().from(chatHistory).where(gte(chatHistory.createdAt, weekAgo));
      const avgMessagesPerDay = activeClients > 0 ? Math.round(allChats.length / 7 / activeClients * 10) / 10 : 0;

      const payingClients = allComplete.filter(u => u.subscriptionStatus === "active").length;
      const estimatedMRR = calculateMRR(payingClients);
      const trialClients = allComplete.filter(u => u.subscriptionStatus === "trial").length;

      res.json({
        computedAt: new Date().toISOString(),
        activeClients,
        payingClients,
        trialClients,
        newThisWeek,
        churnedThisWeek,
        avgMessagesPerClientPerDay: avgMessagesPerDay,
        estimatedMRR,
        currency: PRICING.currency,
        pricePerUser: PRICING.monthlyPriceZAR,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch metrics" });
    }
  });

  // ── Funnel metrics ──
  app.get("/api/dashboard/funnel", requireAdminKey, async (_req, res) => {
    try {
      const allUsers = await db.select().from(users);
      const now = Date.now();
      const sevenDays = 7 * 86_400_000;
      const thirtyDays = 30 * 86_400_000;

      const totalSignups = allUsers.length;
      const onboardingComplete = allUsers.filter(u => u.onboardingState === "COMPLETE").length;
      const firstWorkoutDone = allUsers.filter(u => (u.totalWorkoutsCompleted || 0) >= 1).length;
      const activeWeek1 = allUsers.filter(u => {
        if (!u.createdAt) return false;
        const age = now - new Date(u.createdAt).getTime();
        return age >= sevenDays && u.lastActiveAt && (now - new Date(u.lastActiveAt).getTime()) < sevenDays * 2;
      }).length;
      const signupsWithWeek1 = allUsers.filter(u => u.createdAt && (now - new Date(u.createdAt).getTime()) >= sevenDays).length;

      // Retention cohorts
      const d1Eligible = allUsers.filter(u => u.createdAt && (now - new Date(u.createdAt).getTime()) >= 86_400_000);
      const d1Retained = d1Eligible.filter(u => u.lastActiveAt && (now - new Date(u.lastActiveAt).getTime()) < now - new Date(u.createdAt!).getTime() + 86_400_000);
      const d7Eligible = allUsers.filter(u => u.createdAt && (now - new Date(u.createdAt).getTime()) >= sevenDays);
      const d7Retained = d7Eligible.filter(u => u.lastActiveAt && new Date(u.lastActiveAt) >= new Date(new Date(u.createdAt!).getTime() + sevenDays - 86_400_000));
      const d30Eligible = allUsers.filter(u => u.createdAt && (now - new Date(u.createdAt).getTime()) >= thirtyDays);
      const d30Retained = d30Eligible.filter(u => u.lastActiveAt && new Date(u.lastActiveAt) >= new Date(new Date(u.createdAt!).getTime() + thirtyDays - sevenDays));

      // At-risk breakdown
      const atRisk48h = allUsers.filter(u => u.onboardingState === "COMPLETE" && u.lastActiveAt && (now - new Date(u.lastActiveAt).getTime()) >= 2 * 86_400_000 && (now - new Date(u.lastActiveAt).getTime()) < 5 * 86_400_000).length;
      const atRisk5d = allUsers.filter(u => u.onboardingState === "COMPLETE" && u.lastActiveAt && (now - new Date(u.lastActiveAt).getTime()) >= 5 * 86_400_000 && (now - new Date(u.lastActiveAt).getTime()) < 14 * 86_400_000).length;
      const atRisk14d = allUsers.filter(u => u.onboardingState === "COMPLETE" && (!u.lastActiveAt || (now - new Date(u.lastActiveAt).getTime()) >= 14 * 86_400_000)).length;

      const payingClients = allUsers.filter(u => u.subscriptionStatus === "active").length;
      const trialUsers = allUsers.filter(u => u.subscriptionStatus === "trial").length;
      const inactiveUsers = allUsers.filter(u => u.subscriptionStatus === "inactive").length;
      const firstFoodLogged = allUsers.filter(u => (u.todayCalories || 0) > 0 || (u.totalWorkoutsCompleted || 0) >= 1).length;
      const churned = allUsers.filter(u =>
        u.onboardingState === "COMPLETE" &&
        u.subscriptionStatus === "inactive" &&
        u.cancelledAt
      ).length;

      // Avg workouts per client per week
      const activeClients = allUsers.filter(u => u.onboardingState === "COMPLETE" && u.lastActiveAt && (now - new Date(u.lastActiveAt).getTime()) < 7 * 86_400_000);
      const totalWorkoutsActiveClients = activeClients.reduce((sum, u) => sum + (u.totalWorkoutsCompleted || 0), 0);
      const avgWorkoutsPerWeek = activeClients.length > 0
        ? Math.round(totalWorkoutsActiveClients / activeClients.length / Math.max(1, activeClients.reduce((sum, u) => sum + Math.max(1, Math.floor((now - new Date(u.createdAt!).getTime()) / sevenDays)), 0) / activeClients.length) * 10) / 10
        : 0;

      // Avg messages per day (last 7 days)
      const weekAgo = new Date(now - sevenDays);
      const weekChats = await db.select({ c: count() }).from(chatHistory).where(gte(chatHistory.createdAt, weekAgo));
      const avgMessagesPerDay = activeClients.length > 0 ? Math.round((weekChats[0]?.c || 0) / 7 / activeClients.length * 10) / 10 : 0;

      res.json({
        computedAt: new Date().toISOString(),
        funnel: {
          totalSignups,
          onboardingComplete,
          firstFoodLogged,
          firstWorkoutDone,
          activeWeek1,
          signupsWithWeek1Data: signupsWithWeek1,
        },
        subscriptions: {
          trial: trialUsers,
          paying: payingClients,
          inactive: inactiveUsers,
          churned,
        },
        conversionRates: {
          signupToOnboard: totalSignups > 0 ? Math.round(onboardingComplete / totalSignups * 100) : 0,
          onboardToFirstWorkout: onboardingComplete > 0 ? Math.round(firstWorkoutDone / onboardingComplete * 100) : 0,
          firstWorkoutToWeek1: signupsWithWeek1 > 0 ? Math.round(activeWeek1 / signupsWithWeek1 * 100) : 0,
          trialToPaid: calculateTrialConversion(trialUsers, payingClients),
        },
        retention: {
          d1: { eligible: d1Eligible.length, retained: d1Retained.length, rate: d1Eligible.length > 0 ? Math.round(d1Retained.length / d1Eligible.length * 100) : 0 },
          d7: { eligible: d7Eligible.length, retained: d7Retained.length, rate: d7Eligible.length > 0 ? Math.round(d7Retained.length / d7Eligible.length * 100) : 0 },
          d30: { eligible: d30Eligible.length, retained: d30Retained.length, rate: d30Eligible.length > 0 ? Math.round(d30Retained.length / d30Eligible.length * 100) : 0 },
        },
        atRisk: { warning48h: atRisk48h, high5d: atRisk5d, severe14d: atRisk14d },
        engagement: { avgWorkoutsPerWeek, avgMessagesPerDay, activeClientsThisWeek: activeClients.length, payingClients },
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch funnel metrics" });
    }
  });

  // ── One-click intervention ──
  app.post("/api/dashboard/intervene", requireAdminKey, async (req, res) => {
    try {
      const { phone, type = "checkin" } = req.body;
      if (!phone) return res.status(400).json({ error: "phone required" });

      const targetUser = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
      if (targetUser.length === 0) return res.status(404).json({ error: "user not found" });
      const client = targetUser[0];
      const name = client.name || "there";
      const workouts = client.totalWorkoutsCompleted || 0;
      const week = client.programmeWeek || 1;

      const twilioClient2 = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
      const fromNum = process.env.TWILIO_WHATSAPP_NUMBER ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}` : "";
      if (!fromNum) return res.status(500).json({ error: "TWILIO_WHATSAPP_NUMBER not configured" });

      const messages: Record<string, string> = {
        checkin: `${name}, Coach K here. Haven't heard from you in a while — everything okay? No pressure, just checking in. Reply anything and we pick up where we left off.`,
        motivation: `${name}, ${workouts} sessions completed. Week ${week}. That is more than most people ever do. The programme is still here, your progress is saved. One session today changes the momentum.`,
        workout: `${name}, your next workout is ready. Reply *1* to see it — takes 20 minutes. One session. That is all I am asking for today.`,
        nutrition: `${name}, quick question — what did you eat today? Just tell me and I will give you the breakdown. No judgement. One message.`,
      };

      const msg = messages[type] || messages.checkin;
      await twilioClient2.messages.create({ from: fromNum, to: phone, body: msg });
      await logChat(client.id, `[COACH_INTERVENTION:${type}]`, msg, "COACH_INTERVENTION");

      res.json({ success: true, type, phone: phone.slice(-4) });
    } catch (err) {
      res.status(500).json({ error: "Failed to send intervention" });
    }
  });

  // ── Broadcast message ──
  app.post("/api/dashboard/broadcast", requireAdminKey, async (req, res) => {
    try {
      const { message: broadcastMsg, filter = "all" } = req.body;
      if (!broadcastMsg) return res.status(400).json({ error: "message is required" });

      const twilioClient2 = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
      const fromNum = process.env.TWILIO_WHATSAPP_NUMBER ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}` : "";
      if (!fromNum) return res.status(500).json({ error: "TWILIO_WHATSAPP_NUMBER not configured" });

      const allComplete = await db.select().from(users).where(eq(users.onboardingState, "COMPLETE"));
      const now = Date.now();
      const twoWeeksAgo = new Date(now - 14 * 86400000);
      const twoDaysAgo = new Date(now - 48 * 3600000);

      let targets = allComplete;
      if (filter === "active") targets = allComplete.filter(u => u.lastActiveAt && new Date(u.lastActiveAt) >= twoDaysAgo);
      if (filter === "atrisk") targets = allComplete.filter(u => !u.lastActiveAt || new Date(u.lastActiveAt) < twoDaysAgo);

      let sent = 0;
      let failed = 0;
      for (const u of targets) {
        try {
          await twilioClient2.messages.create({ from: fromNum, to: u.phoneNumber, body: broadcastMsg });
          sent++;
        } catch { failed++; }
      }
      res.json({ sent, failed, total: targets.length });
    } catch (err) {
      res.status(500).json({ error: "Broadcast failed" });
    }
  });

  // ── Client timeline ──
  app.get("/api/dashboard/timeline/:phone", requireAdminKey, async (req, res) => {
    try {
      const phoneParam = decodeURIComponent(req.params.phone);
      const [client] = await db.select().from(users).where(eq(users.phoneNumber, phoneParam)).limit(1);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
      const [weights, steps, workouts, chats] = await Promise.all([
        db.select({ weight: weightLogs.weight, date: weightLogs.loggedAt }).from(weightLogs)
          .where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, thirtyDaysAgo))).orderBy(asc(weightLogs.loggedAt)),
        db.select({ steps: stepLogs.steps, date: stepLogs.loggedAt }).from(stepLogs)
          .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, thirtyDaysAgo))).orderBy(asc(stepLogs.loggedAt)),
        db.select({ date: workoutLogs.loggedAt }).from(workoutLogs)
          .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, thirtyDaysAgo))).orderBy(asc(workoutLogs.loggedAt)),
        db.select({ date: chatHistory.createdAt, intent: chatHistory.intent, msgIn: chatHistory.messageIn, msgOut: chatHistory.messageOut })
          .from(chatHistory).where(and(eq(chatHistory.userId, client.id), gte(chatHistory.createdAt, thirtyDaysAgo)))
          .orderBy(desc(chatHistory.createdAt)).limit(200),
      ]);

      const events: { date: string; type: string; detail: string }[] = [];
      for (const w of weights) events.push({ date: new Date(w.date!).toISOString(), type: "weight", detail: `${w.weight}kg` });
      for (const s of steps) events.push({ date: new Date(s.date!).toISOString(), type: "steps", detail: `${s.steps} steps` });
      for (const wo of workouts) {
        const workoutDate = wo.date ? new Date(wo.date) : null;
        events.push({
          date: workoutDate?.toISOString() || new Date().toISOString(),
          type: "workout",
          detail: workoutDate ? getDayType(workoutDate.getDay()) : "session",
        });
      }
      for (const c of chats) events.push({ date: new Date(c.date!).toISOString(), type: "chat", detail: `[${c.intent}] ${(c.msgIn || "").slice(0, 80)}` });
      events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      const daysOnProgramme = client.programmeStartDate ? Math.floor((Date.now() - new Date(client.programmeStartDate).getTime()) / 86_400_000) : 0;
      const avgSteps = steps.length > 0 ? Math.round(steps.reduce((s, x) => s + (x.steps || 0), 0) / steps.length) : 0;
      const weightTrend = weights.length >= 2 ? parseFloat((parseFloat(String(weights[weights.length - 1].weight)) - parseFloat(String(weights[0].weight))).toFixed(1)) : 0;

      res.json({
        client: { name: client.name, phone: client.phoneNumber, goal: client.goalType, mode: client.trainingMode, week: client.programmeWeek, totalWorkouts: client.totalWorkoutsCompleted, streak: client.workoutStreak },
        summary: { daysOnProgramme, workoutsLast30: workouts.length, avgSteps, weightTrend, messagesLast30: chats.length },
        events: events.slice(0, 200),
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch timeline" });
    }
  });

  // ── Cohort analytics (monthly) ──
  app.get("/api/dashboard/cohorts", requireAdminKey, async (_req, res) => {
    try {
      const allUsers = await db.select({
        id: users.id, createdAt: users.createdAt, subscriptionStatus: users.subscriptionStatus,
        onboardingState: users.onboardingState, totalWorkoutsCompleted: users.totalWorkoutsCompleted, lastActiveAt: users.lastActiveAt,
      }).from(users);

      const now = Date.now();
      type CohortEntry = {
        month: string; signups: number; onboarded: number; paying: number;
        week1Active: number; week2Active: number; avgWorkouts: number;
      };
      const cohorts: Record<string, CohortEntry> = {};

      // For each user we need their chat activity — fetch all IDs with recent chat activity
      const sevenDaysActivity = new Map<string, boolean>();
      const fourteenDaysActivity = new Map<string, boolean>();
      try {
        const sevenAgo = new Date(now - 7 * 86_400_000);
        const fourteenAgo = new Date(now - 14 * 86_400_000);
        const recentActive = await db.select({ userId: chatHistory.userId, createdAt: chatHistory.createdAt })
          .from(chatHistory).where(gte(chatHistory.createdAt, fourteenAgo));
        for (const row of recentActive) {
          const uid = row.userId;
          const ms = new Date(row.createdAt || 0).getTime();
          if (ms >= sevenAgo.getTime()) sevenDaysActivity.set(uid, true);
          fourteenDaysActivity.set(uid, true);
        }
      } catch { /* non-fatal */ }

      for (const u of allUsers) {
        if (!u.createdAt) continue;
        const d = new Date(u.createdAt);
        const signupMs = d.getTime();
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!cohorts[key]) cohorts[key] = { month: key, signups: 0, onboarded: 0, paying: 0, week1Active: 0, week2Active: 0, avgWorkouts: 0 };
        cohorts[key].signups++;
        if (u.onboardingState === "COMPLETE") cohorts[key].onboarded++;
        if (u.subscriptionStatus === "active") cohorts[key].paying++;
        cohorts[key].avgWorkouts += u.totalWorkoutsCompleted || 0;

        // Week-1 retention: was this user active within 7 days of signup?
        // (use lastActiveAt as a proxy — more reliable than chat query per user)
        const lastActiveMs = u.lastActiveAt ? new Date(u.lastActiveAt).getTime() : 0;
        const daysSinceSignup = (now - signupMs) / 86_400_000;
        const daysSinceActive = lastActiveMs ? (now - lastActiveMs) / 86_400_000 : 999;

        // Only count users who've had at least 7 days to be "week 1"
        if (daysSinceSignup >= 7 && daysSinceActive <= 7) cohorts[key].week1Active++;
        // Week-2 retention: active within 14 days but signup was at least 14 days ago
        if (daysSinceSignup >= 14 && daysSinceActive <= 14) cohorts[key].week2Active++;
      }

      const result = Object.values(cohorts).map(c => {
        const eligible7 = Math.max(1, c.signups); // total who could have hit week 1
        const eligible14 = Math.max(1, c.signups);
        return {
          ...c,
          avgWorkouts: c.signups > 0 ? Math.round(c.avgWorkouts / c.signups * 10) / 10 : 0,
          onboardRate: c.signups > 0 ? Math.round(c.onboarded / c.signups * 100) : 0,
          payRate: c.signups > 0 ? Math.round(c.paying / c.signups * 100) : 0,
          week1RetentionRate: Math.round(c.week1Active / eligible7 * 100),
          week2RetentionRate: Math.round(c.week2Active / eligible14 * 100),
          // Legacy field — active in last 14 days (rolling)
          retentionRate: c.onboarded > 0 ? Math.round((c.week1Active + c.week2Active) / 2 / c.onboarded * 100) : 0,
        };
      }).sort((a, b) => a.month.localeCompare(b.month));

      res.json({ cohorts: result });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch cohorts" });
    }
  });

  // ── Next actions (auto-generated priorities) ──
  app.get("/api/dashboard/next-actions", requireAdminKey, async (_req, res) => {
    try {
      const now = Date.now();
      const twoDaysAgo = new Date(now - 2 * 86_400_000);
      const sevenDaysAgo = new Date(now - 7 * 86_400_000);
      const fourteenDaysAgo = new Date(now - 14 * 86_400_000);

      const allClients = await db.select({
        id: users.id, name: users.name, phoneNumber: users.phoneNumber,
        subscriptionStatus: users.subscriptionStatus, onboardingState: users.onboardingState,
        lastActiveAt: users.lastActiveAt, totalWorkoutsCompleted: users.totalWorkoutsCompleted,
        programmeWeek: users.programmeWeek, workoutStreak: users.workoutStreak,
        createdAt: users.createdAt, goalType: users.goalType, currentWeight: users.currentWeight,
      }).from(users);

      const actions: { phone: string; name: string; action: string; priority: "urgent" | "high" | "medium" | "low"; category: string }[] = [];

      for (const client of allClients) {
        const lastActive = client.lastActiveAt ? new Date(client.lastActiveAt) : null;
        const daysOnProgramme = client.createdAt ? Math.floor((now - new Date(client.createdAt).getTime()) / 86_400_000) : 0;
        const name = client.name || client.phoneNumber.slice(-4);

        if (client.onboardingState !== "COMPLETE" && daysOnProgramme >= 1) {
          actions.push({ phone: client.phoneNumber, name, action: "Hasn't completed onboarding — send welcome nudge", priority: "high", category: "onboarding" });
          continue;
        }
        if (client.subscriptionStatus === "active" && lastActive && lastActive < fourteenDaysAgo) {
          actions.push({ phone: client.phoneNumber, name, action: `Silent ${Math.floor((now - lastActive.getTime()) / 86_400_000)} days — high churn risk, call or send personal message`, priority: "urgent", category: "churn" });
          continue;
        }
        if (client.onboardingState === "COMPLETE" && lastActive && lastActive < sevenDaysAgo && lastActive >= fourteenDaysAgo) {
          actions.push({ phone: client.phoneNumber, name, action: `Silent ${Math.floor((now - lastActive.getTime()) / 86_400_000)} days — send re-engagement`, priority: "high", category: "engagement" });
          continue;
        }
        if (client.onboardingState === "COMPLETE" && (client.totalWorkoutsCompleted || 0) === 0 && daysOnProgramme >= 3) {
          actions.push({ phone: client.phoneNumber, name, action: "Onboarded but zero workouts — send first workout prompt", priority: "medium", category: "activation" });
        }
        if ((client.programmeWeek || 0) === 4 && (client.totalWorkoutsCompleted || 0) >= 8) {
          actions.push({ phone: client.phoneNumber, name, action: "Hitting week 4 milestone — send progress check + measurements reminder", priority: "low", category: "milestone" });
        }
        if ((client.workoutStreak || 0) === 0 && (client.totalWorkoutsCompleted || 0) >= 10 && lastActive && lastActive >= twoDaysAgo) {
          actions.push({ phone: client.phoneNumber, name, action: "Lost workout streak — motivational message to restart", priority: "medium", category: "streak" });
        }
      }

      const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
      actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

      res.json({ actions: actions.slice(0, 50), total: actions.length });
    } catch (err) {
      res.status(500).json({ error: "Failed to compute next actions" });
    }
  });

  // ── NPS dashboard ──
  app.get("/api/dashboard/nps", requireAdminKey, async (_req, res) => {
    try {
      const npsLogs = await db.select({ messageOut: chatHistory.messageOut, date: chatHistory.createdAt })
        .from(chatHistory)
        .where(eq(chatHistory.intent, "NPS_RATING"))
        .orderBy(desc(chatHistory.createdAt))
        .limit(200);

      let promoters = 0, passives = 0, detractors = 0;
      const scores: number[] = [];
      const recent: { score: number; date: string }[] = [];

      for (const log of npsLogs) {
        const scoreMatch = (log.messageOut || "").match(/NPS:\s*(\d+)/);
        if (scoreMatch) {
          const score = parseInt(scoreMatch[1]);
          scores.push(score);
          if (score >= 9) promoters++;
          else if (score >= 7) passives++;
          else detractors++;
          if (recent.length < 10) {
            recent.push({ score, date: log.date ? new Date(log.date).toLocaleDateString("en-ZA") : "" });
          }
        }
      }

      const totalResponses = scores.length;
      const npsScore = totalResponses > 0
        ? Math.round(((promoters - detractors) / totalResponses) * 100)
        : 0;
      const avgScore = totalResponses > 0
        ? (scores.reduce((a, b) => a + b, 0) / totalResponses).toFixed(1)
        : "0";

      res.json({ npsScore, avgScore: parseFloat(avgScore), totalResponses, promoters, passives, detractors, recent });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch NPS data" });
    }
  });

  // ── Escalation inbox ──
  app.post("/api/dashboard/escalations", requireAdminKey, async (req, res) => {
    try {
      const { phone, reason, triggerMessage, priority } = req.body;
      if (!phone || !reason) return res.status(400).json({ error: "phone and reason required" });
      const [client] = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const prio = priority || "normal";
      const slaHours: Record<string, number> = { urgent: 1, high: 4, normal: 24, low: 72 };
      const slaDeadline = new Date(Date.now() + (slaHours[prio] || 24) * 3_600_000);

      const [esc] = await db.insert(escalations).values({
        userId: client.id,
        reason,
        triggerMessage: triggerMessage || null,
        priority: prio,
        slaDeadline,
      }).returning();

      res.json({ success: true, escalation: esc });
    } catch (err) {
      res.status(500).json({ error: "Failed to create escalation" });
    }
  });

  app.get("/api/dashboard/escalations", requireAdminKey, async (req, res) => {
    try {
      const statusFilter = (req.query.status as string) || "open";
      const conditions = statusFilter === "all" ? [] : [eq(escalations.status, statusFilter)];

      const rows = await db.select({
        id: escalations.id, reason: escalations.reason, triggerMessage: escalations.triggerMessage,
        status: escalations.status, priority: escalations.priority, claimedBy: escalations.claimedBy,
        resolution: escalations.resolution, createdAt: escalations.createdAt, claimedAt: escalations.claimedAt,
        resolvedAt: escalations.resolvedAt, slaDeadline: escalations.slaDeadline,
        userName: users.name, userPhone: users.phoneNumber, userGoal: users.goalType,
      }).from(escalations)
        .leftJoin(users, eq(escalations.userId, users.id))
        .where(conditions.length > 0 ? conditions[0] : undefined)
        .orderBy(desc(escalations.createdAt))
        .limit(200);

      const now = Date.now();
      const enriched = rows.map(r => ({
        ...r,
        slaBreach: r.slaDeadline && r.status === "open" && new Date(r.slaDeadline).getTime() < now,
        slaRemaining: r.slaDeadline && r.status === "open"
          ? Math.max(0, Math.round((new Date(r.slaDeadline).getTime() - now) / 60_000))
          : null,
      }));

      res.json({ escalations: enriched });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch escalations" });
    }
  });

  app.post("/api/dashboard/escalations/:id/claim", requireAdminKey, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { claimedBy } = req.body;
      const [updated] = await db.update(escalations)
        .set({ status: "claimed", claimedBy: claimedBy || "Coach", claimedAt: new Date() })
        .where(eq(escalations.id, id))
        .returning();
      res.json({ success: true, escalation: updated });
    } catch (err) {
      res.status(500).json({ error: "Failed to claim escalation" });
    }
  });

  app.post("/api/dashboard/escalations/:id/resolve", requireAdminKey, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { resolution } = req.body;
      const [updated] = await db.update(escalations)
        .set({ status: "resolved", resolution: resolution || "Resolved", resolvedAt: new Date() })
        .where(eq(escalations.id, id))
        .returning();
      res.json({ success: true, escalation: updated });
    } catch (err) {
      res.status(500).json({ error: "Failed to resolve escalation" });
    }
  });

  // ── A/B testing engine ──
  app.post("/api/dashboard/ab/experiments", requireAdminKey, async (req, res) => {
    try {
      const { name, description, variantA, variantB, messageType } = req.body;
      if (!name || !variantA || !variantB || !messageType) return res.status(400).json({ error: "name, variantA, variantB, messageType required" });
      const [exp] = await db.insert(abExperiments).values({ name, description, variantA, variantB, messageType }).returning();
      res.json({ success: true, experiment: exp });
    } catch (err) {
      res.status(500).json({ error: "Failed to create experiment" });
    }
  });

  app.get("/api/dashboard/ab/experiments", requireAdminKey, async (_req, res) => {
    try {
      const exps = await db.select().from(abExperiments).orderBy(desc(abExperiments.createdAt));
      const enriched = await Promise.all(exps.map(async (exp) => {
        const assignments = await db.select({
          variant: abAssignments.variant, delivered: abAssignments.delivered, responded: abAssignments.responded,
        }).from(abAssignments).where(eq(abAssignments.experimentId, exp.id));

        const statsA = { sent: 0, delivered: 0, responded: 0 };
        const statsB = { sent: 0, delivered: 0, responded: 0 };
        for (const a of assignments) {
          const s = a.variant === "A" ? statsA : statsB;
          s.sent++;
          if (a.delivered) s.delivered++;
          if (a.responded) s.responded++;
        }
        return {
          ...exp, statsA, statsB,
          responseRateA: statsA.delivered > 0 ? Math.round(statsA.responded / statsA.delivered * 100) : 0,
          responseRateB: statsB.delivered > 0 ? Math.round(statsB.responded / statsB.delivered * 100) : 0,
        };
      }));
      res.json({ experiments: enriched });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch experiments" });
    }
  });

  app.post("/api/dashboard/ab/experiments/:id/status", requireAdminKey, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { status } = req.body;
      const updates: any = { status };
      if (status === "completed") updates.completedAt = new Date();
      const [updated] = await db.update(abExperiments).set(updates).where(eq(abExperiments.id, id)).returning();
      res.json({ success: true, experiment: updated });
    } catch (err) {
      res.status(500).json({ error: "Failed to update experiment" });
    }
  });

  // ── KPI reports ──
  app.get("/api/dashboard/kpis", requireAdminKey, async (req, res) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const since = new Date(Date.now() - days * 86400_000);

      const [totalUsers] = await db.select({ c: count() }).from(users);
      const [activeUsers] = await db.select({ c: count() }).from(users).where(gte(users.lastActiveAt, since));
      const [newUsers] = await db.select({ c: count() }).from(users).where(gte(users.createdAt, since));
      const [payingUsers] = await db.select({ c: count() }).from(users).where(eq(users.subscriptionStatus, "active"));

      const beforePeriod = new Date(since.getTime() - days * 86400_000);
      const [churned] = await db.select({ c: count() }).from(users)
        .where(and(gte(users.lastActiveAt, beforePeriod), lt(users.lastActiveAt, since)));

      const [totalMessages] = await db.select({ c: count() }).from(chatHistory).where(gte(chatHistory.createdAt, since));
      const [totalWorkouts] = await db.select({ c: count() }).from(workoutLogs).where(gte(workoutLogs.loggedAt, since));
      const [totalWeighIns] = await db.select({ c: count() }).from(weightLogs).where(gte(weightLogs.loggedAt, since));
      const [totalStepLogs] = await db.select({ c: count() }).from(stepLogs).where(gte(stepLogs.loggedAt, since));

      const avgMessages = (activeUsers.c || 0) > 0 ? Math.round((totalMessages.c || 0) / (activeUsers.c || 1)) : 0;
      const retentionRate = (totalUsers.c || 0) > 0 ? Math.round(((activeUsers.c || 0) / (totalUsers.c || 1)) * 100) : 0;
      const conversionRate = (totalUsers.c || 0) > 0 ? Math.round(((payingUsers.c || 0) / (totalUsers.c || 1)) * 100) : 0;
      const estimatedMRR = calculateMRR(payingUsers.c || 0);

      const engagedUsersQuery = await db.execute(
        sql`SELECT COUNT(DISTINCT user_id) as c FROM (
          SELECT user_id FROM workout_logs WHERE logged_at >= ${since}
          UNION SELECT user_id FROM weight_logs WHERE logged_at >= ${since}
          UNION SELECT user_id FROM step_logs WHERE logged_at >= ${since}
        ) engaged`
      );
      const engagedCount = Number(engagedUsersQuery.rows?.[0]?.c || 0);
      const engagementRate = (activeUsers.c || 0) > 0 ? Math.round((engagedCount / (activeUsers.c || 1)) * 100) : 0;

      const dauTrend: { date: string; count: number }[] = [];
      for (let i = 13; i >= 0; i--) {
        const dayStart = new Date(Date.now() - i * 86400_000);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart.getTime() + 86400_000);
        const [dau] = await db.select({ c: count() }).from(chatHistory)
          .where(and(gte(chatHistory.createdAt, dayStart), lt(chatHistory.createdAt, dayEnd)));
        dauTrend.push({ date: dayStart.toISOString().slice(0, 10), count: dau.c || 0 });
      }

      res.json({
        period: `${days} days`,
        users: { total: totalUsers.c || 0, active: activeUsers.c || 0, new: newUsers.c || 0, paying: payingUsers.c || 0, churned: churned.c || 0 },
        rates: { retention: `${retentionRate}%`, conversion: `${conversionRate}%`, engagement: `${engagementRate}%` },
        activity: { messages: totalMessages.c || 0, workouts: totalWorkouts.c || 0, weighIns: totalWeighIns.c || 0, stepLogs: totalStepLogs.c || 0, avgMessagesPerUser: avgMessages },
        revenue: { estimatedMRR: `R${estimatedMRR}`, payingUsers: payingUsers.c || 0 },
        dauTrend,
      });
    } catch (err) {
      console.error("[KPI] Error:", err);
      res.status(500).json({ error: "Failed to compute KPIs" });
    }
  });

  // ── Weekly cohort retention ──
  app.get("/api/dashboard/cohorts/weekly", requireAdminKey, async (req, res) => {
    try {
      const weeks = parseInt(req.query.weeks as string) || 8;
      const cohorts: { week: string; signups: number; retention: number[] }[] = [];

      for (let w = weeks - 1; w >= 0; w--) {
        const weekStart = new Date(Date.now() - (w + 1) * 7 * 86400_000);
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart.getTime() + 7 * 86400_000);

        const cohortUsers = await db.select({ id: users.id, lastActive: users.lastActiveAt })
          .from(users)
          .where(and(gte(users.createdAt, weekStart), lt(users.createdAt, weekEnd)));

        if (cohortUsers.length === 0) {
          cohorts.push({ week: weekStart.toISOString().slice(0, 10), signups: 0, retention: [] });
          continue;
        }

        const retention: number[] = [];
        for (let r = 1; r <= w + 1 && r <= 8; r++) {
          const checkStart = new Date(weekStart.getTime() + r * 7 * 86400_000);
          const activeInWeek = cohortUsers.filter(u => u.lastActive && new Date(u.lastActive) >= checkStart).length;
          retention.push(Math.round((activeInWeek / cohortUsers.length) * 100));
        }

        cohorts.push({ week: weekStart.toISOString().slice(0, 10), signups: cohortUsers.length, retention });
      }

      res.json({ cohorts });
    } catch (err) {
      console.error("[COHORT] Error:", err);
      res.status(500).json({ error: "Failed to compute cohorts" });
    }
  });

  // ── Weekly coach report ──
  app.get("/api/dashboard/weekly-report", requireAdminKey, async (req, res) => {
    try {
      const since = new Date(Date.now() - 7 * 86400_000);
      const allUsers = await db.select().from(users);

      const clientReports: any[] = [];
      for (const u of allUsers) {
        const [msgs] = await db.select({ c: count() }).from(chatHistory)
          .where(and(eq(chatHistory.userId, u.id), gte(chatHistory.createdAt, since)));
        const [wk] = await db.select({ c: count() }).from(workoutLogs)
          .where(and(eq(workoutLogs.userId, u.id), gte(workoutLogs.loggedAt, since)));
        const weights = await db.select({ weight: weightLogs.weight, date: weightLogs.loggedAt })
          .from(weightLogs).where(eq(weightLogs.userId, u.id)).orderBy(desc(weightLogs.loggedAt)).limit(2);

        const currentWeight = weights[0]?.weight || null;
        const prevWeight = weights[1]?.weight || null;
        const weightChange = currentWeight && prevWeight ? Number(currentWeight) - Number(prevWeight) : null;

        const [stps] = await db.select({ c: count() }).from(stepLogs)
          .where(and(eq(stepLogs.userId, u.id), gte(stepLogs.loggedAt, since)));

        const daysSinceLastMsg = u.lastActiveAt
          ? Math.round((Date.now() - new Date(u.lastActiveAt).getTime()) / 86400_000)
          : null;

        const risks: string[] = [];
        if (daysSinceLastMsg !== null && daysSinceLastMsg >= 3) risks.push("inactive_3d");
        if (daysSinceLastMsg !== null && daysSinceLastMsg >= 7) risks.push("inactive_7d");
        if ((msgs.c || 0) === 0) risks.push("no_messages");
        if ((wk.c || 0) === 0) risks.push("no_workouts");
        if (weightChange !== null && weightChange > 1) risks.push("weight_gain");

        let status = "on_track";
        if (risks.length >= 3) status = "at_risk";
        else if (risks.length >= 1) status = "needs_attention";

        clientReports.push({
          name: u.name || "Unknown", phone: u.phoneNumber, goal: u.goalType, status, risks,
          weekActivity: { messages: msgs.c || 0, workouts: wk.c || 0, stepLogs: stps.c || 0 },
          weight: { current: currentWeight ? Number(currentWeight) : null, change: weightChange ? Number(weightChange.toFixed(1)) : null },
          daysSinceLastMsg, paymentStatus: u.subscriptionStatus || "unknown",
        });
      }

      const statusOrder: Record<string, number> = { at_risk: 0, needs_attention: 1, on_track: 2 };
      clientReports.sort((a, b) => (statusOrder[a.status] || 2) - (statusOrder[b.status] || 2));

      const atRisk = clientReports.filter(c => c.status === "at_risk").length;
      const needsAttention = clientReports.filter(c => c.status === "needs_attention").length;
      const onTrack = clientReports.filter(c => c.status === "on_track").length;

      res.json({
        period: "Last 7 days",
        summary: { totalClients: clientReports.length, atRisk, needsAttention, onTrack },
        clients: clientReports,
      });
    } catch (err) {
      console.error("[WEEKLY REPORT] Error:", err);
      res.status(500).json({ error: "Failed to generate weekly report" });
    }
  });

  // ── Client search ──
  app.get("/api/dashboard/search", requireAdminKey, async (req, res) => {
    try {
      const q = (req.query.q as string || "").trim().toLowerCase();
      if (!q || q.length < 2) return res.json({ results: [] });

      const allUsers = await db.select({
        id: users.id, name: users.name, phone: users.phoneNumber,
        goal: users.goalType, payment: users.subscriptionStatus, lastActive: users.lastActiveAt,
      }).from(users).limit(500);

      const results = allUsers.filter(u =>
        (u.name || "").toLowerCase().includes(q) || (u.phone || "").includes(q)
      ).slice(0, 20);

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: "Search failed" });
    }
  });

  // ── Bulk message ──
  app.post("/api/dashboard/bulk-message", requireAdminKey, async (req, res) => {
    try {
      const { message, filter } = req.body;
      if (!message) return res.status(400).json({ error: "message required" });

      const filterType = filter || "all";
      let allUsers = await db.select({ id: users.id, phone: users.phoneNumber, lastActive: users.lastActiveAt, payment: users.subscriptionStatus }).from(users);

      const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);
      if (filterType === "active") allUsers = allUsers.filter(u => u.lastActive && new Date(u.lastActive) >= sevenDaysAgo);
      else if (filterType === "inactive") allUsers = allUsers.filter(u => !u.lastActive || new Date(u.lastActive) < sevenDaysAgo);
      else if (filterType === "paying") allUsers = allUsers.filter(u => u.payment === "active");
      else if (filterType === "at_risk") allUsers = allUsers.filter(u => u.lastActive && new Date(u.lastActive) < sevenDaysAgo && new Date(u.lastActive) >= new Date(Date.now() - 14 * 86400_000));

      const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
      let sent = 0, failed = 0;

      for (const u of allUsers) {
        if (!u.phone) continue;
        try {
          await twilioClient.messages.create({
            from: `whatsapp:${(process.env.TWILIO_WHATSAPP_NUMBER || "").replace(/^whatsapp:/, "")}`,
            to: u.phone.startsWith("whatsapp:") ? u.phone : `whatsapp:${u.phone}`,
            body: message,
          });
          sent++;
          await new Promise(r => setTimeout(r, 100));
        } catch { failed++; }
      }

      res.json({ success: true, sent, failed, total: allUsers.length });
    } catch (err) {
      console.error("[BULK MSG] Error:", err);
      res.status(500).json({ error: "Bulk message failed" });
    }
  });

  // ── Client notes ──
  app.post("/api/dashboard/clients/:phone/notes", requireAdminKey, async (req, res) => {
    try {
      const phone = req.params.phone;
      const { note } = req.body;
      if (!note) return res.status(400).json({ error: "note required" });

      const [client] = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const existingNotes = client.profileNotes || "";
      const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const updated = existingNotes + `\n[${timestamp}] ${note}`;

      await db.update(users).set({ profileNotes: updated.trim() }).where(eq(users.id, client.id));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to save note" });
    }
  });

  app.get("/api/dashboard/clients/:phone/notes", requireAdminKey, async (req, res) => {
    try {
      const phone = req.params.phone;
      const [client] = await db.select({ notes: users.profileNotes, name: users.name }).from(users)
        .where(eq(users.phoneNumber, phone)).limit(1);
      if (!client) return res.status(404).json({ error: "Client not found" });
      res.json({ name: client.name, notes: client.notes || "" });
    } catch (err) {
      res.status(500).json({ error: "Failed to get notes" });
    }
  });

  // ── Revenue dashboard ──
  app.get("/api/dashboard/revenue", requireAdminKey, async (req, res) => {
    try {
      const [paying] = await db.select({ c: count() }).from(users).where(eq(users.subscriptionStatus, "active"));
      const [trial] = await db.select({ c: count() }).from(users).where(eq(users.subscriptionStatus, "trial"));
      const [cancelled] = await db.select({ c: count() }).from(users).where(eq(users.subscriptionStatus, "inactive"));
      const [total] = await db.select({ c: count() }).from(users);

      const payingCount = paying.c || 0;
      const trialCount = trial.c || 0;
      const cancelledCount = cancelled.c || 0;
      const totalCount = total.c || 0;

      const mrr = calculateMRR(payingCount);
      const arr = mrr * 12;
      const trialConversion = calculateTrialConversion(trialCount, payingCount);
      const arpu = calculateARPU(payingCount);

      const estimatedMonthlyChurn = totalCount > 0
        ? Math.max(0.05, cancelledCount / Math.max(1, cancelledCount + payingCount))
        : 0.15;
      const estimatedLTV = calculateLTV(estimatedMonthlyChurn);

      const projectedNewPaying = Math.round(trialCount * trialConversion / 100);
      const projectedMRR = calculateMRR(payingCount + projectedNewPaying);

      const estimatedCostPerUser = 43;
      const grossProfit = mrr - (payingCount * estimatedCostPerUser);
      const grossMargin = mrr > 0 ? Math.round((grossProfit / mrr) * 100) : 0;

      res.json({
        computedAt: new Date().toISOString(),
        currency: PRICING.currency,
        pricePerUser: PRICING.monthlyPriceZAR,
        current: {
          mrr, mrrDisplay: `R${mrr.toLocaleString()}`,
          arr, arrDisplay: `R${arr.toLocaleString()}`,
          payingUsers: payingCount, trialUsers: trialCount, cancelledUsers: cancelledCount, totalUsers: totalCount,
        },
        unitEconomics: {
          arpu: PRICING.monthlyPriceZAR, estimatedLTV: Math.round(estimatedLTV),
          estimatedMonthlyChurn: Math.round(estimatedMonthlyChurn * 100),
          estimatedCostPerUser, grossProfit, grossMargin: `${grossMargin}%`,
        },
        rates: { trialConversion: `${trialConversion}%`, trialConversionRaw: trialConversion },
        forecast: { projectedNewPaying, projectedMRR, projectedMRRDisplay: `R${projectedMRR.toLocaleString()}` },
      });
    } catch (err) {
      console.error("[REVENUE] Error:", err);
      res.status(500).json({ error: "Failed to compute revenue" });
    }
  });
}
