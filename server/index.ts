import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { initScheduler } from "./scheduler";
import { initMemoryTable, initMealLogsTable } from "./memory";
import { initFoodsTable } from "./foods";
import { pool } from "./db";

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
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS today_calories NUMERIC DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS today_calories_date TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS today_protein_g NUMERIC DEFAULT 0`,
    // Gender (male/female), age, and buddy system — added for intelligence layer
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS buddy_id UUID`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS buddy_paired_at TIMESTAMP`,
    // Bump all existing users from old 7000 default to new 8500 — only updates those still at 7000
    `UPDATE users SET steps_target = 8500 WHERE steps_target = 7000 OR steps_target IS NULL`,
    // Clear any stuck awaitingProgrammeAnswers flags older than 24 hours
    `UPDATE users SET awaiting_programme_answers = false WHERE awaiting_programme_answers = true AND last_active_at < NOW() - INTERVAL '24 hours'`,
    `CREATE TABLE IF NOT EXISTS exercise_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id), exercise_name TEXT NOT NULL, weight_kg NUMERIC, reps INTEGER, sets INTEGER, logged_at TIMESTAMP DEFAULT NOW())`,
    `CREATE INDEX IF NOT EXISTS exercise_logs_user_idx ON exercise_logs(user_id)`,
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

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
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
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await runMigrations();
  await registerRoutes(httpServer, app);

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
  const REQUIRED_ENV: Array<{ key: string; warn: boolean; hint: string }> = [
    { key: "DATABASE_URL", warn: false, hint: "PostgreSQL connection required — app will crash without this" },
    { key: "TWILIO_ACCOUNT_SID", warn: true, hint: "WhatsApp messages will not send" },
    { key: "TWILIO_AUTH_TOKEN", warn: true, hint: "WhatsApp messages will not send" },
    { key: "TWILIO_WHATSAPP_NUMBER", warn: true, hint: "WhatsApp messages will not send" },
    { key: "AI_INTEGRATIONS_OPENAI_API_KEY", warn: true, hint: "GPT coaching responses will fail" },
    { key: "COACH_DASHBOARD_KEY", warn: true, hint: "Dashboard admin access blocked until this is set" },
    { key: "PAYFAST_MERCHANT_ID", warn: true, hint: "Payment links will not work" },
    { key: "PAYFAST_MERCHANT_KEY", warn: true, hint: "PayFast ITN signature validation disabled" },
  ];

  const missing = REQUIRED_ENV.filter(e => !process.env[e.key]);
  if (missing.length > 0) {
    for (const e of missing) {
      if (e.warn) {
        console.warn(`[STARTUP] ⚠️  Missing env var: ${e.key} — ${e.hint}`);
      } else {
        console.error(`[STARTUP] ❌  CRITICAL: Missing env var: ${e.key} — ${e.hint}`);
      }
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
      initScheduler();
      initFoodsTable().catch(e => console.error("[STARTUP] Foods init failed:", e));
      initMemoryTable().catch(e => console.error("[STARTUP] Memory init failed:", e));
      initMealLogsTable().catch(e => console.error("[STARTUP] Meal logs init failed:", e));
    },
  );
})();
