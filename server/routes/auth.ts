import type { Express, Request } from "express";
import crypto from "crypto";

function createSessionToken(secret: string): string {
  const exp = Date.now() + 24 * 60 * 60 * 1000;
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
  const cookies = parseCookies(req);
  if (cookies.admin_session && verifySessionToken(cookies.admin_session, secret)) return next();

  // 2. Header fallback — server-rendered /coach page uses x-dashboard-key directly
  const provided = (req.headers["x-dashboard-key"] as string) || "";
  if (provided.length > 0 && provided.length === secret.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret))) return next();
    } catch {}
  }

  return res.status(401).json({ message: "Unauthorized" });
}

// Brute-force protection for the login endpoint (in-memory, per IP)
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (now > entry.lockedUntil + 60_000) loginAttempts.delete(ip);
  }
}, 5 * 60_000);

export function registerAuthRoutes(app: Express) {
  app.post("/api/auth/login", (req: any, res: any) => {
    const secret = process.env.COACH_DASHBOARD_KEY;
    if (!secret) return res.status(503).json({ message: "Dashboard not configured — set COACH_DASHBOARD_KEY env var" });

    const ip: string = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (attempt && now < attempt.lockedUntil) {
      return res.status(429).json({ message: "Too many failed attempts — try again in 15 minutes" });
    }
    if (attempt && now >= attempt.lockedUntil) loginAttempts.delete(ip);

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
      if (entry.count >= 5) entry.lockedUntil = now + 15 * 60_000;
      loginAttempts.set(ip, entry);
      return res.status(401).json({ message: "Invalid password" });
    }

    loginAttempts.delete(ip);
    const token = createSessionToken(secret);
    res.cookie("admin_session", token, {
      httpOnly: true,
      sameSite: "strict" as const,
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000,
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
