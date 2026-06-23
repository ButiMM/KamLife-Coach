import type { Express, Request } from "express";
import crypto from "crypto";
import { db } from "../db";
import { adminEvents } from "../../shared/schema";
import { and, eq, gte, sql } from "drizzle-orm";

function createSessionToken(secret: string): string {
  const exp = Date.now() + 4 * 60 * 60 * 1000;
  const payload = `admin:${exp}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifySessionToken(token: string, secret: string): boolean {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    if (sig.length !== expected.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return false;
  } catch {
    return false;
  }
  const colonIdx = payload.indexOf(":");
  if (colonIdx === -1) return false;
  return Date.now() < parseInt(payload.slice(colonIdx + 1), 10);
}

function parseCookies(req: Request): Record<string, string> {
  const header = (req.headers.cookie as string) || "";
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) result[k] = decodeURIComponent(v);
  }
  return result;
}

export function requireAdminKey(req: any, res: any, next: any) {
  const secret = process.env.COACH_DASHBOARD_KEY;
  if (!secret) {
    console.error("[AUTH] COACH_DASHBOARD_KEY not set — admin blocked");
    return res.status(503).json({ message: "Dashboard not configured" });
  }

  // 1. httpOnly cookie — React dashboard
  // CSRF guard: if Origin is present and doesn't match APP_URL, reject — prevents
  // cross-origin form submissions from hijacking a logged-in admin session.
  const cookies = parseCookies(req);
  if (cookies.admin_session && verifySessionToken(cookies.admin_session, secret)) {
    const origin = req.headers.origin as string | undefined;
    const appUrl = (process.env.APP_URL || "").replace(/\/$/, "");
    if (origin && appUrl && !origin.startsWith(appUrl)) {
      console.warn(`[AUTH] CSRF guard: unexpected Origin "${origin}" on cookie-auth request`);
      return res.status(403).json({ message: "Forbidden" });
    }
    return next();
  }

  // 2. Header fallback — server-rendered /coach page uses x-dashboard-key directly.
  // Hash both values to equal length before timingSafeEqual — prevents key-length oracle via timing.
  const provided = (req.headers["x-dashboard-key"] as string) || "";
  if (provided.length > 0) {
    try {
      const ph = crypto.createHash("sha256").update(provided).digest();
      const sh = crypto.createHash("sha256").update(secret).digest();
      if (crypto.timingSafeEqual(ph, sh)) return next();
    } catch {}
  }

  return res.status(401).json({ message: "Unauthorized" });
}

// Brute-force protection for the login endpoint.
// In-memory map is the fast path for the current instance; DB is the authoritative
// cross-replica source so an attacker can't bypass the 5-attempt lock by hitting
// different Railway replicas. Both are checked; either can block the login.
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (now > entry.lockedUntil + 60_000) loginAttempts.delete(ip);
  }
}, 5 * 60_000);

const LOCKOUT_WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

async function getFailedAttemptsDb(ip: string): Promise<number> {
  try {
    const since = new Date(Date.now() - LOCKOUT_WINDOW_MS);
    const result = await db.select({ n: sql<string>`count(*)` })
      .from(adminEvents)
      .where(and(
        eq(adminEvents.action, "login_failed"),
        gte(adminEvents.performedAt, since),
        sql`meta->>'ip' = ${ip}`,
      ));
    return parseInt(result[0]?.n || "0", 10);
  } catch {
    return 0; // fail open — in-memory guard still applies
  }
}

async function recordFailedAttemptDb(ip: string): Promise<void> {
  try {
    await db.insert(adminEvents).values({ action: "login_failed", meta: { ip } });
  } catch { /* non-fatal */ }
}

export function registerAuthRoutes(app: Express) {
  app.post("/api/auth/login", async (req: any, res: any) => {
    const secret = process.env.COACH_DASHBOARD_KEY;
    if (!secret) return res.status(503).json({ message: "Dashboard not configured — set COACH_DASHBOARD_KEY env var" });

    const ip: string = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
    const now = Date.now();

    // In-memory fast path: blocked on THIS replica already
    const attempt = loginAttempts.get(ip);
    if (attempt && now < attempt.lockedUntil) {
      return res.status(429).json({ message: "Too many failed attempts — try again in 15 minutes" });
    }
    if (attempt && now >= attempt.lockedUntil) loginAttempts.delete(ip);

    // DB authoritative check: blocks IPs that hit other replicas too
    const dbAttempts = await getFailedAttemptsDb(ip);
    if (dbAttempts >= MAX_ATTEMPTS) {
      // Also lock locally so subsequent checks are fast
      loginAttempts.set(ip, { count: dbAttempts, lockedUntil: now + LOCKOUT_WINDOW_MS });
      return res.status(429).json({ message: "Too many failed attempts — try again in 15 minutes" });
    }

    const { password } = req.body || {};
    let match = false;
    try {
      match =
        typeof password === "string" &&
        password.length === secret.length &&
        crypto.timingSafeEqual(Buffer.from(password), Buffer.from(secret));
    } catch {}

    if (!match) {
      const entry = loginAttempts.get(ip) ?? { count: 0, lockedUntil: 0 };
      entry.count += 1;
      if (entry.count >= MAX_ATTEMPTS) entry.lockedUntil = now + LOCKOUT_WINDOW_MS;
      loginAttempts.set(ip, entry);
      void recordFailedAttemptDb(ip); // cross-replica persistence, fire-and-forget
      return res.status(401).json({ message: "Invalid password" });
    }

    loginAttempts.delete(ip);
    const token = createSessionToken(secret);
    res.cookie("admin_session", token, {
      httpOnly: true,
      sameSite: "strict" as const,
      secure: process.env.NODE_ENV === "production",
      maxAge: 4 * 60 * 60 * 1000,
      path: "/",
    });
    return res.json({ success: true });
  });

  app.get("/api/auth/check", (req: any, res: any) => {
    const secret = process.env.COACH_DASHBOARD_KEY;
    if (!secret) return res.status(503).json({ message: "Dashboard not configured" });
    const cookies = parseCookies(req);
    if (cookies.admin_session && verifySessionToken(cookies.admin_session, secret)) {
      return res.json({ authenticated: true });
    }
    return res.status(401).json({ authenticated: false });
  });

  app.post("/api/auth/logout", (_req: any, res: any) => {
    res.clearCookie("admin_session", { path: "/" });
    return res.json({ success: true });
  });
}
