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
  { key: "PROACTIVE_PAUSED",            severity: "INFO",     hint: "Current proactive messaging state",                                  redact: false },
  { key: "MAX_PROACTIVE_PER_DAY",       severity: "INFO",     hint: "Daily proactive message cap (default 3)",                           redact: false },
  { key: "NORMALIZER",                  severity: "INFO",     hint: "Normalizer killswitch — 'off' disables GPT message rewriting",       redact: false },
  { key: "PAYFAST_SANDBOX",            severity: "INFO",     hint: "PayFast mode — should be empty/absent in production",                redact: false },
];

function redact(value: string): string {
  if (value.length <= 6) return "***";
  return value.slice(0, 4) + "***" + value.slice(-2);
}

let criticalFail = 0;
let warnCount = 0;

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║          KamLife Coach — Environment Diagnostics     ║");
console.log("╚══════════════════════════════════════════════════════╝\n");

for (const v of VARS) {
  const value = process.env[v.key];
  const present = !!value;
  const displayValue = present
    ? (v.redact ? redact(value!) : value!)
    : "— NOT SET —";

  const icon = present
    ? "✅"
    : v.severity === "CRITICAL" ? "❌" : v.severity === "WARN" ? "⚠️ " : "ℹ️ ";

  const status = present ? "PRESENT" : `MISSING (${v.severity})`;

  console.log(`${icon} ${v.key}`);
  console.log(`   Value : ${displayValue}`);
  if (!present) {
    console.log(`   Impact: ${v.hint}`);
    if (v.severity === "CRITICAL") criticalFail++;
    if (v.severity === "WARN") warnCount++;
  }
  console.log();
}

console.log("──────────────────────────────────────────────────────");
if (criticalFail === 0 && warnCount === 0) {
  console.log("✅  All variables present. Ready to deploy.\n");
} else {
  if (criticalFail > 0) console.log(`❌  ${criticalFail} CRITICAL var(s) missing — DO NOT deploy until fixed.`);
  if (warnCount > 0)    console.log(`⚠️   ${warnCount} WARN var(s) missing — investigate before deploy.`);
  console.log();
  process.exit(criticalFail > 0 ? 1 : 0);
}
