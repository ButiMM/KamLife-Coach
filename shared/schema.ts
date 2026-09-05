import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  numeric,
  date,
  uuid,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// === TABLE DEFINITIONS ===

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    phoneNumber: text("phone_number").notNull().unique(),
    email: text("email"),
    name: text("name"),
    gender: text("gender"), // male | female
    goalType: text("goal_type"), // fat_loss | muscle_gain
    age: integer("age"),
    heightCm: integer("height_cm"),
    currentWeight: numeric("current_weight"),
    trainingDaysPerWeek: integer("training_days_per_week"),
    budgetLevel: text("budget_level"), // low | medium | high
    calorieTarget: integer("calorie_target"),
    // THE CURRENT number the client sees is calorie/protein/steps Target above — an OVERLAY,
    // recomputed each morning from the baseline below plus today's evidence. The baseline is the
    // client's PROFILE number: written by onboarding and programme rebuilds, never by the daily
    // adaptive job. Before 0005 the job read the stored target and wrote its own output back to
    // the same column, so adaptation compounded on itself — a compliant client was walked 12%
    // down in three days and then told their target "hasn't been tested yet".
    baselineCalorieTarget: integer("baseline_calorie_target"),
    baselineProteinTarget: integer("baseline_protein_target"),
    baselineStepsTarget: integer("baseline_steps_target"),
    proteinTarget: integer("protein_target"),
    stepsTarget: integer("steps_target"),
    subscriptionStatus: text("subscription_status")
      .default("inactive")
      .notNull(), // active | inactive | trial
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
    signupSource: text("signup_source"), // QR/marketing acquisition tag (gym, flyer, ig) — captured from the prefilled join message
    injuries: text("injuries"),
    // ── THE SIX DURABLE FACTS (2026-08-19, Cut 6→7) ──────────────────────────────────────
    // Beside injuries, medical_conditions, work_schedule, dream_goal and biggest_struggle,
    // which already existed. These are what the coach REMEMBERS about a person, as fields the
    // decision can read — not prose embedded into a vector store and recalled by similarity.
    // See migrations/0006_durable_client_facts.sql.
    dietaryRestrictions: text("dietary_restrictions"), // comma-separated, like medical_conditions
    lifeContext: text("life_context"),                 // night shifts, new baby, retrenched, moved
    doNotMention: text("do_not_mention"),              // topics the client asked us to drop
    // Monotonic version of accepted client context. Every turn increments this while holding
    // the user row lock, whether or not it changes a durable profile fact. Derived/model memory
    // is stamped with this revision so a slow older turn cannot overwrite newer truth.
    truthRevision: integer("truth_revision").notNull().default(0),
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
    // Physique read from the baseline progress photos (server/physique-analysis.ts):
    // comma-separated canonical muscle groups. laggingAreas drives targeted-volume
    // programming; both feed the brain snapshot so the coach references the real read.
    laggingAreas: text("lagging_areas"),
    dominantAreas: text("dominant_areas"),
    physiqueAnalysedAt: timestamp("physique_analysed_at"),
    baselineWeekActive: boolean("baseline_week_active").default(false),
    baselineWeekComplete: boolean("baseline_week_complete").default(false),
    profileNotes: text("profile_notes"),
    // Onboarding intelligence (2026-07-12): the personal intake Kam captures manually.
    dreamGoal: text("dream_goal"),           // their 3-month dream, in their own words
    biggestStruggle: text("biggest_struggle"), // consistency / nutrition / accountability…
    foodLikes: text("food_likes"),           // foods they love — build meals around these
    foodDislikes: text("food_dislikes"),     // foods they hate — never suggest these
    todayWater: numeric("today_water").default("0"),
    waterStreak: integer("water_streak").default(0),
    waterLastResetDate: text("water_last_reset_date"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").defaultNow(),
    bmi: numeric("bmi"),
    medicalConditions: text("medical_conditions"),
    nutritionProtocol: text("nutrition_protocol"),
    mealTimingStrict: boolean("meal_timing_strict").default(false),
    doctorClearanceRequired: boolean("doctor_clearance_required").default(
      false,
    ),
    trainingLocation: text("training_location"),
    gymName: text("gym_name"),
    weeklyFoodBudget: text("weekly_food_budget"),
    workSchedule: text("work_schedule"),
    elderlyClient: boolean("elderly_client").default(false),
    awaitingProgrammeAnswers: boolean("awaiting_programme_answers").default(
      false,
    ),
    otherMedicalNotes: text("other_medical_notes"),
    popiConsent: boolean("popi_consent").default(false),
    popiConsentAt: timestamp("popi_consent_at"),
    lastGoalCheckWeek: integer("last_goal_check_week").default(0),
    workoutStreak: integer("workout_streak").default(0),
    subscriptionRenewsAt: timestamp("subscription_renews_at"),
    paymentReference: text("payment_reference"), // PayFast payment/subscription ID
    todayCalories: integer("today_calories").default(0),
    todayCaloriesDate: text("today_calories_date"), // YYYY-MM-DD — reset daily
    todayProteinG: integer("today_protein_g").default(0),
    buddyId: uuid("buddy_id"), // accountability partner — mutual pairing
    buddyPairedAt: timestamp("buddy_paired_at"),
    targetWeightKg: numeric("target_weight_kg"), // stated goal weight
    dietBreakEndsAt: timestamp("diet_break_ends_at"), // null = not on break
    dietBreakCalTarget: integer("diet_break_cal_target"), // saved cal target before break
  },
  (table) => {
    return {
      phoneIdx: index("users_phone_idx").on(table.phoneNumber),
      subOnboardIdx: index("users_sub_onboard_idx").on(
        table.subscriptionStatus,
        table.onboardingState,
      ),
    };
  },
);

