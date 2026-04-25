// ============================================================
// SHARED UTILITIES
// Centralises helpers used across routes.ts, gpt.ts, scheduler.ts
// ============================================================

import { SCHEDULER_LIMITS } from "./constants";
import { logger } from "./logger";

// ============================================================
// DISPLAY NAME HELPER — single source of truth
// Prevents using placeholder words (HI, YES, etc.) as names.
// ============================================================

const INVALID_NAMES = new Set([
  "HI", "HEY", "HELLO", "YES", "NO", "OK", "OKAY",
  "MENU", "HELP", "DONE", "USER", "THERE",
]);

export function getDisplayName(user: { name?: string | null }): string {
  if (!user.name || user.name.length < 2) return "";
  if (INVALID_NAMES.has(user.name.toUpperCase())) return "";
  return user.name;
}

// ============================================================
// GPT RATE LIMITER — per-user sliding window (in-memory)
// Max SCHEDULER_LIMITS.GPT_RATE_LIMIT_PER_MIN calls per minute.
// ============================================================

const gptCallTimestamps = new Map<string, number[]>();

export function checkGptRateLimit(userId: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const windowMs = 60_000;
  const maxCalls = SCHEDULER_LIMITS.GPT_RATE_LIMIT_PER_MIN;

  const timestamps = (gptCallTimestamps.get(userId) || []).filter(t => now - t < windowMs);

  if (timestamps.length >= maxCalls) {
    const oldest = timestamps[0];
    const retryAfterMs = windowMs - (now - oldest);
    logger.warn("utils", `GPT rate limit hit for user ${userId.slice(-6)} — ${timestamps.length}/${maxCalls} calls in last 60s`);
    return { allowed: false, retryAfterMs };
  }

  timestamps.push(now);
  gptCallTimestamps.set(userId, timestamps);
  return { allowed: true, retryAfterMs: 0 };
}

// Prune stale rate-limit entries every 5 minutes to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of gptCallTimestamps) {
    const fresh = timestamps.filter(t => now - t < 60_000);
    if (fresh.length === 0) {
      gptCallTimestamps.delete(userId);
    } else {
      gptCallTimestamps.set(userId, fresh);
    }
  }
}, 5 * 60_000);

// ============================================================
// TWILIO CIRCUIT BREAKER
// Opens after TWILIO_CIRCUIT_FAILURE_THRESHOLD consecutive failures.
// Resets to half-open after TWILIO_CIRCUIT_RESET_MS, then closes on success.
// ============================================================

type CircuitState = "closed" | "open" | "half-open";

let twilioCircuitState: CircuitState = "closed";
let twilioFailureCount = 0;
let twilioOpenedAt = 0;

export function isTwilioCircuitOpen(): boolean {
  if (twilioCircuitState === "closed") return false;

  if (twilioCircuitState === "open") {
    const elapsed = Date.now() - twilioOpenedAt;
    if (elapsed >= SCHEDULER_LIMITS.TWILIO_CIRCUIT_RESET_MS) {
      twilioCircuitState = "half-open";
      logger.info("utils", "Twilio circuit breaker: half-open — attempting reset");
      return false; // allow one probe request through
    }
    return true; // still open
  }

  // half-open: allow through
  return false;
}

export function recordTwilioSuccess(): void {
  if (twilioCircuitState !== "closed") {
    logger.info("utils", "Twilio circuit breaker: closed (recovered)");
  }
  twilioCircuitState = "closed";
  twilioFailureCount = 0;
}

export function recordTwilioFailure(): void {
  twilioFailureCount++;
  if (twilioCircuitState === "half-open" || twilioFailureCount >= SCHEDULER_LIMITS.TWILIO_CIRCUIT_FAILURE_THRESHOLD) {
    twilioCircuitState = "open";
    twilioOpenedAt = Date.now();
    logger.error("utils", `Twilio circuit breaker: OPEN after ${twilioFailureCount} failures — pausing sends for ${SCHEDULER_LIMITS.TWILIO_CIRCUIT_RESET_MS / 1000}s`);
  }
}

export function getTwilioCircuitStatus(): { state: CircuitState; failures: number } {
  return { state: twilioCircuitState, failures: twilioFailureCount };
}

// ============================================================
// GRACEFUL SHUTDOWN HANDLER
// Registers SIGTERM/SIGINT handlers to drain in-flight requests.
// Call registerGracefulShutdown(httpServer) once at startup.
// ============================================================

import type { Server } from "http";

export function registerGracefulShutdown(server: Server): void {
  const SHUTDOWN_TIMEOUT_MS = 10_000;

  function shutdown(signal: string): void {
    logger.info("utils", `${signal} received — starting graceful shutdown`);

    server.close((err) => {
      if (err) {
        logger.error("utils", "Error closing HTTP server during shutdown", err);
        process.exit(1);
      }
      logger.info("utils", "HTTP server closed — all connections drained");
      process.exit(0);
    });

    // Force-kill if drain takes too long
    setTimeout(() => {
      logger.error("utils", `Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  }

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT",  () => shutdown("SIGINT"));
}
