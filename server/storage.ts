import { db } from "./db";
import {
  users, dailyLogs, weeklyCheckins, chatHistory,
  type User, type InsertUser, type UpdateUserRequest,
  type DailyLog, type InsertDailyLog,
  type WeeklyCheckin, type InsertWeeklyCheckin,
  type ChatLog,
  type FlaggedUser
} from "@shared/schema";
import { eq, desc, and, gte, sql } from "drizzle-orm";

export interface IStorage {
  // User CRUD
  getUser(id: number): Promise<User | undefined>;
  getUserByPhone(phoneNumber: string): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, updates: UpdateUserRequest): Promise<User>;

  // Daily Logs
  getDailyLogs(userId: number): Promise<DailyLog[]>;
  createDailyLog(log: InsertDailyLog): Promise<DailyLog>;
  getLastLog(userId: number): Promise<DailyLog | undefined>;

  // Weekly Checkins
  createWeeklyCheckin(checkin: InsertWeeklyCheckin): Promise<WeeklyCheckin>;

  // Chat History
  logChat(userId: number, messageIn: string, messageOut: string, intent: string): Promise<ChatLog>;

  // Admin / Flagged
  getFlaggedUsers(): Promise<FlaggedUser[]>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByPhone(phoneNumber: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.phoneNumber, phoneNumber));
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(desc(users.joinedAt));
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async updateUser(id: number, updates: UpdateUserRequest): Promise<User> {
    const [user] = await db.update(users).set(updates).where(eq(users.id, id)).returning();
    return user;
  }

  async getDailyLogs(userId: number): Promise<DailyLog[]> {
    return await db.select().from(dailyLogs)
      .where(eq(dailyLogs.userId, userId))
      .orderBy(desc(dailyLogs.date));
  }

  async createDailyLog(log: InsertDailyLog): Promise<DailyLog> {
    const [newLog] = await db.insert(dailyLogs).values(log).returning();
    return newLog;
  }

  async getLastLog(userId: number): Promise<DailyLog | undefined> {
    const [log] = await db.select().from(dailyLogs)
      .where(eq(dailyLogs.userId, userId))
      .orderBy(desc(dailyLogs.date))
      .limit(1);
    return log;
  }

  async createWeeklyCheckin(checkin: InsertWeeklyCheckin): Promise<WeeklyCheckin> {
    const [newCheckin] = await db.insert(weeklyCheckins).values(checkin).returning();
    return newCheckin;
  }

  async logChat(userId: number, messageIn: string, messageOut: string, intent: string): Promise<ChatLog> {
    const [log] = await db.insert(chatHistory).values({
      userId,
      messageIn,
      messageOut,
      intent
    }).returning();
    return log;
  }

  async getFlaggedUsers(): Promise<FlaggedUser[]> {
    // This is a simplified implementation. Real-world might need complex SQL or multiple queries.
    // For now, let's just get all users and filter in memory for simplicity in MVP, 
    // or use a smart query.
    
    // Let's use raw SQL for a more efficient query if needed, but for MVP:
    const allUsers = await this.getAllUsers();
    const flagged: FlaggedUser[] = [];

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    for (const user of allUsers) {
      if (user.subscriptionStatus !== 'active') continue;

      const lastLog = await this.getLastLog(user.id);
      
      // Check 1: Inactive > 7 days
      if (!lastLog || new Date(lastLog.date) < sevenDaysAgo) {
        flagged.push({
          ...user,
          flagReason: "inactive_7_days",
          lastLogDate: lastLog ? lastLog.date.toString() : null
        });
        continue;
      }

      // Check 2: Plateau (same weight for 2 weeks) - Simplified logic
      // Get last 14 logs
      const logs = await db.select().from(dailyLogs)
        .where(eq(dailyLogs.userId, user.id))
        .orderBy(desc(dailyLogs.date))
        .limit(14);
      
      if (logs.length >= 7) {
        // Very basic plateau check: variance is low? or simply no change?
        // Let's just check if max weight - min weight < 0.5kg in last 2 weeks
        const weights = logs.map(l => Number(l.weight)).filter(w => !isNaN(w) && w > 0);
        if (weights.length > 5) {
            const maxW = Math.max(...weights);
            const minW = Math.min(...weights);
            if ((maxW - minW) < 0.5) {
                 flagged.push({
                    ...user,
                    flagReason: "plateau_2_weeks",
                    lastLogDate: lastLog.date.toString()
                });
            }
        }
      }
    }

    return flagged;
  }
}

export const storage = new DatabaseStorage();