export const weightLogs = pgTable(
  "weight_logs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    weight: numeric("weight").notNull(),
    loggedAt: timestamp("logged_at").defaultNow(),
  },
  (table) => {
    return {
      userWeightIdx: index("weight_logs_user_idx").on(table.userId, table.loggedAt),
    };
  },
);

export const workoutLogs = pgTable(
  "workout_logs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workoutCompleted: boolean("workout_completed").default(false),
    loggedAt: timestamp("logged_at").defaultNow(),
  },
  (table) => {
    return {
      userWorkoutIdx: index("workout_logs_user_idx").on(table.userId, table.loggedAt),
    };
  },
);

export const stepLogs = pgTable(
  "step_logs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    steps: integer("steps").notNull(),
    loggedAt: timestamp("logged_at").defaultNow(),
  },
  (table) => {
    return {
      userStepIdx: index("step_logs_user_idx").on(table.userId, table.loggedAt),
    };
  },
);

// Structured meal log — numeric columns replace regex-parsing bot chat text.
// Every food log goes here (SA scanner + GPT-fallback + photo). Readers SUM columns.
export const mealLogs = pgTable(
  "meal_logs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    loggedAt: timestamp("logged_at").defaultNow().notNull(),
    rawMessage: text("raw_message"),            // what user sent
    source: text("source").notNull(),           // 'sa_scanner' | 'gpt_fallback' | 'photo' | 'retro'
    kcalInt: integer("kcal_int").notNull().default(0),
    proteinInt: integer("protein_int").notNull().default(0),
    carbsInt: integer("carbs_int").notNull().default(0),
    fatInt: integer("fat_int").notNull().default(0),
    // items: array of { name, grams?, kcal, protein, carbs?, fat? }
    items: jsonb("items"),
    mealLabel: text("meal_label"),              // 'breakfast' | 'lunch' | 'dinner' | 'snack' | null
    corrected: boolean("corrected").notNull().default(false),
    // EVENT LINEAGE (0004). Rows sharing this are ONE client utterance. A message naming four
    // meals writes four rows; they stay individually correctable while remaining undoable as the
    // one thing the client said. NULL = logged before lineage existed, and NOT backfilled —
    // a legacy row is genuinely a group of one, which is what it always was.
    sourceMessageId: text("source_message_id"),
  },
  (table) => {
    return {
      userDateIdx: index("meal_logs_user_date_idx").on(table.userId, table.loggedAt),
      userSourceMsgIdx: index("meal_logs_user_source_msg_idx").on(table.userId, table.sourceMessageId),
    };
  },
);

export const weeklyCheckins = pgTable(
  "weekly_checkins",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    weekStartDate: date("week_start_date").notNull(),
    weight: numeric("weight"),
    waistCm: numeric("waist_cm"),
    workoutsCompleted: integer("workouts_completed"),
    avgSteps: integer("avg_steps"),
    hungerScore: integer("hunger_score"),
    autoAdjustmentNote: text("auto_adjustment_note"),
    escalationFlag: boolean("escalation_flag").default(false),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => {
    return {
      userCheckinIdx: index("weekly_checkins_user_idx").on(table.userId),
    };
  },
);

export const chatHistory = pgTable("chat_history", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  messageIn: text("message_in"),
  messageOut: text("message_out"),
  intent: text("intent"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userDateIdx: index("chat_history_user_date_idx").on(table.userId, table.createdAt),
  userIntentIdx: index("chat_history_user_intent_idx").on(table.userId, table.intent, table.createdAt),
}));

