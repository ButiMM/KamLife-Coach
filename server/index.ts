import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { initScheduler } from "./scheduler";
import { initMemoryTable } from "./memory";
import { initFoodsTable } from "./foods";
import { pool } from "./db";

async function runMigrations(): Promise<void> {
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
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      initScheduler();
      initFoodsTable().catch(e => console.error("[STARTUP] Foods init failed:", e));
      initMemoryTable().catch(e => console.error("[STARTUP] Memory init failed:", e));
    },
  );
})();
