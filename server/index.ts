import "dotenv/config";
// FIRST, before any module builds an OpenAI client: /health must see every model call (#397).
import "./ai-offline";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import helmet from "helmet";
import * as Sentry from "@sentry/node";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setStartupPhase, registerStartupGate } from "./routes/health";
import { serveStatic } from "./static";
import { createServer } from "http";
import { initScheduler } from "./scheduler";
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
  // ONE SCHEMA SYSTEM (#343): migrations/ is the only authority. The boot-time CREATE TABLE and ALTER arrays that
  // stood here were a second one; the three tables only they made are migration 0025.
  await applySqlMigrations();
}

/**
 * ── PHASE 3: the migrations/ directory actually runs (Cut 4) ──────────────────────────────────
 *
 * Until now this repo had TWO schema systems and neither was authoritative. `migrations/*.sql`
 * was version-controlled, had a guard enforcing db:migrate over db:push, and was **never executed
 * by any deploy path** — railway.json and the Dockerfile both just run `node dist/index.cjs`. The
 * real schema was the hand-maintained ALTER array above.
 *
 * That cost six hours of total outage on 2026-08-18. Migration 0005 declared three baseline_*
 * columns on `users`; nothing created them; Drizzle names every declared column in every SELECT;
 * the webhook reads `users` before anything else. Every inbound message threw. The difference
 * between a safe migration and an outage was whether the author happened to remember an
 * undocumented second step — hand-copying their columns into the array above.
 *
 * Now: every file in migrations/ runs once, in filename order, tracked in schema_migrations.
 * A FAILURE IS FATAL. Booting with a schema the code does not match is what produced the outage;
 * refusing to boot is loud, and Railway's restart policy makes it visible immediately.
 *
 * Every file in migrations/ is already written to be safe against a database that already has the
 * schema — 0000 carries an explicit idempotency patch saying so — which is what makes adopting
 * them on an existing production database safe rather than a second outage.
 */
/** Infrastructure, not our SQL. These must be reported — and retried — differently. */
function isConnectionError(e: any): boolean {
  const code = String(e?.code || e?.cause?.code || "");
  return ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "EAI_AGAIN"].includes(code)
    || /connect|terminat|timeout|getaddrinfo/i.test(String(e?.message || ""));
}

async function applySqlMigrations(): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  if (!existsSync(dir)) {
    console.warn(`[MIGRATION] no migrations/ directory at ${dir} — skipping SQL phase`);
    return;
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const done = new Set(
    (await pool.query(`SELECT filename FROM schema_migrations`)).rows.map((r: any) => r.filename),
  );
  const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
  let ran = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf-8");
    try {
      await pool.query("BEGIN");
      await pool.query(sql);
      await pool.query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [file]);
      await pool.query("COMMIT");
      ran++;
      console.log(`[MIGRATION] applied ${file}`);
    } catch (e: any) {
      await pool.query("ROLLBACK").catch(() => {});
      // FATAL ON PURPOSE. The alternative is what happened on 2026-08-18: the process boots, the
      // schema does not match the code, and every client message returns an error instead.
      console.error(`[MIGRATION] FATAL — ${file} failed: ${e?.message}`);
      throw new Error(`migration ${file} failed: ${e?.message}`);
    }
  }
  console.log(`[MIGRATION] SQL phase — ${ran} applied, ${files.length - ran} already recorded`);
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

/**
 * BIND FIRST, THEN PROVE THE SCHEMA (2026-08-20).
 *
 * The order was migrations → routes → listen, so any migration failure meant the port was never
 * bound and the edge returned a bare 502 — indistinguishable from a dead container, a bad domain,
 * or a crash-loop. /health could not answer, because it is registered after the step that failed.
 *
 * The safety guarantee is unchanged: a schema that failed to migrate still may not serve Coach
 * traffic. The gate in routes/health.ts refuses everything but a health probe until the phase is
 * `ready`. What changes is that the process is REACHABLE while it decides, and says which of
 * "cannot connect" and "migration failed" happened — two different facts that a 502 conflated.
 */
async function verifySchemaThenServe(): Promise<void> {
  setStartupPhase("migrating");
  try {
    await runMigrations();
    setStartupPhase("ready", { database: "reachable", migration: "applied", detail: null });
    // Everything that touches the schema starts HERE, after it is proven — never from the listen
    // callback, which fires whether or not the migration succeeded.
    // SHOUT ABOUT ANYTHING SILENTLY OFF (2026-07-28). A crisis alert that cannot reach the
    // founder must not wait for someone to think of asking.
    import("./self-check").then(sc => sc.logSelfCheckAtBoot()).catch(() => {});
    initScheduler().catch(e => console.error("[STARTUP] Scheduler init failed:", e));
    initFoodsTable().catch(e => console.error("[STARTUP] Foods init failed:", e));
    activateCoachAccount().catch(e => console.error("[STARTUP] Coach activation failed:", e));
  } catch (e: any) {
    const connection = isConnectionError(e);
    setStartupPhase("failed", {
      database: connection ? "unreachable" : "reachable",
      migration: connection ? "pending" : "failed",
      detail: e?.message || String(e),
    });
    // NOT process.exit(). A dead process cannot tell anyone what went wrong, and that is exactly
    // the hole this fixes. It stays up, serves /health, and refuses everything else.
    console.error(`[STARTUP] schema not verified — serving /health only. ${connection ? "database unreachable" : "MIGRATION FAILED"}: ${e?.message}`);
  }
}

(async () => {
  // FIRST. Express matches in registration order, so this must precede every other route or it
  // only guards what comes after it.
  registerStartupGate(app);
  await registerRoutes(httpServer, app);
  // Kicked off, not awaited: the listen() below must happen regardless of how this goes.
  void verifySchemaThenServe();

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

  // REFUSE TO SERVE, BUT SAY SO (2026-08-20). This threw before listen(), so a missing env var
  // was indistinguishable from a crash-loop, a bad domain or a dead database — all of them a bare
  // 502. The refusal is unchanged in substance: the startup gate keeps every non-health route
  // closed. What changes is that the process stays reachable long enough to NAME the variable,
  // which is the one thing the person fixing it needs.
  if (process.env.NODE_ENV === "production") {
    const missingCritical = missing.filter(e => e.critical).map(e => e.key);
    if (missingCritical.length > 0) {
      console.error(`[STARTUP] ❌  Refusing to serve in production — missing critical env vars: ${missingCritical.join(", ")}`);
      // NOT a return: listen() is below, and skipping it would reproduce the exact opacity this
      // change exists to remove. Bind, refuse traffic at the gate, and name the variable.
      setStartupPhase("failed", { detail: `missing critical env vars: ${missingCritical.join(", ")}` });
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
      // THE PORT IS BOUND; NOTHING ELSE STARTS YET. Binding early is what lets /health explain a
      // failed startup, but the scheduler must not fire proactive messages — or the foods and
      // memory tables initialise — against a schema we have not verified. Those now run from the
      // `ready` branch of verifySchemaThenServe, which is the one place that knows the schema is
      // good. A boot that never reaches `ready` serves /health and nothing else, on purpose.
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