/**
 * TURN LEDGER — the forensic record of one conversational turn (2026-08-10 directive, §6).
 *
 * Not Pulse, not a router, not a new architecture: observability only. chat_history keeps the
 * CONVERSATION (what was said); this keeps the MECHANISM (why it was said), because when Coach K
 * gets something wrong the question is never "what did it reply" — it is whether it misunderstood
 * the client, held the wrong state, reasoned badly, mutated the wrong row, or communicated poorly.
 * Today those five answers can only be reconstructed by re-reading server logs, if they still
 * exist. A turn is not a chat row — one turn can write several chat rows or none — so it gets its
 * own id and its own row rather than columns bolted onto chat_history.
 *
 * Everything except the user, the input and the reply is nullable on purpose: a turn that fails
 * early must still leave a record, and a half-written ledger row is worth more than none.
 */
export const turnLedger = pgTable("turn_ledger", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
  inputType: text("input_type"),          // text | photo | voice | video
  inputText: text("input_text"),          // the raw message, or the transcript for voice
  resolvedDay: text("resolved_day"),      // the SAST day the turn resolved to (parseMealDate)
  stateRead: jsonb("state_read"),         // the facts the turn actually read before deciding
  mutations: jsonb("mutations"),          // every write, in order, as the writers reported them
  reply: text("reply"),
  replyMs: integer("reply_ms"),
  version: text("version"),               // the build that produced this turn
  failureCategory: text("failure_category"), // STATE | UNDERSTANDING | REASONING | ACTION | RESPONSE
  // THE VERDICT AND ITS LIFECYCLE (2026-08-25). failureCategory says what KIND of failure a human
  // judged this to be; lifecycleStatus says how far the fix has actually got. "fixed" is a claim
  // about a diff and "deployed" a claim about a build — only "revalidated" means this turn was
  // replayed against the build that shipped and behaved. Every recurrence we traced stopped short
  // of that last step.
  lifecycleStatus: text("lifecycle_status"), // observed | confirmed | fixed | deployed | revalidated
  fixRef: text("fix_ref"),                   // the PR or commit claiming the fix
  triageNote: text("triage_note"),           // why the human classified it that way
  triagedAt: timestamp("triaged_at"),
}, (table) => ({
  userDateIdx: index("turn_ledger_user_date_idx").on(table.userId, table.createdAt),
  createdIdx: index("turn_ledger_created_idx").on(table.createdAt),
  versionIdx: index("turn_ledger_version_idx").on(table.version),
  failureIdx: index("turn_ledger_failure_idx").on(table.failureCategory),
  lifecycleIdx: index("turn_ledger_lifecycle_idx").on(table.lifecycleStatus),
}));

export const clothingCheckins = pgTable(
  "clothing_checkins",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    jeansFit: text("jeans_fit"),
    energyLevel: text("energy_level"),
    stomachFeel: text("stomach_feel"),
    overallFeel: text("overall_feel"),
    weekNumber: integer("week_number"),
    loggedAt: timestamp("logged_at").defaultNow(),
  },
  (table) => {
    return {
      userClothingIdx: index("clothing_checkins_user_idx").on(table.userId),
    };
  },
);

export const bodyMeasurements = pgTable(
  "body_measurements",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    measurementType: text("measurement_type").notNull(),
    value: text("value").notNull(),
    loggedAt: timestamp("logged_at").defaultNow(),
  },
  (table) => {
    return {
      userMeasurementIdx: index("body_measurements_user_idx").on(table.userId, table.loggedAt),
    };
  },
);

export const exerciseLogs = pgTable(
  "exercise_logs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    exerciseName: text("exercise_name").notNull(),
    weightKg: numeric("weight_kg"),
    reps: integer("reps"),
    sets: integer("sets"),
    loggedAt: timestamp("logged_at").defaultNow(),
  },
  (table) => ({ userExerciseIdx: index("exercise_logs_user_idx").on(table.userId, table.loggedAt) }),
);

export const progressPhotos = pgTable(
  "progress_photos",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    photoNumber: integer("photo_number").notNull().default(1),
    photoBase64: text("photo_base64").notNull(),
    contentType: text("content_type").notNull().default("image/jpeg"),
    loggedAt: timestamp("logged_at").defaultNow(),
  },
  (table) => ({ userProgressIdx: index("progress_photos_user_idx").on(table.userId) })
);

export const progressPhotosRelations = relations(progressPhotos, ({ one }) => ({
  user: one(users, { fields: [progressPhotos.userId], references: [users.id] }),
}));

