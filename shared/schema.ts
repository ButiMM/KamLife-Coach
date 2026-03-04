import { pgTable, text, serial, integer, boolean, timestamp, numeric, date, uuid, index } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// === TABLE DEFINITIONS ===

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNumber: text("phone_number").notNull().unique(),
  name: text("name"),
  goalType: text("goal_type"), // fat_loss | muscle_gain
  age: integer("age"),
  heightCm: integer("height_cm"),
  currentWeight: numeric("current_weight"),
  trainingDaysPerWeek: integer("training_days_per_week"),
  budgetLevel: text("budget_level"), // low | medium | high
  calorieTarget: integer("calorie_target"),
  proteinTarget: integer("protein_target"),
  stepsTarget: integer("steps_target"),
  subscriptionStatus: text("subscription_status").default("inactive").notNull(), // active | inactive | trial
  onboardingState: text("onboarding_state"),
  betaBypassUntil: timestamp("beta_bypass_until"),
  lastActiveAt: timestamp("last_active_at"),
  trainingMode: text("training_mode").default("home"), // gym | home | walk_only
  programDayIndex: integer("program_day_index").default(1),
  awaitingInputType: text("awaiting_input_type"), // steps, food, drink, sleep, weight, portion
  weeklyScore: integer("weekly_score").default(0),
  complianceLevel: text("compliance_level").default("RESET"), // RESET | BUILDING | CONSISTENT | LOCKED IN
  carbPortionLevel: integer("carb_portion_level"), // 1, 2, 3
  referralCode: text("referral_code"),
  referredBy: text("referred_by"),
  injuries: text("injuries"),
  programmePhase: integer("programme_phase").default(1),
  programmeWeek: integer("programme_week").default(1),
  programmeDayInWeek: integer("programme_day_in_week").default(1),
  programmeStartDate: timestamp("programme_start_date"),
  trainingExperience: text("training_experience"),
  lastWorkoutDate: timestamp("last_workout_date"),
  totalWorkoutsCompleted: integer("total_workouts_completed").default(0),
  phaseReadyToAdvance: boolean("phase_ready_to_advance").default(false),
  homeEquipment: text("home_equipment"),
  lifeSituation: text("life_situation"),
  jobType: text("job_type"),
  activityLevel: text("activity_level"),
  primaryFocusArea: text("primary_focus_area"),
  baselineWeekActive: boolean("baseline_week_active").default(false),
  baselineWeekComplete: boolean("baseline_week_complete").default(false),
  profileNotes: text("profile_notes"),
  todayWater: numeric("today_water").default("0"),
  waterStreak: integer("water_streak").default(0),
  waterLastResetDate: text("water_last_reset_date"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow(),
  bmi: numeric("bmi"),
  medicalConditions: text("medical_conditions"),
  nutritionProtocol: text("nutrition_protocol"),
  mealTimingStrict: boolean("meal_timing_strict").default(false),
  doctorClearanceRequired: boolean("doctor_clearance_required").default(false),
  trainingLocation: text("training_location"),
  gymName: text("gym_name"),
  weeklyFoodBudget: text("weekly_food_budget"),
  workSchedule: text("work_schedule"),
  elderlyClient: boolean("elderly_client").default(false),
  awaitingProgrammeAnswers: boolean("awaiting_programme_answers").default(false),
  otherMedicalNotes: text("other_medical_notes"),
}, (table) => {
  return {
    phoneIdx: index("users_phone_idx").on(table.phoneNumber),
  };
});

export const weightLogs = pgTable("weight_logs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id),
  weight: numeric("weight").notNull(),
  loggedAt: timestamp("logged_at").defaultNow(),
}, (table) => {
  return {
    userWeightIdx: index("weight_logs_user_idx").on(table.userId),
  };
});

export const workoutLogs = pgTable("workout_logs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id),
  workoutCompleted: boolean("workout_completed").default(false),
  loggedAt: timestamp("logged_at").defaultNow(),
}, (table) => {
  return {
    userWorkoutIdx: index("workout_logs_user_idx").on(table.userId),
  };
});

export const stepLogs = pgTable("step_logs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id),
  steps: integer("steps").notNull(),
  loggedAt: timestamp("logged_at").defaultNow(),
}, (table) => {
  return {
    userStepIdx: index("step_logs_user_idx").on(table.userId),
  };
});

export const weeklyCheckins = pgTable("weekly_checkins", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id),
  weekStartDate: date("week_start_date").notNull(),
  weight: numeric("weight"),
  waistCm: numeric("waist_cm"),
  workoutsCompleted: integer("workouts_completed"),
  avgSteps: integer("avg_steps"),
  hungerScore: integer("hunger_score"),
  autoAdjustmentNote: text("auto_adjustment_note"),
  escalationFlag: boolean("escalation_flag").default(false),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => {
  return {
    userCheckinIdx: index("weekly_checkins_user_idx").on(table.userId),
  };
});

