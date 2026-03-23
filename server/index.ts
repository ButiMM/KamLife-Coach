import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { initScheduler } from "./scheduler";
import { initMemoryTable } from "./memory";
import { initFoodsTable } from "./foods";

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
    { key: "COACH_DASHBOARD_KEY", warn: true, hint: "Dashboard using insecure default key 'kamlife2024' — set this env var immediately" },
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