// === ESCALATION INBOX — human-review queue with SLA timers ===
export const escalations = pgTable("escalations", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(), // e.g. "injury", "billing", "frustrated", "medical", "manual"
  triggerMessage: text("trigger_message"), // the user message that triggered escalation
  status: text("status").notNull().default("open"), // open | claimed | resolved | expired
  priority: text("priority").notNull().default("normal"), // low | normal | high | urgent
  claimedBy: text("claimed_by"), // coach name or "auto"
  resolution: text("resolution"), // coach notes on how it was resolved
  createdAt: timestamp("created_at").defaultNow(),
  claimedAt: timestamp("claimed_at"),
  resolvedAt: timestamp("resolved_at"),
  slaDeadline: timestamp("sla_deadline"), // auto-set based on priority
}, (table) => ({
  statusIdx: index("escalations_status_idx").on(table.status),
  userIdx: index("escalations_user_idx").on(table.userId),
}));

export const escalationsRelations = relations(escalations, ({ one }) => ({
  user: one(users, { fields: [escalations.userId], references: [users.id] }),
}));

// === QUALITY SIGNALS — the product learning from every use (2026-07-14) ===
// Every moment the bot FUMBLES — an empty/never-silent reply, the brain giving up
// and deferring, an unreadable photo, the verifier catching it about to contradict
// stored truth — used to be logged to console and evaporate: the only path to a fix
// was the founder screenshotting it. This table captures each fumble so it becomes
// (a) a founder review queue ("what did the bot get wrong this week") without any
// screenshotting, and (b) candidate regression cases for the drill/routing batteries.
// Deliberately NOT an escalation: escalations are client-facing SLA items; this is
// internal product telemetry. Writes are fire-and-forget — never block or fail a reply.
export const qualitySignals = pgTable("quality_signals", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  phoneLast4: text("phone_last4"),       // enough to correlate without storing PII in the clear
  kind: text("kind").notNull(),          // never_silent | brain_defer | verifier_violation | media_unreadable | low_confidence
  messageIn: text("message_in"),
  messageOut: text("message_out"),
  detail: text("detail"),                // the violation / reason / model note
  reviewed: boolean("reviewed").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  kindDateIdx: index("quality_signals_kind_date_idx").on(table.kind, table.createdAt),
  reviewedIdx: index("quality_signals_reviewed_idx").on(table.reviewed, table.createdAt),
}));

// === SCHEDULER STATE — global (non-per-user) job run tracking ===
// Replaces the file-based .scheduler-state.json which is lost on container recycle.
// Each key is a job name; value is the date/week string it last ran (e.g. "2026-06-22").
export const schedulerState = pgTable("scheduler_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// === PROCESSED WEBHOOKS — cross-replica Twilio MessageSid dedup ===
// In-memory processedSids Map is wiped on container restart. A Twilio retry that hits a
// fresh replica after a restart would be re-processed (duplicate GPT call, duplicate log).
// This table stores the SID with a 24h TTL (rows purged nightly). ON CONFLICT DO NOTHING
// means the INSERT is the atomic test-and-set — only one replica ever processes each SID.
export const processedWebhooks = pgTable("processed_webhooks", {
  messageSid: text("message_sid").primaryKey(),
  processedAt: timestamp("processed_at").defaultNow().notNull(),
});

// === ADMIN EVENTS — immutable audit log for admin/manual interventions ===
export const adminEvents = pgTable("admin_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  action: text("action").notNull(), // 'force_activate', 'manual_cancel', etc.
  targetPhone: text("target_phone"),
  reason: text("reason"),
  meta: jsonb("meta"),
  performedAt: timestamp("performed_at").defaultNow().notNull(),
}, (table) => ({
  actionIdx: index("admin_events_action_idx").on(table.action),
  performedAtIdx: index("admin_events_performed_at_idx").on(table.performedAt),
}));

// === PAYMENT EVENTS — idempotency log for payment provider webhooks ===
// Unique on (provider, providerPaymentId) — duplicate ITNs are silently skipped.
export const paymentEvents = pgTable("payment_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  provider: text("provider").notNull(), // "payfast"
  providerPaymentId: text("provider_payment_id").notNull(),
  phone: text("phone").notNull(),
  amountGross: numeric("amount_gross"),
  paymentStatus: text("payment_status").notNull(),
  rawBody: jsonb("raw_body"),
  processedAt: timestamp("processed_at").defaultNow(),
}, (table) => ({
  uniqueEvent: uniqueIndex("payment_events_unique_idx").on(table.provider, table.providerPaymentId),
}));