export const chatHistory = pgTable("chat_history", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  messageIn: text("message_in"),
  messageOut: text("message_out"),
  intent: text("intent"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const clothingCheckins = pgTable("clothing_checkins", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id),
  jeansFit: text("jeans_fit"),
  energyLevel: text("energy_level"),
  stomachFeel: text("stomach_feel"),
  overallFeel: text("overall_feel"),
  weekNumber: integer("week_number"),
  loggedAt: timestamp("logged_at").defaultNow(),
}, (table) => {
  return {
    userClothingIdx: index("clothing_checkins_user_idx").on(table.userId),
  };
});

export const bodyMeasurements = pgTable("body_measurements", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id),
  measurementType: text("measurement_type").notNull(),
  value: text("value").notNull(),
  loggedAt: timestamp("logged_at").defaultNow(),
}, (table) => {
  return {
    userMeasurementIdx: index("body_measurements_user_idx").on(table.userId),
  };
});

// For Replit AI Integrations compatibility
export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// === RELATIONS ===

export const usersRelations = relations(users, ({ many }) => ({
  weightLogs: many(weightLogs),
  workoutLogs: many(workoutLogs),
  stepLogs: many(stepLogs),
  weeklyCheckins: many(weeklyCheckins),
  chatHistory: many(chatHistory),
  clothingCheckins: many(clothingCheckins),
  bodyMeasurements: many(bodyMeasurements),
}));

export const chatHistoryRelations = relations(chatHistory, ({ one }) => ({
  user: one(users, { fields: [chatHistory.userId], references: [users.id] }),
}));

export const weightLogsRelations = relations(weightLogs, ({ one }) => ({
  user: one(users, { fields: [weightLogs.userId], references: [users.id] }),
}));

export const workoutLogsRelations = relations(workoutLogs, ({ one }) => ({
  user: one(users, { fields: [workoutLogs.userId], references: [users.id] }),
}));

export const stepLogsRelations = relations(stepLogs, ({ one }) => ({
  user: one(users, { fields: [stepLogs.userId], references: [users.id] }),
}));

export const weeklyCheckinsRelations = relations(weeklyCheckins, ({ one }) => ({
  user: one(users, { fields: [weeklyCheckins.userId], references: [users.id] }),
}));

export const clothingCheckinsRelations = relations(clothingCheckins, ({ one }) => ({
  user: one(users, { fields: [clothingCheckins.userId], references: [users.id] }),
}));

export const bodyMeasurementsRelations = relations(bodyMeasurements, ({ one }) => ({
  user: one(users, { fields: [bodyMeasurements.userId], references: [users.id] }),
}));

// === BASE SCHEMAS ===
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export const insertWeightLogSchema = createInsertSchema(weightLogs).omit({ id: true, loggedAt: true });
export const insertWorkoutLogSchema = createInsertSchema(workoutLogs).omit({ id: true, loggedAt: true });
export const insertStepLogSchema = createInsertSchema(stepLogs).omit({ id: true, loggedAt: true });
export const insertWeeklyCheckinSchema = createInsertSchema(weeklyCheckins).omit({ id: true, createdAt: true });
export const insertChatLogSchema = createInsertSchema(chatHistory).omit({ id: true, createdAt: true });
export const insertClothingCheckinSchema = createInsertSchema(clothingCheckins).omit({ id: true, loggedAt: true });
export const insertBodyMeasurementSchema = createInsertSchema(bodyMeasurements).omit({ id: true, loggedAt: true });

// === EXPLICIT API CONTRACT TYPES ===

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type WeightLog = typeof weightLogs.$inferSelect;
export type WorkoutLog = typeof workoutLogs.$inferSelect;
export type StepLog = typeof stepLogs.$inferSelect;
export type WeeklyCheckin = typeof weeklyCheckins.$inferSelect;
export type InsertWeeklyCheckin = z.infer<typeof insertWeeklyCheckinSchema>;
export type ChatLog = typeof chatHistory.$inferSelect;
export type ClothingCheckin = typeof clothingCheckins.$inferSelect;
export type InsertClothingCheckin = z.infer<typeof insertClothingCheckinSchema>;
export type BodyMeasurement = typeof bodyMeasurements.$inferSelect;
export type InsertBodyMeasurement = z.infer<typeof insertBodyMeasurementSchema>;

export type UpdateUserRequest = Partial<InsertUser>;
export type UserResponse = User;
export type UserListResponse = User[];

export interface FlaggedUser extends User {
  flagReason: "inactive_7_days" | "plateau_2_weeks";
  lastLogDate: string | null;
}
