import { pgTable, text, serial, integer, boolean, timestamp, numeric, date } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// === TABLE DEFINITIONS ===

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull().unique(), // format: +27...
  name: text("name"),
  age: integer("age"),
  gender: text("gender"), // 'male', 'female', 'other'
  height: numeric("height"), // in cm
  weightGoal: numeric("weight_goal"), // in kg
  currentWeight: numeric("current_weight"), // in kg, updated from logs
  subscriptionStatus: text("subscription_status").default("inactive").notNull(), // 'active', 'inactive', 'trial'
  subscriptionExpiry: timestamp("subscription_expiry"),
  joinedAt: timestamp("joined_at").defaultNow(),
  onboardingStep: integer("onboarding_step").default(0), // 0=new, 1=name, 2=age, etc.
  isActive: boolean("is_active").default(true), // For soft delete or manual block
  timezone: text("timezone").default("Africa/Johannesburg"),
});

export const dailyLogs = pgTable("daily_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  date: date("date").notNull(), // YYYY-MM-DD
  steps: integer("steps").default(0),
  weight: numeric("weight"), // in kg
  workoutCompleted: boolean("workout_completed").default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const weeklyCheckins = pgTable("weekly_checkins", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  weekStartDate: date("week_start_date").notNull(),
  averageWeight: numeric("average_weight"),
  waistMeasurement: numeric("waist_measurement"), // cm
  coachFeedback: text("coach_feedback"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const chatHistory = pgTable("chat_history", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  messageIn: text("message_in"), // User's message
  messageOut: text("message_out"), // Bot's response
  intent: text("intent"), // Parsed intent from OpenAI
  createdAt: timestamp("created_at").defaultNow(),
});

// === RELATIONS ===

export const usersRelations = relations(users, ({ many }) => ({
  dailyLogs: many(dailyLogs),
  weeklyCheckins: many(weeklyCheckins),
  chatHistory: many(chatHistory),
}));

export const dailyLogsRelations = relations(dailyLogs, ({ one }) => ({
  user: one(users, {
    fields: [dailyLogs.userId],
    references: [users.id],
  }),
}));

export const weeklyCheckinsRelations = relations(weeklyCheckins, ({ one }) => ({
  user: one(users, {
    fields: [weeklyCheckins.userId],
    references: [users.id],
  }),
}));

export const chatHistoryRelations = relations(chatHistory, ({ one }) => ({
  user: one(users, {
    fields: [chatHistory.userId],
    references: [users.id],
  }),
}));

// === BASE SCHEMAS ===
export const insertUserSchema = createInsertSchema(users).omit({ id: true, joinedAt: true, isActive: true });
export const insertDailyLogSchema = createInsertSchema(dailyLogs).omit({ id: true, createdAt: true });
export const insertWeeklyCheckinSchema = createInsertSchema(weeklyCheckins).omit({ id: true, createdAt: true });

// === EXPLICIT API CONTRACT TYPES ===

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type DailyLog = typeof dailyLogs.$inferSelect;
export type InsertDailyLog = z.infer<typeof insertDailyLogSchema>;

export type WeeklyCheckin = typeof weeklyCheckins.$inferSelect;
export type InsertWeeklyCheckin = z.infer<typeof insertWeeklyCheckinSchema>;

export type ChatLog = typeof chatHistory.$inferSelect;

// Request Types
export type UpdateUserRequest = Partial<InsertUser>;

// Response Types
export type UserResponse = User;
export type UserListResponse = User[];
export type DailyLogResponse = DailyLog;
export type WeeklyCheckinResponse = WeeklyCheckin;

// Flagged User Type (for dashboard)
export interface FlaggedUser extends User {
  flagReason: "inactive_7_days" | "plateau_2_weeks";
  lastLogDate: string | null;
}