// === GPT COSTS — per-call token + cost ledger for unit-economics visibility ===
// Every OpenAI call (coach reply, food vision, workout ID, classifier) writes one row.
// Aggregate by user/day/month to see real margin per client and catch runaway usage.
// Writes are best-effort/fire-and-forget — a logging failure must never break coaching.
export const gptCosts = pgTable("gpt_costs", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }), // nullable: pre-user classifiers
  model: text("model").notNull(),
  feature: text("feature"), // 'coach' | 'food_vision' | 'workout_id' | 'classify' | 'voice' | ...
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  userDateIdx: index("gpt_costs_user_date_idx").on(table.userId, table.createdAt),
  dateIdx: index("gpt_costs_date_idx").on(table.createdAt),
}));

export type GptCost = typeof gptCosts.$inferSelect;

// === CLIENT UNDERSTANDING — the durable "cortex" (rebuild blueprint Days 11-20) ===
// One row per client holding ONLY the trustworthy, slow-moving subset of
// UnderstandingState: the profile (name, life-story, key facts, preferences) and the
// coach's accumulated observations (confidence trend, frustration, readiness, trust).
// Volatile fields (this-message mood/topic) and DB-derived stats are NEVER persisted
// here — they're inferred/derived each turn. This is what lets Coach K remember a person
// across turns ("how's the flu?", "remember how good you felt last week?").
export const clientUnderstanding = pgTable("client_understanding", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  profile: jsonb("profile"),           // { name, lifeStory, keyFacts[], preferences }
  observations: jsonb("observations"), // { confidenceTrend, frustrationLevel, readinessToPush, trustLevel }
  sourceRevision: integer("source_revision").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type ClientUnderstanding = typeof clientUnderstanding.$inferSelect;

// === CLIENT TRUTH COMMITS — ordered evidence behind the current user projection ===
// The users row remains the fast current-state projection. This append-only row records which
// client message was accepted, any factual operations it caused, and the revision coaching saw.
// A nullable sourceMessageId deliberately permits internal/admin turns; PostgreSQL unique indexes
// allow multiple NULLs while making a real Twilio MessageSid idempotent per client.
export const clientTruthCommits = pgTable("client_truth_commits", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sourceMessageId: text("source_message_id"),
  revision: integer("revision").notNull(),
  operations: jsonb("operations").notNull(),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
}, (table) => ({
  sourceIdempotency: uniqueIndex("client_truth_commits_user_source_uidx")
    .on(table.userId, table.sourceMessageId),
  userRevisionIdx: uniqueIndex("client_truth_commits_user_revision_uidx")
    .on(table.userId, table.revision),
}));

export type ClientTruthCommit = typeof clientTruthCommits.$inferSelect;

// === DAILY CONSTRAINTS — what the client ruled out today, recorded when they said it (#194) ===
//
// held-constraints.ts opens by naming the defect this table closes: "the constraint lived for
// exactly one expression and then evaporated." Binding it to a reader fixed the first version of
// that; the reader still RE-DERIVED it from the last 24 chat messages, so on a busy day the
// declaration fell out of the window and the constraint evaporated again — proven on real
// PostgreSQL: closed at 09:00, gone by message 25, with the client having changed nothing.
//
// APPEND-ONLY, AND THAT IS THE POINT. A reopening does not edit the closure; it is a second row.
// The day's effective state is the newest decision, and the assertion that came before it is
// still on the record — which is what lets anyone answer "was the coach allowed to say that at
// 20:00" a week later. Nothing here decides anything: the recognisers in one-action.ts remain the
// only things that read a message, and readHeldConstraints remains the only reader of the state.
export const dailyConstraints = pgTable("daily_constraints", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** The SAST day this constraint is about — never a timestamp, because "today" is the whole rule. */
  day: text("day").notNull(),
  /** food | training */
  kind: text("kind").notNull(),
  /** asserted | released */
  state: text("state").notNull(),
  /** What resolved it: said | workout_logged. The client's words, or their actions. */
  via: text("via").notNull(),
  /** The provider message this came from, when there was one — makes a retry idempotent. */
  sourceMessageId: text("source_message_id"),
  saidAt: timestamp("said_at").defaultNow().notNull(),
}, (table) => ({
  userDayKindIdx: index("daily_constraints_user_day_kind_idx").on(table.userId, table.day, table.kind),
  sourceIdempotency: uniqueIndex("daily_constraints_user_source_kind_uidx")
    .on(table.userId, table.sourceMessageId, table.kind),
}));

export type DailyConstraint = typeof dailyConstraints.$inferSelect;


