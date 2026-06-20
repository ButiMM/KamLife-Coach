import "dotenv/config";
import helmet from "helmet";
import * as Sentry from "@sentry/node";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { registerAudioRoutes } from "./replit_integrations/audio/routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { initScheduler } from "./scheduler";
import { initMemoryTable, initMealLogsTable } from "./memory";
import { initFoodsTable } from "./foods";
import { pool, db } from "./db";
import { users } from "../shared/schema";
import { eq } from "drizzle-orm";

// ── Sentry error monitoring — only active when SENTRY_DSN is set ──
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
    beforeSend(event) {
      // Strip phone numbers from breadcrumbs and messages before sending
      const str = JSON.stringify(event);
      const scrubbed = str.replace(/\+27\d{9,}/g, "+27***").replace(/whatsapp:\+27\d{9,}/g, "whatsapp:+27***");
      return JSON.parse(scrubbed);
    },
  });
  console.log("[SENTRY] Error monitoring active");
}

// ── Last-resort process guards ───────────────────────────────────────────────
// Without these, a single unhandled promise rejection crashes the whole server
// (Node 20's default), dropping every in-flight WhatsApp reply and risking a
// restart loop. We log + report instead of exiting: this is an always-on,
// solo-operator coach bot where staying up beats a clean restart, and Express
// already isolates per-request errors. Genuinely fatal states (port in use,
// dead DB pool) surface through their own paths.
process.on("unhandledRejection", (reason: any) => {
  console.error("[UNHANDLED_REJECTION]", reason?.stack || reason);
  if (process.env.SENTRY_DSN) Sentry.captureException(reason);
});
process.on("uncaughtException", (err: any) => {
  console.error("[UNCAUGHT_EXCEPTION]", err?.stack || err);
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
});

