import { db } from "./db";
import {
  users, weightLogs, workoutLogs, stepLogs, weeklyCheckins, chatHistory,
  clothingCheckins, bodyMeasurements,
  type User, type InsertUser, type UpdateUserRequest,
  type WeightLog, type WorkoutLog, type StepLog,
  type WeeklyCheckin, type InsertWeeklyCheckin,
  type ChatLog,
  type ClothingCheckin, type InsertClothingCheckin,
  type BodyMeasurement, type InsertBodyMeasurement,
  type FlaggedUser
} from "@shared/schema";
import { eq, desc, and, gte, sql, inArray } from "drizzle-orm";

export interface IStorage {
  // User CRUD
  getUser(id: string): Promise<User | undefined>;
  getUserByPhone(phoneNumber: string): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: UpdateUserRequest): Promise<User>;

  // Logs
  getWeightLogs(userId: string): Promise<WeightLog[]>;
  getWorkoutLogs(userId: string): Promise<WorkoutLog[]>;
  getStepLogs(userId: string): Promise<StepLog[]>;
  
  createWeightLog(userId: string, weight: string): Promise<WeightLog>;
  createWorkoutLog(userId: string, completed: boolean): Promise<WorkoutLog>;
  createStepLog(userId: string, steps: number): Promise<StepLog>;

  // Weekly Checkins
  getWeeklyCheckins(userId: string): Promise<WeeklyCheckin[]>;
  createWeeklyCheckin(checkin: InsertWeeklyCheckin): Promise<WeeklyCheckin>;

  // Chat History
  logChat(userId: string, messageIn: string, messageOut: string, intent: string): Promise<ChatLog>;
  getChatHistory(userId: string, limit?: number): Promise<ChatLog[]>;

  // Referral
  getUserByReferralCode(code: string): Promise<User | undefined>;

  // Clothing Check-ins
  createClothingCheckin(checkin: InsertClothingCheckin): Promise<ClothingCheckin>;
  getClothingCheckins(userId: string): Promise<ClothingCheckin[]>;

  // Body Measurements
  createBodyMeasurement(measurement: InsertBodyMeasurement): Promise<BodyMeasurement>;
  getBodyMeasurements(userId: string): Promise<BodyMeasurement[]>;

  // Admin / Flagged
  getFlaggedUsers(): Promise<FlaggedUser[]>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByPhone(phoneNumber: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.phoneNumber, phoneNumber));
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(desc(users.createdAt));
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async updateUser(id: string, updates: UpdateUserRequest): Promise<User> {
    const [user] = await db.update(users).set({
      ...updates,
      lastActiveAt: updates.lastActiveAt || new Date()
    }).where(eq(users.id, id)).returning();
    return user;
  }

  async getWeightLogs(userId: string): Promise<WeightLog[]> {
    return await db.select().from(weightLogs).where(eq(weightLogs.userId, userId)).orderBy(desc(weightLogs.loggedAt));
  }

  async getWorkoutLogs(userId: string): Promise<WorkoutLog[]> {
    return await db.select().from(workoutLogs).where(eq(workoutLogs.userId, userId)).orderBy(desc(workoutLogs.loggedAt));
  }

  async getStepLogs(userId: string): Promise<StepLog[]> {
    return await db.select().from(stepLogs).where(eq(stepLogs.userId, userId)).orderBy(desc(stepLogs.loggedAt));
  }

  async createWeightLog(userId: string, weight: string): Promise<WeightLog> {
    const [log] = await db.insert(weightLogs).values({ userId, weight }).returning();
    return log;
  }

  async createWorkoutLog(userId: string, completed: boolean): Promise<WorkoutLog> {
    const [log] = await db.insert(workoutLogs).values({ userId, workoutCompleted: completed }).returning();
    return log;
  }

  async createStepLog(userId: string, steps: number): Promise<StepLog> {
    const [log] = await db.insert(stepLogs).values({ userId, steps }).returning();
    return log;
  }

  async getWeeklyCheckins(userId: string): Promise<WeeklyCheckin[]> {
    return await db.select().from(weeklyCheckins).where(eq(weeklyCheckins.userId, userId)).orderBy(desc(weeklyCheckins.weekStartDate));
  }

  async createWeeklyCheckin(checkin: InsertWeeklyCheckin): Promise<WeeklyCheckin> {
    const [newCheckin] = await db.insert(weeklyCheckins).values(checkin).returning();
    return newCheckin;
  }

  async logChat(userId: string, messageIn: string, messageOut: string, intent: string): Promise<ChatLog> {
    const [log] = await db.insert(chatHistory).values({
      userId,
      messageIn,
      messageOut,
      intent
    }).returning();
    return log;
  }

  async getChatHistory(userId: string, limitCount: number = 50): Promise<ChatLog[]> {
    return await db.select().from(chatHistory).where(eq(chatHistory.userId, userId)).orderBy(desc(chatHistory.createdAt)).limit(limitCount);
  }

  async getUserByReferralCode(code: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.referralCode, code));
    return user;
  }

  async createClothingCheckin(checkin: InsertClothingCheckin): Promise<ClothingCheckin> {
    const [result] = await db.insert(clothingCheckins).values(checkin).returning();
    return result;
  }

  async getClothingCheckins(userId: string): Promise<ClothingCheckin[]> {
    return await db.select().from(clothingCheckins).where(eq(clothingCheckins.userId, userId)).orderBy(desc(clothingCheckins.loggedAt));
  }

  async createBodyMeasurement(measurement: InsertBodyMeasurement): Promise<BodyMeasurement> {
    const [result] = await db.insert(bodyMeasurements).values(measurement).returning();
    return result;
  }

  async getBodyMeasurements(userId: string): Promise<BodyMeasurement[]> {
    return await db.select().from(bodyMeasurements).where(eq(bodyMeasurements.userId, userId)).orderBy(desc(bodyMeasurements.loggedAt));
  }

  async getFlaggedUsers(): Promise<FlaggedUser[]> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Single query: only active, onboarded users
    const activeUsers = await db.select().from(users).where(
      and(eq(users.subscriptionStatus, 'active'), eq(users.onboardingState, 'COMPLETE'))
    ).orderBy(desc(users.lastActiveAt));

    const flagged: FlaggedUser[] = [];
    const inactiveUsers: typeof activeUsers = [];
    const recentlyActiveUsers: typeof activeUsers = [];

    for (const user of activeUsers) {
      if (!user.lastActiveAt || new Date(user.lastActiveAt) < sevenDaysAgo) {
        flagged.push({
          ...user,
          flagReason: "inactive_7_days",
          lastLogDate: user.lastActiveAt ? user.lastActiveAt.toString() : null
        });
      } else {
        recentlyActiveUsers.push(user);
      }
    }

    // Batch fetch all checkins for recently-active users in one query
    if (recentlyActiveUsers.length > 0) {
      const userIds = recentlyActiveUsers.map(u => u.id);
      const allCheckins = await db.select().from(weeklyCheckins)
        .where(inArray(weeklyCheckins.userId, userIds))
        .orderBy(desc(weeklyCheckins.weekStartDate));

      // Group by userId
      const checkinsByUser = new Map<string, typeof allCheckins>();
      for (const c of allCheckins) {
        const list = checkinsByUser.get(c.userId) || [];
        list.push(c);
        checkinsByUser.set(c.userId, list);
      }

      for (const user of recentlyActiveUsers) {
        const checkins = checkinsByUser.get(user.id) || [];
        if (checkins.length >= 2) {
          const w1 = Number(checkins[0].weight);
          const w2 = Number(checkins[1].weight);
          if (w1 >= w2) {
            flagged.push({
              ...user,
              flagReason: "plateau_2_weeks",
              lastLogDate: user.lastActiveAt!.toString()
            });
          }
        }
      }
    }

    return flagged;
  }
}

export const storage = new DatabaseStorage();
