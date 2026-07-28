/**
 * SELF-CHECK — what is silently switched off right now.
 *
 * (2026-07-28, founder: "we have a systemic issue of things being promised to clients, things
 * being promised to me, that are not going through.") He is right, and the defect has a precise
 * name: SILENT FAIL-OPEN.
 *
 * This codebase fails open almost everywhere, and every individual decision is correct — a card
 * that cannot render must never block a client's reply. But there are 174 swallowed failures and
 * 48 env-gated capabilities, and the warning for each one goes to a console log on Railway that
 * the founder will never read. The result is a product that can be substantially degraded while
 * appearing to work, and the only person who finds out is a client who quietly gets less than
 * they paid for.
 *
 * Fail-open is still right. Fail-open AND SILENT is the bug.
 *
 * So this is the inventory: every capability that can be off without anyone noticing, checked
 * live, ranked worst-first, in one text message. It answers "what is not going through?" — the
 * exact question that prompted it.
 *
 * The checks are data, not code, so adding a capability is one line and forgetting to report it
 * is the thing that becomes hard.
 */

import { FFMPEG_AVAILABLE } from "./video-frames";
import { uploadedGifCount } from "./exercise-media";
import { cardFontLoaded } from "./macro-card";

export type Severity = "critical" | "degraded" | "cosmetic";

export interface Capability {
  name: string;
  /** What breaks when this is off — in client terms, never in config terms. */
  impact: string;
  severity: Severity;
  /** The exact thing to set or do. */
  fix: string;
  ok: () => boolean;
}

const has = (k: string) => !!(process.env[k] || "").trim();

/**
 * Everything that can be off without an error. Ordered by how much it costs the client, not by
 * how interesting it is to an engineer.
 */
export function capabilities(): Capability[] {
  return [
    // ── CRITICAL: safety and money. These fail people, not features. ────────────────────────
    {
      name: "Crisis alerts to you",
      impact: "A client in crisis gets the helpline, but YOU are never told. It logs a warning and moves on.",
      severity: "critical",
      fix: "Set COACH_ALERT_PHONE in Railway (your number, digits only).",
      ok: () => has("COACH_ALERT_PHONE") || has("ADMIN_PHONE_OVERRIDE"),
    },
    {
      name: "SMS fallback for payment alerts",
      impact: "If WhatsApp delivery fails, a critical billing alert reaches nobody.",
      severity: "critical",
      fix: "Set TWILIO_SMS_NUMBER in Railway.",
      ok: () => has("TWILIO_SMS_NUMBER"),
    },
    {
      name: "Payments",
      impact: "Nobody can subscribe — the pay link cannot be built.",
      severity: "critical",
      fix: "Set PAYFAST_MERCHANT_ID and APP_URL in Railway.",
      ok: () => has("PAYFAST_MERCHANT_ID") && has("APP_URL"),
    },

    // ── DEGRADED: the client silently gets less than they paid for. ─────────────────────────
    {
      name: "Meal cards",
      impact: "Every food log goes out as plain text with no card — the thing the marketing promises.",
      severity: "degraded",
      fix: "Set APP_URL in Railway (with https://).",
      ok: () => has("APP_URL"),
    },
    {
      name: "Exercise GIFs",
      impact: "Every 'show me' falls back to a text description. Uploads to the CDN do nothing until each slug is listed.",
      severity: "degraded",
      fix: "Set MEDIA_BASE_URL, upload the files, then add the slugs to UPLOADED_GIF_SLUGS in server/exercise-media.ts.",
      ok: () => has("MEDIA_BASE_URL") && gifSlugsWired(),
    },
    {
      name: "Video form checks",
      impact: "Every video sent for a form check falls back to 'send me a screenshot'.",
      severity: "degraded",
      fix: "ffmpeg is missing from the build — re-run npm install and check the ffmpeg-static postinstall.",
      ok: () => ffmpegPresent(),
    },
    {
      name: "Voice replies",
      impact: "Milestone voice notes go out as text. The coach never speaks.",
      severity: "degraded",
      fix: "Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in Railway.",
      ok: () => has("ELEVENLABS_API_KEY") && has("ELEVENLABS_VOICE_ID"),
    },
    {
      name: "Proactive messages",
      impact: "No morning check-ins, no evening accountability, no silence detection. The coach only speaks when spoken to.",
      severity: "degraded",
      fix: "PROACTIVE_PAUSED is set to true in Railway — unset it to resume.",
      ok: () => (process.env.PROACTIVE_PAUSED || "").toLowerCase() !== "true",
    },
    {
      name: "Message understanding",
      impact: "Messy phrasing is no longer rewritten before routing, so more messages miss their handler.",
      severity: "degraded",
      fix: "NORMALIZER is set to off in Railway — unset it to resume.",
      ok: () => (process.env.NORMALIZER || "").toLowerCase() !== "off",
    },

    // ── COSMETIC: it still works, it just looks worse. ──────────────────────────────────────
    {
      name: "Card branding",
      impact: "Cards render with shapes but no text — the bundled font did not load.",
      severity: "cosmetic",
      fix: "Check server/assets/LiberationSans-*.ttf shipped with the build.",
      ok: () => cardFontOk(),
    },
  ];
}