async function runMigrations(): Promise<void> {
  // ── PHASE 1: Create all tables if they don't exist (fresh Railway deploy) ──
  const createTables = [
    `CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_number TEXT NOT NULL UNIQUE,
      email TEXT,
      name TEXT,
      gender TEXT,
      goal_type TEXT,
      age INTEGER,
      height_cm INTEGER,
      current_weight NUMERIC,
      training_days_per_week INTEGER,
      budget_level TEXT,
      calorie_target INTEGER,
      protein_target INTEGER,
      steps_target INTEGER,
      subscription_status TEXT NOT NULL DEFAULT 'inactive',
      onboarding_state TEXT,
      beta_bypass_until TIMESTAMP,
      last_active_at TIMESTAMP,
      training_mode TEXT DEFAULT 'home',
      program_day_index INTEGER DEFAULT 1,
      awaiting_input_type TEXT,
      weekly_score INTEGER DEFAULT 0,
      compliance_level TEXT DEFAULT 'RESET',
      carb_portion_level INTEGER,
      referral_code TEXT,
      referred_by TEXT,
      injuries TEXT,
      programme_phase INTEGER DEFAULT 1,
      programme_week INTEGER DEFAULT 1,
      programme_day_in_week INTEGER DEFAULT 1,
      programme_start_date TIMESTAMP,
      training_experience TEXT,
      last_workout_date TIMESTAMP,
      total_workouts_completed INTEGER DEFAULT 0,
      phase_ready_to_advance BOOLEAN DEFAULT false,
      home_equipment TEXT,
      life_situation TEXT,
      job_type TEXT,
      activity_level TEXT,
      primary_focus_area TEXT,
      baseline_week_active BOOLEAN DEFAULT false,
      baseline_week_complete BOOLEAN DEFAULT false,
      profile_notes TEXT,
      today_water NUMERIC DEFAULT 0,
      water_streak INTEGER DEFAULT 0,
      water_last_reset_date TEXT,
      cancelled_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      bmi NUMERIC,
      medical_conditions TEXT,
      nutrition_protocol TEXT,
      meal_timing_strict BOOLEAN DEFAULT false,
      doctor_clearance_required BOOLEAN DEFAULT false,
      training_location TEXT,
      gym_name TEXT,
      weekly_food_budget TEXT,
      work_schedule TEXT,
      elderly_client BOOLEAN DEFAULT false,
      awaiting_programme_answers BOOLEAN DEFAULT false,
      other_medical_notes TEXT,
      popi_consent BOOLEAN DEFAULT false,
      popi_consent_at TIMESTAMP,
      last_goal_check_week INTEGER DEFAULT 0,
      workout_streak INTEGER DEFAULT 0,
      subscription_renews_at TIMESTAMP,
      payment_reference TEXT,
      today_calories INTEGER DEFAULT 0,
      today_calories_date TEXT,
      today_protein_g INTEGER DEFAULT 0,
      buddy_id UUID,
      buddy_paired_at TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS users_phone_idx ON users(phone_number)`,

    `CREATE TABLE IF NOT EXISTS weight_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      weight NUMERIC NOT NULL,
      logged_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS weight_logs_user_idx ON weight_logs(user_id)`,

    `CREATE TABLE IF NOT EXISTS workout_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      workout_completed BOOLEAN DEFAULT false,
      logged_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS workout_logs_user_idx ON workout_logs(user_id)`,

    `CREATE TABLE IF NOT EXISTS step_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      steps INTEGER NOT NULL,
      logged_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS step_logs_user_idx ON step_logs(user_id)`,

    `CREATE TABLE IF NOT EXISTS weekly_checkins (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      week_start_date DATE NOT NULL,
      weight NUMERIC,
      waist_cm NUMERIC,
      workouts_completed INTEGER,
      avg_steps INTEGER,
      hunger_score INTEGER,
      auto_adjustment_note TEXT,
      escalation_flag BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS weekly_checkins_user_idx ON weekly_checkins(user_id)`,

    `CREATE TABLE IF NOT EXISTS chat_history (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      message_in TEXT,
      message_out TEXT,
      intent TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS chat_history_user_date_idx ON chat_history(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS chat_history_user_intent_idx ON chat_history(user_id, intent, created_at)`,

    `CREATE TABLE IF NOT EXISTS clothing_checkins (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      jeans_fit TEXT,
      energy_level TEXT,
      stomach_feel TEXT,
      overall_feel TEXT,
      week_number INTEGER,
      logged_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS clothing_checkins_user_idx ON clothing_checkins(user_id)`,

    `CREATE TABLE IF NOT EXISTS body_measurements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      measurement_type TEXT NOT NULL,
      value TEXT NOT NULL,
      logged_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS body_measurements_user_idx ON body_measurements(user_id)`,

    `CREATE TABLE IF NOT EXISTS exercise_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      exercise_name TEXT NOT NULL,
      weight_kg NUMERIC,
      reps INTEGER,
      sets INTEGER,
      logged_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS exercise_logs_user_idx ON exercise_logs(user_id)`,

    `CREATE TABLE IF NOT EXISTS progress_photos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      photo_number INTEGER NOT NULL DEFAULT 1,
      photo_base64 TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'image/jpeg',
      logged_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS progress_photos_user_idx ON progress_photos(user_id)`,

    `CREATE TABLE IF NOT EXISTS escalations (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL,
      trigger_message TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      claimed_by TEXT,
      resolution TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      claimed_at TIMESTAMP,
      resolved_at TIMESTAMP,
      sla_deadline TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS escalations_status_idx ON escalations(status)`,
    `CREATE INDEX IF NOT EXISTS escalations_user_idx ON escalations(user_id)`,

    `CREATE TABLE IF NOT EXISTS ab_experiments (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      variant_a TEXT NOT NULL,
      variant_b TEXT NOT NULL,
      message_type TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      completed_at TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS ab_assignments (
      id SERIAL PRIMARY KEY,
      experiment_id INTEGER NOT NULL REFERENCES ab_experiments(id),
      user_id UUID NOT NULL REFERENCES users(id),
      variant TEXT NOT NULL,
      delivered BOOLEAN DEFAULT false,
      responded BOOLEAN DEFAULT false,
      converted_action TEXT,
      delivered_at TIMESTAMP,
      responded_at TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS ab_assignments_exp_user_idx ON ab_assignments(experiment_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS ab_assignments_exp_idx ON ab_assignments(experiment_id)`,

    `CREATE TABLE IF NOT EXISTS client_actions (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      due_at TIMESTAMP,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS client_actions_user_idx ON client_actions(user_id)`,

    `CREATE TABLE IF NOT EXISTS sent_proactive (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      message_key TEXT NOT NULL,
      dedupe_window TEXT NOT NULL,
      sent_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sent_proactive_uniq_idx ON sent_proactive(user_id, message_key, dedupe_window)`,
    `CREATE INDEX IF NOT EXISTS sent_proactive_user_idx ON sent_proactive(user_id)`,
    `CREATE INDEX IF NOT EXISTS sent_proactive_sent_at_idx ON sent_proactive(sent_at)`,

    `CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS rate_limits (
      phone TEXT PRIMARY KEY,
      window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      hit_count INTEGER NOT NULL DEFAULT 1
    )`,

    `CREATE TABLE IF NOT EXISTS voice_broadcasts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      label TEXT NOT NULL DEFAULT 'Voice Broadcast',
      audio_base64 TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'audio/ogg',
      duration_secs INTEGER,
      sent_count INTEGER NOT NULL DEFAULT 0,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS voice_recap_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      week_start DATE NOT NULL,
      message_text TEXT NOT NULL,
      audio_base64 TEXT,
      content_type TEXT NOT NULL DEFAULT 'audio/mpeg',
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, week_start)
    )`,
    `CREATE INDEX IF NOT EXISTS voice_recap_logs_user_idx ON voice_recap_logs(user_id)`,
    `CREATE INDEX IF NOT EXISTS voice_recap_logs_week_idx ON voice_recap_logs(week_start DESC)`,
    `CREATE TABLE IF NOT EXISTS admin_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      action TEXT NOT NULL,
      target_phone TEXT,
      reason TEXT,
      meta JSONB,
      performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS admin_events_action_idx ON admin_events(action)`,
    `CREATE INDEX IF NOT EXISTS admin_events_performed_at_idx ON admin_events(performed_at DESC)`,
    `CREATE TABLE IF NOT EXISTS payment_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL,
      provider_payment_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      amount_gross NUMERIC,
      payment_status TEXT NOT NULL,
      raw_body JSONB,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS payment_events_unique_idx ON payment_events(provider, provider_payment_id)`,
    `CREATE TABLE IF NOT EXISTS client_intelligence_profiles (
      user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      start_weight_kg  NUMERIC(5,1),
      best_weight_kg   NUMERIC(5,1),
      total_kg_changed NUMERIC(5,1),
      longest_workout_streak    INTEGER NOT NULL DEFAULT 0,
      longest_food_streak       INTEGER NOT NULL DEFAULT 0,
      best_week_avg_protein_g   INTEGER NOT NULL DEFAULT 0,
      best_week_sessions        INTEGER NOT NULL DEFAULT 0,
      weakest_dow              INTEGER,
      peak_engagement_hour     INTEGER,
      lifetime_session_compliance NUMERIC(4,3),
      lifetime_food_log_days      INTEGER NOT NULL DEFAULT 0,
      plateau_count               INTEGER NOT NULL DEFAULT 0,
      monthly_snapshots  JSONB,
      pattern_flags      JSONB,
      coach_narrative    TEXT
    )`,
  ];

  let created = 0;
  for (const sql of createTables) {
    try {
      await pool.query(sql);
      created++;
    } catch (e: any) {
      console.error(`[MIGRATION] Table create failed: ${sql.slice(0, 60)}... — ${e.message}`);
    }
  }
  console.log(`[MIGRATION] Tables — ${created}/${createTables.length} ensured`);

  // ── PHASE 2: Add columns to existing tables (incremental migrations) ──
  const migrations = [
    // Email (optional, collected during onboarding)
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`,
    // POPIA consent columns
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS popi_consent BOOLEAN DEFAULT false`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS popi_consent_at TIMESTAMP`,
    // Water tracking columns
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS today_water NUMERIC DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS water_streak INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS water_last_reset_date TEXT`,
    // Cancellation
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP`,
    // Medical / nutrition columns
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS medical_conditions TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS nutrition_protocol TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS meal_timing_strict BOOLEAN DEFAULT false`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS doctor_clearance_required BOOLEAN DEFAULT false`,
    // Profile extras
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS training_location TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS gym_name TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_food_budget TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS work_schedule TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS elderly_client BOOLEAN DEFAULT false`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS awaiting_programme_answers BOOLEAN DEFAULT false`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS other_medical_notes TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_goal_check_week INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS bmi NUMERIC`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS phase_ready_to_advance BOOLEAN DEFAULT false`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS home_equipment TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS life_situation TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS job_type TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_level TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_focus_area TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS baseline_week_active BOOLEAN DEFAULT false`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS baseline_week_complete BOOLEAN DEFAULT false`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_notes TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS workout_streak INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_renews_at TIMESTAMP`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_reference TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS today_calories INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS today_calories_date TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS today_protein_g INTEGER DEFAULT 0`,
    // Corrective: older DBs got these columns as NUMERIC (pg returns NUMERIC as a
    // *string*, which silently breaks `todayCalories + x` arithmetic). Convert to
    // INTEGER to match the Drizzle source of truth. Idempotent — the guard means it
    // only rewrites while the column is still numeric, so it's a no-op on every
    // subsequent boot.
    `DO $$
     BEGIN
       IF (SELECT data_type FROM information_schema.columns
           WHERE table_name='users' AND column_name='today_calories') = 'numeric' THEN
         ALTER TABLE users ALTER COLUMN today_calories TYPE INTEGER USING ROUND(today_calories)::integer;
       END IF;
       IF (SELECT data_type FROM information_schema.columns
           WHERE table_name='users' AND column_name='today_protein_g') = 'numeric' THEN
         ALTER TABLE users ALTER COLUMN today_protein_g TYPE INTEGER USING ROUND(today_protein_g)::integer;
       END IF;
     END $$;`,
    // Gender (male/female), age, and buddy system — added for intelligence layer
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS buddy_id UUID`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS buddy_paired_at TIMESTAMP`,
    // Diet breaks, goal reached, target weight
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS target_weight_kg NUMERIC`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS diet_break_ends_at TIMESTAMP`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS diet_break_cal_target INTEGER`,
    // Bump all existing users from old 7000 default to new 8500 — only updates those still at 7000
    `UPDATE users SET steps_target = 8500 WHERE steps_target = 7000 OR steps_target IS NULL`,
    // Clear any stuck awaitingProgrammeAnswers flags older than 24 hours
    `UPDATE users SET awaiting_programme_answers = false WHERE awaiting_programme_answers = true AND last_active_at < NOW() - INTERVAL '24 hours'`,
    `CREATE TABLE IF NOT EXISTS exercise_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id), exercise_name TEXT NOT NULL, weight_kg NUMERIC, reps INTEGER, sets INTEGER, logged_at TIMESTAMP DEFAULT NOW())`,
    `CREATE INDEX IF NOT EXISTS exercise_logs_user_idx ON exercise_logs(user_id)`,
    `CREATE TABLE IF NOT EXISTS user_integrations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id), provider TEXT NOT NULL, access_token TEXT, refresh_token TEXT, token_expiry TIMESTAMP, last_sync_at TIMESTAMP, is_active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMP DEFAULT NOW())`,
    `CREATE UNIQUE INDEX IF NOT EXISTS user_integrations_user_provider_idx ON user_integrations(user_id, provider)`,
    `CREATE INDEX IF NOT EXISTS user_integrations_user_idx ON user_integrations(user_id)`,
    // Hot path: scheduler getActiveClients() + signup/payment-recovery jobs filter
    // users on (subscription_status, onboarding_state) on every cron run. Index it.
    `CREATE INDEX IF NOT EXISTS users_sub_onboard_idx ON users(subscription_status, onboarding_state)`,
  ];

  let applied = 0;
  for (const sql of migrations) {
    try {
      await pool.query(sql);
      applied++;
    } catch (e: any) {
      console.error(`[MIGRATION] Failed: ${sql.slice(0, 60)}... — ${e.message}`);
    }
  }
  console.log(`[MIGRATION] Done — ${applied}/${migrations.length} columns ensured`);
}

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Progress photo uploads (/api/users) and voice broadcast uploads (/api/admin)
// can be up to ~8MB base64. All other JSON endpoints get a tight 100kb cap.
// In production we ship a real Content-Security-Policy. styleSrc allows
// 'unsafe-inline' because the bundled dashboard CSS needs it — but scriptSrc
// deliberately does NOT, so injected inline scripts can't execute (XSS brake).
// In development CSP stays off: Vite's HMR client injects inline scripts and a
// strict policy breaks the dev server. crossOriginEmbedderPolicy stays off in
// both so WhatsApp/Twilio iframes and cross-origin media keep loading.
const isProd = process.env.NODE_ENV === "production";
app.use(helmet({
  contentSecurityPolicy: isProd
    ? {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "https:"],
          frameAncestors: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
        },
      }
    : false,
  crossOriginEmbedderPolicy: false,
  // Sensible defaults kept on explicitly: nosniff, clickjacking protection,
  // and a strict referrer policy.
  noSniff: true,
  frameguard: { action: "sameorigin" },
  referrerPolicy: { policy: "no-referrer" },
}));