// === SENT PROACTIVE — durable dedupe for scheduled messages ===
// Each scheduled proactive send claims a row (userId, messageKey, dedupeWindow).
// The unique index below guarantees the same (user, messageKey, window) can only
// be claimed once, so a process restart mid-cron cannot double-send.
//
// dedupeWindow is caller-defined — use the ISO week "2026-W16" for weekly jobs,
// "2026-04-18" (YYYY-MM-DD) for daily jobs, month for monthly. The unique key
// is the triple, so different windows for the same message are fine.
export const sentProactive = pgTable("sent_proactive", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  messageKey: text("message_key").notNull(),
  dedupeWindow: text("dedupe_window").notNull(),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
}, (table) => ({
  uniqIdx: uniqueIndex("sent_proactive_uniq_idx").on(table.userId, table.messageKey, table.dedupeWindow),
  userIdx: index("sent_proactive_user_idx").on(table.userId),
  sentAtIdx: index("sent_proactive_sent_at_idx").on(table.sentAt),
}));

export const sentProactiveRelations = relations(sentProactive, ({ one }) => ({
  user: one(users, { fields: [sentProactive.userId], references: [users.id] }),
}));

// === A/B TEST EXPERIMENTS — message template testing engine ===
export const abExperiments = pgTable("ab_experiments", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // e.g. "morning_checkin_tone"
  description: text("description"),
  status: text("status").notNull().default("active"), // active | paused | completed
  variantA: text("variant_a").notNull(), // the control message template
  variantB: text("variant_b").notNull(), // the challenger message template
  messageType: text("message_type").notNull(), // e.g. "morning_checkin", "nudge", "workout_reminder"
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const abAssignments = pgTable("ab_assignments", {
  id: serial("id").primaryKey(),
  experimentId: integer("experiment_id").notNull().references(() => abExperiments.id),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  variant: text("variant").notNull(), // "A" or "B"
  delivered: boolean("delivered").default(false),
  responded: boolean("responded").default(false),
  convertedAction: text("converted_action"), // e.g. "workout_done", "food_logged", "replied"
  deliveredAt: timestamp("delivered_at"),
  respondedAt: timestamp("responded_at"),
}, (table) => ({
  expUserIdx: index("ab_assignments_exp_user_idx").on(table.experimentId, table.userId),
  expIdx: index("ab_assignments_exp_idx").on(table.experimentId),
}));

export const abExperimentsRelations = relations(abExperiments, ({ many }) => ({
  assignments: many(abAssignments),
}));

export const abAssignmentsRelations = relations(abAssignments, ({ one }) => ({
  experiment: one(abExperiments, { fields: [abAssignments.experimentId], references: [abExperiments.id] }),
  user: one(users, { fields: [abAssignments.userId], references: [users.id] }),
}));

// For Replit AI Integrations compatibility
export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

// === CLIENT PINNED ACTIONS ===
// Coach-defined per-client tasks: "Call to check injury", "Review programme week 4", etc.
// === HEALTH APP INTEGRATIONS — Google Fit / Apple Shortcuts step sync ===
export const userIntegrations = pgTable("user_integrations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(), // 'google_fit'
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiry: timestamp("token_expiry"),
  lastSyncAt: timestamp("last_sync_at"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userProviderIdx: uniqueIndex("user_integrations_user_provider_idx").on(table.userId, table.provider),
  userIdx: index("user_integrations_user_idx").on(table.userId),
}));

export const clientActions = pgTable("client_actions", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  dueAt: timestamp("due_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userIdx: index("client_actions_user_idx").on(table.userId),
}));

export type ClientAction = typeof clientActions.$inferSelect;

// ── Client Intelligence Profile ────────────────────────────────────────────
// One row per user. Updated weekly by runCipUpdate(). Injected into every
// GPT call so the coach always has the client's full history in context.
export const clientIntelligenceProfiles = pgTable("client_intelligence_profiles", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),

  // Journey anchors
  startWeightKg: numeric("start_weight_kg", { precision: 5, scale: 1 }),
  bestWeightKg: numeric("best_weight_kg", { precision: 5, scale: 1 }),
  totalKgChanged: numeric("total_kg_changed", { precision: 5, scale: 1 }),

  // All-time records (used for loss-framing)
  longestWorkoutStreak: integer("longest_workout_streak").default(0).notNull(),
  longestFoodStreak: integer("longest_food_streak").default(0).notNull(),
  bestWeekAvgProteinG: integer("best_week_avg_protein_g").default(0).notNull(),
  bestWeekSessions: integer("best_week_sessions").default(0).notNull(),

  // Behavioral fingerprint
  weakestDow: integer("weakest_dow"),         // 0=Sun … 6=Sat — day most likely to go silent
  peakEngagementHour: integer("peak_engagement_hour"), // 0-23 SAST — when they actually respond

  // Lifetime compliance
  lifetimeSessionCompliance: numeric("lifetime_session_compliance", { precision: 4, scale: 3 }),
  lifetimeFoodLogDays: integer("lifetime_food_log_days").default(0).notNull(),
  plateauCount: integer("plateau_count").default(0).notNull(),

  // Rich history blobs
  monthlySnapshots: jsonb("monthly_snapshots"),  // [{month, sessions, planned, proteinDays, avgWeightKg}]
  patternFlags: jsonb("pattern_flags"),           // ["silent_tuesdays", "chronic_protein_gap", ...]

  // The narrative injected into every GPT call
  coachNarrative: text("coach_narrative"),
});

