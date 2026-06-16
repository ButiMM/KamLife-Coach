/**
 * diagnose:env — infrastructure smoke check for Railway deploys.
 *
 * Prints every required env var as PRESENT / MISSING / REDACTED-VALUE
 * without printing secrets. Run before every production deploy.
 *
 * Usage: npm run diagnose:env
 */

const VARS: Array<{
  key: string;
  severity: "CRITICAL" | "WARN" | "INFO";
  hint: string;
  redact?: boolean;
}> = [
  { key: "DATABASE_URL",                  severity: "CRITICAL", hint: "PostgreSQL — app will crash without this",                          redact: true },
  { key: "TWILIO_ACCOUNT_SID",            severity: "CRITICAL", hint: "WhatsApp messages will not send",                                   redact: false },
  { key: "TWILIO_AUTH_TOKEN",             severity: "CRITICAL", hint: "Twilio webhook signatures won't verify — all WA traffic rejected",  redact: true },
  { key: "TWILIO_WHATSAPP_NUMBER",        severity: "CRITICAL", hint: "WhatsApp messages have no sender number",                           redact: false },
  { key: "AI_INTEGRATIONS_OPENAI_API_KEY",severity: "CRITICAL", hint: "GPT coaching responses will fail (all handlers fall to fallbacks)", redact: true },
  { key: "COACH_DASHBOARD_KEY",           severity: "WARN",     hint: "Dashboard admin access blocked",                                    redact: true },
  { key: "PAYFAST_MERCHANT_ID",           severity: "CRITICAL", hint: "Payment links will not generate",                                   redact: false },
  { key: "PAYFAST_MERCHANT_KEY",          severity: "CRITICAL", hint: "PayFast link generation fails",                                     redact: true },
  { key: "PAYFAST_PASSPHRASE",            severity: "CRITICAL", hint: "ITN signature validation rejects ALL payments — nobody gets activated", redact: true },
  { key: "APP_URL",                       severity: "WARN",     hint: "Payment links use wrong domain — set to Railway URL",               redact: false },
  { key: "COACH_ALERT_PHONE",            severity: "WARN",     hint: "Coach NOT notified on safety alerts or crisis messages",            redact: false },
  { key: "TWILIO_SMS_NUMBER",            severity: "INFO",     hint: "SMS fallback for critical payment alerts disabled",                  redact: false },
  { key: "MEDIA_BASE_URL",              severity: "INFO",     hint: "CDN for exercise GIFs — static fallbacks used until set",            redact: false },
  { key: "PROACTIVE_PAUSED",            severity: "INFO",     hint: "NOT SET = proactive messaging is ACTIVE. Set to 'true' to pause all proactive sends.", redact: false },
  { key: "MAX_PROACTIVE_PER_DAY",       severity: "INFO",     hint: "Daily proactive message cap (default 3)",                           redact: false },
  { key: "NORMALIZER",                  severity: "INFO",     hint: "Normalizer killswitch — 'off' disables GPT message rewriting",       redact: false },
  { key: "PAYFAST_SANDBOX",            severity: "INFO",     hint: "PayFast mode — should be empty/absent in production",                redact: false },
];

function redact(value: string): string {
  if (value.length <= 6) return "***";
  return value.slice(0, 4) + "***" + value.slice(-2);
}

/**
 * Presence is NOT validity. A var can be SET to an obvious placeholder (the PayFast
 * "your-merchant-id" defaults) or be malformed (the variable NAME pasted into the
 * value field, e.g. value = "MEDIA_BASE_URL=https://..."). Either way the app is
 * misconfigured even though the var technically "exists" — which is exactly the
 * false-green this script used to print. Returns a human reason, or null if it looks real.
 */
function looksLikePlaceholder(key: string, raw: string): string | null {
  const v = raw.trim();
  const lower = v.toLowerCase();
  if (v.includes(`${key}=`))
    return `the value contains "${key}=" — the variable NAME was pasted into the value field`;
  if (lower.includes("placeholder"))
    return "contains the word 'placeholder'";
  if (/\.invalid(\b|\/|$)/.test(lower))
    return "points at the reserved .invalid domain (never resolves)";
  if (/^your[-_ .]/.test(lower))
    return "starts with 'your-' — this is the default placeholder, not a real value";
  if (/(^|[^a-z])example\.com($|[^a-z])/.test(lower))
    return "points at example.com";
  if (["changeme", "change-me", "todo", "tbd", "xxx", "dummy", "your-value", "value"].includes(lower))
    return `is the literal "${v}"`;
  return null;
}

let criticalFail = 0;
let warnCount = 0;
let placeholderCount = 0;

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║          KamLife Coach — Environment Diagnostics     ║");
console.log("╚══════════════════════════════════════════════════════╝\n");

for (const v of VARS) {
  const value = process.env[v.key];
  const present = !!value;
  const placeholderReason = present ? looksLikePlaceholder(v.key, value!) : null;
  const displayValue = present
    ? (v.redact ? redact(value!) : value!)
    : "— NOT SET —";

  let icon: string;
  if (!present) {
    icon = v.severity === "CRITICAL" ? "❌" : v.severity === "WARN" ? "⚠️ " : "ℹ️ ";
  } else if (placeholderReason) {
    icon = "🔶";
  } else {
    icon = "✅";
  }

  console.log(`${icon} ${v.key}`);
  console.log(`   Value : ${displayValue}`);

  if (!present) {
    console.log(`   Impact: ${v.hint}`);
    if (v.severity === "CRITICAL") criticalFail++;
    if (v.severity === "WARN") warnCount++;
  } else if (placeholderReason) {
    placeholderCount++;
    console.log(`   ⚠️  PLACEHOLDER — ${placeholderReason}`);
    console.log(`   Impact: ${v.hint}`);
    // A placeholder in a CRITICAL/WARN var is as broken as the var being missing.
    if (v.severity === "CRITICAL") criticalFail++;
    else if (v.severity === "WARN") warnCount++;
  }
  console.log();
}

console.log("──────────────────────────────────────────────────────");
if (placeholderCount > 0) {
  console.log(`🔶  ${placeholderCount} variable(s) are set to placeholder/malformed values — fix the ones flagged above.`);
}
if (criticalFail === 0 && warnCount === 0 && placeholderCount === 0) {
  console.log("✅  All variables present and real. Ready to deploy.\n");
} else if (criticalFail === 0 && warnCount === 0) {
  console.log("⚠️   No missing/critical blockers, but the placeholder value(s) above must be fixed before launch.\n");
} else {
  if (criticalFail > 0) console.log(`❌  ${criticalFail} CRITICAL var(s) missing or placeholder — DO NOT deploy until fixed.`);
  if (warnCount > 0)    console.log(`⚠️   ${warnCount} WARN var(s) missing or placeholder — investigate before deploy.`);
  console.log();
}
process.exit(criticalFail > 0 ? 1 : 0);