app.use(
  ["/api/users", "/api/admin"],
  express.json({
    limit: "10mb",
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
  }),
);
app.use(
  express.json({
    limit: "100kb",
    verify: (req: any, _res, buf) => { if (!req.rawBody) req.rawBody = buf; },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

// Ensure the coach/owner account is always active in the DB on boot.
// Works off COACH_ALERT_PHONE or ADMIN_PHONE_OVERRIDE env var.
async function activateCoachAccount(): Promise<void> {
  const rawPhone = process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE;
  if (!rawPhone) return;
  const digits = rawPhone.replace(/\D/g, "");
  const normalised = `whatsapp:+${digits}`;
  try {
    const result = await db
      .update(users)
      .set({ subscriptionStatus: "active" })
      .where(eq(users.phoneNumber, normalised))
      .returning({ id: users.id });
    if (result.length > 0) {
      console.log(`[STARTUP] Coach account activated: ${normalised}`);
    }
  } catch (e: any) {
    console.warn(`[STARTUP] Could not activate coach account: ${e.message}`);
  }
}

(async () => {
  await runMigrations();
  registerAudioRoutes(app);
  await registerRoutes(httpServer, app);

  if (process.env.SENTRY_DSN) {
    app.use(Sentry.expressErrorHandler() as any);
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ---- STARTUP ENV VALIDATION ----
  // `critical: true` vars HARD-FAIL the boot in production — better to crash loud
  // (and let Railway restart) than serve a silently broken bot that drops payments
  // or every WhatsApp reply. In development the same vars only warn so local work
  // isn't blocked. `presentKeys` lists accepted aliases — the OpenAI key is read
  // under two names across the codebase, so either satisfies the check.
  const REQUIRED_ENV: Array<{ key: string; critical: boolean; hint: string; presentKeys?: string[] }> = [
    { key: "DATABASE_URL", critical: true, hint: "PostgreSQL connection required — app will crash without this" },
    { key: "TWILIO_ACCOUNT_SID", critical: true, hint: "WhatsApp messages will not send" },
    { key: "TWILIO_AUTH_TOKEN", critical: true, hint: "WhatsApp messages will not send" },
    { key: "TWILIO_WHATSAPP_NUMBER", critical: true, hint: "WhatsApp messages will not send" },
    { key: "OPENAI_API_KEY", critical: true, hint: "GPT coaching responses will fail", presentKeys: ["OPENAI_API_KEY", "AI_INTEGRATIONS_OPENAI_API_KEY"] },
    { key: "COACH_DASHBOARD_KEY", critical: false, hint: "Dashboard admin access blocked until this is set" },
    { key: "PAYFAST_MERCHANT_ID", critical: true, hint: "Payment links will not work" },
    { key: "PAYFAST_MERCHANT_KEY", critical: false, hint: "PayFast payment link generation will fail" },
    { key: "PAYFAST_PASSPHRASE", critical: true, hint: "PayFast ITN signature validation will reject every payment notification — users who pay will not be activated" },
    { key: "APP_URL", critical: false, hint: "Payment links and PayFast callbacks will use fallback domain — set to your Railway URL" },
  ];

  const isPresent = (e: typeof REQUIRED_ENV[number]) =>
    (e.presentKeys ?? [e.key]).some(k => !!process.env[k]);
  const missing = REQUIRED_ENV.filter(e => !isPresent(e));
  if (missing.length > 0) {
    for (const e of missing) {
      if (e.critical) {
        console.error(`[STARTUP] ❌  CRITICAL: Missing env var: ${e.key} — ${e.hint}`);
      } else {
        console.warn(`[STARTUP] ⚠️  Missing env var: ${e.key} — ${e.hint}`);
      }
    }
  }

  // Hard-fail in production if any critical var is missing — refuse to boot broken.
  if (process.env.NODE_ENV === "production") {
    const missingCritical = missing.filter(e => e.critical).map(e => e.key);
    if (missingCritical.length > 0) {
      console.error(`[STARTUP] ❌  Refusing to start in production — missing critical env vars: ${missingCritical.join(", ")}`);
      throw new Error(`Missing critical env vars in production: ${missingCritical.join(", ")}`);
    }
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  const listenOptions: Parameters<typeof httpServer.listen>[0] = {
    port,
    host: "0.0.0.0",
    // Windows does not support reusePort and crashes with ENOTSUP.
    ...(process.platform === "win32" ? {} : { reusePort: true }),
  };

  httpServer.listen(
    listenOptions,
    () => {
      log(`serving on port ${port}`);
      initScheduler().catch(e => console.error("[STARTUP] Scheduler init failed:", e));
      initFoodsTable().catch(e => console.error("[STARTUP] Foods init failed:", e));
      initMemoryTable().catch(e => console.error("[STARTUP] Memory init failed:", e));
      initMealLogsTable().catch(e => console.error("[STARTUP] Meal logs init failed:", e));
      activateCoachAccount().catch(e => console.error("[STARTUP] Coach activation failed:", e));
    },
  );

  // Graceful shutdown — Railway sends SIGTERM before killing the container.
  // Drain existing connections cleanly so in-flight WhatsApp replies finish.
  const shutdown = async (signal: string) => {
    console.log(`[SHUTDOWN] ${signal} received — closing server`);
    httpServer.close(async () => {
      try {
        await pool.end();
        console.log("[SHUTDOWN] DB pool closed cleanly");
      } catch (e) {
        console.error("[SHUTDOWN] DB pool close error:", e);
      }
      process.exit(0);
    });
    // Force-exit after 30s if connections don't drain — long enough for a cron
    // fan-out (e.g. proactive batch) already in flight to finish before the kill.
    setTimeout(() => {
      console.error("[SHUTDOWN] Force exit after timeout");
      process.exit(1);
    }, 30_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})();