// USER-SET REMINDERS — the client asks the coach to remind them ("remind me to take
// creatine at 8pm", "remind me to weigh in Monday"). One row per reminder. A scheduler
// poll fires the ones whose fireAt has passed and flips status to 'sent'. fireAt is stored
// in real UTC; the parser anchors everything to SAST (UTC+2). This is the first capability
// the coach can actually DO for a client on their own schedule — not a canned nudge.
export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    phoneNumber: text("phone_number").notNull(),
    body: text("body").notNull(),                 // what to remind them, phrased as the nudge text
    fireAt: timestamp("fire_at").notNull(),        // when to send (real UTC); for a recurring reminder this is the NEXT fire
    recurrence: text("recurrence"),                // null = one-shot | 'daily' | 'weekly' — poller re-schedules the next one
    kind: text("kind").notNull().default("user"),  // 'user' (client-set) | 'return' (auto night-before-return nudge)
    status: text("status").notNull().default("pending"), // 'pending' | 'sent' | 'cancelled'
    createdAt: timestamp("created_at").defaultNow().notNull(),
    sentAt: timestamp("sent_at"),
  },
  (table) => {
    return {
      dueIdx: index("reminders_due_idx").on(table.status, table.fireAt),
      userIdx: index("reminders_user_idx").on(table.userId, table.status),
    };
  },
);

// MEDIA JOBS — crash-safety net for async media processing. The webhook ACKs instantly and
// processes voice/photo/video in the background; if the PROCESS DIES mid-processing (OOM,
// deploy, restart) the reply is lost with no trace and the client sits in silence. Each media
// message records a 'pending' row here; the handler marks it 'done' when the reply is sent. A
// scheduler sweep finds rows stuck 'pending' past a few minutes (= a crashed job) and nudges the
// client to resend — so a dead process can never swallow a photo silently. No Redis, no worker.
export const mediaJobs = pgTable(
  "media_jobs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sourceMessageId: text("source_message_id").notNull().unique(),
    phoneNumber: text("phone_number").notNull(),
    userId: uuid("user_id"),
    mediaType: text("media_type"),
    status: text("status").notNull().default("pending"), // 'pending' | 'done' | 'recovered'
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return { statusIdx: index("media_jobs_status_idx").on(table.status, table.createdAt) };
  },
);
export type MediaJob = typeof mediaJobs.$inferSelect;

// === SHADOW REPLIES — staging. What the coach WOULD have said, if it were live. ===
//
// (2026-08-04, Slice 1 of the one-brain rebuild.) Every rewrite of the reply path so far
// was proved in production, on the founder's own phone, by a client reading a bad answer.
// That is the only instrument this product has ever had and it costs a real person a real
// bad experience per data point.
//
// With SHADOW=on, the outbound door writes here instead of calling Twilio. The whole
// pipeline runs — same handlers, same engine, same gates — and nothing reaches a human.
// A rewrite can then be watched for a day against real traffic before it is allowed to
// speak, and the gauntlet has somewhere to point when it asks "what would this have sent?"
//
// `authorFile` is the point of the table. One reply per inbound message is the target
// shape; while the long tail of handler mouths is still alive this column is what shows,
// per message, WHO spoke — and how many of them did.
export const shadowReplies = pgTable(
  "shadow_replies",
  {
    id: serial("id").primaryKey(),
    // No FK to users: shadow rows must survive a client deletion for a post-mortem, and a
    // capture must never fail because the phone number has no row yet (onboarding turn 1).
    userId: uuid("user_id"),
    phone: text("phone").notNull(),
    /** 'reply' (reactive, a client is waiting) | 'proactive' (scheduler) | 'template' | 'buttons' */
    channel: text("channel").notNull(),
    /** Which file called the door. The authorship count, per message, from live traffic. */
    authorFile: text("author_file").notNull(),
    body: text("body").notNull(),
    mediaUrls: jsonb("media_urls"),
    /** Running commit, so a shadow row is attributable to code and not to a memory. */
    commitSha: text("commit_sha"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    phoneIdx: index("shadow_replies_phone_idx").on(table.phone, table.createdAt),
    createdIdx: index("shadow_replies_created_idx").on(table.createdAt),
  }),
);
export type ShadowReply = typeof shadowReplies.$inferSelect;