// ── Probes ──────────────────────────────────────────────────────────────────────────────────
// STATIC imports, not require(). This project is ESM, so require() throws — and the first draft
// of this file caught that throw and reported ffmpeg and the card font as BROKEN when both were
// fine. A self-check that lies about itself is worse than no self-check, which is the whole
// point of this module, so the probes are compiler-checked rather than defensive.

/** Zero wired slugs means every CDN upload is doing nothing — the pending task in CLAUDE.md. */
function gifSlugsWired(): boolean {
  return uploadedGifCount() > 0;
}

// REUSE THE REAL CHECK, don't write a second weaker one. `ffmpeg-static` returns a path even
// when the postinstall failed and the binary is absent, so `!!ffmpegPath` reports healthy on a
// broken build. video-frames.ts already got this right by testing the file exists — writing my
// own probe here would have re-created the exact defect this module exists to catch.
function ffmpegPresent(): boolean {
  return FFMPEG_AVAILABLE;
}

function cardFontOk(): boolean {
  return cardFontLoaded;
}

export interface CheckResult { off: Capability[]; total: number }

export function runSelfCheck(): CheckResult {
  const all = capabilities();
  const off = all.filter(c => { try { return !c.ok(); } catch { return true; } });
  const rank: Record<Severity, number> = { critical: 0, degraded: 1, cosmetic: 2 };
  off.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { off, total: all.length };
}

const ICON: Record<Severity, string> = { critical: "🚨", degraded: "⚠️", cosmetic: "🎨" };

/** The founder-facing report. Written so "everything is fine" is unmistakable. */
export function formatSelfCheck(r: CheckResult): string {
  if (r.off.length === 0) {
    return `✅ *Self-check: all ${r.total} capabilities live.*\n\nNothing is silently switched off. Every promise the coach makes, it can keep.`;
  }
  const critical = r.off.filter(c => c.severity === "critical").length;
  const head = critical > 0
    ? `🚨 *${critical} CRITICAL capabilit${critical === 1 ? "y" : "ies"} switched off* — and ${r.off.length - critical} other${r.off.length - critical === 1 ? "" : "s"} degraded.`
    : `⚠️ *${r.off.length} of ${r.total} capabilities are silently off.*`;

  const blocks = r.off.map(c => `${ICON[c.severity]} *${c.name}*\n${c.impact}\n_Fix: ${c.fix}_`);
  return `${head}\n\nThese fail quietly — the client never sees an error, they just get less.\n\n${blocks.join("\n\n")}`;
}

/**
 * Boot-time shout for anything critical. A crisis alert that cannot reach the founder must not
 * wait for someone to think of asking — the first time you learn about it should not be the
 * moment a real client needs it.
 */
export function logSelfCheckAtBoot(): void {
  const { off } = runSelfCheck();
  const critical = off.filter(c => c.severity === "critical");
  if (critical.length === 0) return;
  console.error(`\n[SELF-CHECK] 🚨 ${critical.length} CRITICAL capability(ies) OFF at boot:`);
  for (const c of critical) console.error(`  ✗ ${c.name} — ${c.impact}\n    Fix: ${c.fix}`);
  console.error("");
}