export const clientActionsRelations = relations(clientActions, ({ one }) => ({
  user: one(users, { fields: [clientActions.userId], references: [users.id] }),
}));

export const userIntegrationsRelations = relations(userIntegrations, ({ one }) => ({
  user: one(users, { fields: [userIntegrations.userId], references: [users.id] }),
}));

// === RELATIONS ===

export const usersRelations = relations(users, ({ many }) => ({
  weightLogs: many(weightLogs),
  workoutLogs: many(workoutLogs),
  stepLogs: many(stepLogs),
  weeklyCheckins: many(weeklyCheckins),
  chatHistory: many(chatHistory),
  clothingCheckins: many(clothingCheckins),
  bodyMeasurements: many(bodyMeasurements),
  progressPhotos: many(progressPhotos),
  escalations: many(escalations),
  clientActions: many(clientActions),
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

export const clothingCheckinsRelations = relations(
  clothingCheckins,
  ({ one }) => ({
    user: one(users, {
      fields: [clothingCheckins.userId],
      references: [users.id],
    }),
  }),
);

export const bodyMeasurementsRelations = relations(
  bodyMeasurements,
  ({ one }) => ({
    user: one(users, {
      fields: [bodyMeasurements.userId],
      references: [users.id],
    }),
  }),
);

// === BASE SCHEMAS ===
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});
export const insertWeightLogSchema = createInsertSchema(weightLogs).omit({
  id: true,
  loggedAt: true,
});
export const insertWorkoutLogSchema = createInsertSchema(workoutLogs).omit({
  id: true,
  loggedAt: true,
});
export const insertStepLogSchema = createInsertSchema(stepLogs).omit({
  id: true,
  loggedAt: true,
});
export const insertWeeklyCheckinSchema = createInsertSchema(
  weeklyCheckins,
).omit({ id: true, createdAt: true });
export const insertChatLogSchema = createInsertSchema(chatHistory).omit({
  id: true,
  createdAt: true,
});
export const insertClothingCheckinSchema = createInsertSchema(
  clothingCheckins,
).omit({ id: true, loggedAt: true });
export const insertBodyMeasurementSchema = createInsertSchema(
  bodyMeasurements,
).omit({ id: true, loggedAt: true });

// === EXPLICIT API CONTRACT TYPES ===

/**
 * TRIALED NUMBERS — one trial per phone number, ever (2026-08-06, founder directive after
 * the start→cancel→start→cancel loop).
 *
 * WHY THIS IS A SEPARATE TABLE AND NOT A COLUMN. The "already onboarded" signal used to live
 * on users.betaBypassUntil, which closes the cancel-and-return loop correctly — a cancelled
 * member keeps the row, so returning never re-grants a trial. It does NOT close the loop that
 * goes through *delete my data*: that path deletes the user row and inserts a fresh one, and
 * the signal dies with it. A client can therefore reset their own trial using a documented
 * POPIA command. The anti-abuse record has to outlive the account or it is not a record.
 *
 * WHY IT STORES A HASH AND NOT THE NUMBER. Keeping a readable phone number after someone has
 * asked to be deleted is exactly what the deletion right exists to prevent, and a table of
 * numbers is a contact list waiting to leak. A salted one-way hash answers the only question
 * this table is allowed to ask — "has THIS number trialed?" — and answers nothing else. It
 * cannot be listed, exported, marketed to, or reversed. Retention for fraud prevention is a
 * legitimate interest under POPIA; retaining more than the question needs is not.
 *
 * Nothing else may be added to this table. The moment it carries a name, a date of birth or a
 * reason, it stops being an anti-abuse record and becomes a shadow profile of deleted users.
 */
export const trialedNumbers = pgTable("trialed_numbers", {
  /** Salted SHA-256 of the normalised MSISDN. See trialHash() in server/pricing-config.ts. */
  phoneHash: text("phone_hash").primaryKey(),
  firstTrialedAt: timestamp("first_trialed_at").defaultNow().notNull(),
});

export type TrialedNumber = typeof trialedNumbers.$inferSelect;

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

export type Escalation = typeof escalations.$inferSelect;

export type Reminder = typeof reminders.$inferSelect;

export type UpdateUserRequest = Partial<InsertUser>;
export type UserResponse = User;
export type UserListResponse = User[];

export interface FlaggedUser extends User {
  flagReason: "inactive_7_days" | "plateau_2_weeks";
  lastLogDate: string | null;
}
