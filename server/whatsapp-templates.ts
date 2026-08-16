/**
 * WHATSAPP TEMPLATE REGISTRY — the messages the coach is allowed to send first.
 *
 * (2026-07-29, founder: "I want to get approval this week.")
 *
 * WhatsApp only permits freeform text inside 24 hours of the CLIENT's last message. Outside
 * that window every send is rejected (Twilio 63016) unless it is an APPROVED TEMPLATE. This
 * codebase has 24 proactive job files and, until now, exactly one template slot — empty. So a
 * client who did not message yesterday silently receives no morning message, no weekly check,
 * and no payment alert. Fail-open, and invisible, at the one point where the product is supposed
 * to speak first.
 *
 * Approval is the unblock, and approval is where the days go: Meta reviews each template and a
 * rejection costs a day. Almost every rejection is MECHANICAL — a placeholder at the start of the
 * body, a gap in the numbering, a promotional word in a UTILITY template. So the texts live here
 * as data and `validateTemplate` checks them against the real rejection causes offline, before
 * submission, where a mistake costs nothing.
 *
 * Submit with:  npx tsx script/template-pack.ts
 * Then paste each approved "HX…" SID into the Railway variable named in `env`.
 */

/** Meta's categories. UTILITY is cheaper and cannot be muted; MARKETING can be blocked. */
export type TemplateCategory = "UTILITY" | "MARKETING";

export interface WaTemplate {
  /** Meta template name: lowercase, digits and underscores only. */
  name: string;
  category: TemplateCategory;
  /** The Railway variable the approved "HX…" SID goes into. */
  env: string;
  /** What stops working while this is unapproved — in client terms. */
  unblocks: string;
  /** Body text. `{{1}}`, `{{2}}` … are filled at send time. */
  body: string;
  /** What each placeholder means, in order. `vars[0]` is `{{1}}`. */
  vars: string[];
  /** Sample values — Meta requires one per placeholder with the submission. */
  samples: string[];
  footer?: string;
}

/**
 * MARKETING vs UTILITY is not a preference. Meta re-categorises anything that reads as
 * promotion or re-engagement, and a re-categorised template costs more and can be muted by the
 * client. Declaring it honestly up front avoids a rejection cycle.
 */
const PROMO_WORDS = /\b(free|discount|offer|sale|deal|promo|limited time|sign up now|special|bonus|save \d|% off|miss out|exclusive)\b/i;

export const TEMPLATES: WaTemplate[] = [
  {
    name: "kamlife_daily_plan",
    category: "UTILITY",
    env: "TWILIO_DAILY_TEMPLATE_SID",
    unblocks: "The morning message. Without it, nobody who was quiet yesterday hears from the coach today.",
    body:
      "Morning {{1}} — your KamLife plan for today is ready.\n\n" +
      "Today's one thing: {{2}}\n\n" +
      "Reply here to log your food, steps or session. Everything you have logged is still saved.",
    vars: ["Client's first name", "Today's one action (from one-action.ts)"],
    samples: ["Thandi", "Log one meal — even just what you had for lunch"],
  },
  {
    name: "kamlife_weekly_check",
    category: "UTILITY",
    env: "TWILIO_WEEKLY_TEMPLATE_SID",
    unblocks: "The 7-day progress check. Without it, the weekly review only reaches clients who happened to message that day.",
    body:
      "Your 7-day KamLife check is ready, {{1}}.\n\n" +
      "Sessions this week: {{2}}\n" +
      "Days you logged food: {{3}}\n\n" +
      "Reply *progress* for the full breakdown and what to fix first.",
    vars: ["Client's first name", "Sessions done vs planned", "Days food was logged"],
    samples: ["Thandi", "2 of 3", "5 of 7"],
  },
  {
    name: "kamlife_payment_failed",
    category: "UTILITY",
    env: "TWILIO_PAYMENT_TEMPLATE_SID",
    unblocks: "Failed-payment alerts. Without it, a client's subscription lapses and the first they know is the coach going quiet.",
    body:
      "Hi {{1}} — your KamLife payment of R{{2}} did not go through, so your coaching is on hold.\n\n" +
      "Reply *pay* and I will send you a fresh link. Nothing you have logged is lost.",
    vars: ["Client's first name", "Amount in rand"],
    samples: ["Thandi", "199"],
  },
  {
    // The 63016 recovery path in scheduler/shared.ts. DELIBERATELY HAS NO PLACEHOLDERS:
    // that call site is inside sendWhatsApp's error handler, where the only thing known about
    // the client is their phone number — no name, no day count. A template sent with unfilled
    // placeholders renders blank or is rejected outright, which would turn the one path back
    // into a silent chat into a second silent failure. Personalisation is not worth that.
    // Enforced by a unit test; do not add variables here.
    name: "kamlife_checking_in",
    category: "MARKETING",
    env: "TWILIO_REENGAGE_TEMPLATE_SID",
    unblocks: "Reaching a client who has gone quiet — the only way back into a chat that has been silent for over 24 hours.",
    body:
      "It is Coach K checking in. You have been quiet for a bit and I am not writing you off.\n\n" +
      "There is no catching up to do and nothing you logged is lost. Reply with one word and we start from today.",
    vars: [],
    samples: [],
  },
];

/**
 * The template sent automatically when a freeform message is rejected for being outside the
 * 24-hour window. Must stay variable-free — see the note on the entry itself.
 */
export const WINDOW_RECOVERY_TEMPLATE = "kamlife_checking_in";

// ── Validation: the mechanical reasons Meta rejects a template ───────────────────────────────
// Every rule here is a real rejection cause. Catching them offline is the difference between
// approval this week and one template per day for four days.

const PLACEHOLDER = /\{\{(\d+)\}\}/g;

/** The placeholder numbers used in a body, in the order they appear. */
export function placeholders(body: string): number[] {
  return [...body.matchAll(PLACEHOLDER)].map(m => parseInt(m[1], 10));
}

export function validateTemplate(t: WaTemplate): string[] {
  const problems: string[] = [];
  const body = t.body;

  if (!/^[a-z0-9_]{1,512}$/.test(t.name)) {
    problems.push(`name "${t.name}" must be lowercase letters, digits and underscores only`);
  }
  if (!body.trim()) problems.push("body is empty");
  if (body.length > 1024) problems.push(`body is ${body.length} chars — Meta's limit is 1024`);
  if (t.footer && t.footer.length > 60) problems.push(`footer is ${t.footer.length} chars — Meta's limit is 60`);

  const nums = placeholders(body);
  const unique = [...new Set(nums)].sort((a, b) => a - b);
  for (let i = 0; i < unique.length; i++) {
    if (unique[i] !== i + 1) {
      problems.push(`placeholders must run 1,2,3… with no gaps — found {{${unique.join("}}, {{")}}}`);
      break;
    }
  }
  const trimmed = body.trim();
  if (/^\{\{\d+\}\}/.test(trimmed)) problems.push("body starts with a placeholder — put a real word first");
  if (/\{\{\d+\}\}$/.test(trimmed)) problems.push("body ends with a placeholder — put a real word last");
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(body)) problems.push("two placeholders are adjacent — put real text between them");

  if (t.vars.length !== unique.length) problems.push(`${unique.length} placeholder(s) in the body but ${t.vars.length} described in vars`);
  if (t.samples.length !== unique.length) problems.push(`${unique.length} placeholder(s) but ${t.samples.length} sample value(s) — Meta requires one each`);
  t.samples.forEach((s, i) => {
    if (!s.trim()) problems.push(`sample for {{${i + 1}}} is empty`);
    if (/[\n\t]/.test(s)) problems.push(`sample for {{${i + 1}}} contains a newline or tab`);
  });

  if (/\*\*[^*]+\*\*/.test(body)) problems.push('"**bold**" is markdown, not WhatsApp — use *bold*');
  if (/ {4,}/.test(body)) problems.push("four or more consecutive spaces — Meta strips or rejects these");
  if (/[ \t]+$/m.test(body)) problems.push("a line ends with trailing whitespace");

  if (t.category === "UTILITY" && PROMO_WORDS.test(body)) {
    const hit = (body.match(PROMO_WORDS) || [])[0];
    problems.push(`declared UTILITY but reads as promotion ("${hit}") — Meta will re-categorise it to MARKETING`);
  }

  return problems;
}

export function invalidTemplates(list: WaTemplate[] = TEMPLATES): Array<{ name: string; problems: string[] }> {
  return list
    .map(t => ({ name: t.name, problems: validateTemplate(t) }))
    .filter(r => r.problems.length > 0);
}

// ── Wiring: from an approved SID to an actual send ───────────────────────────────────────────

/** The approved SID for a template, or "" if it has not been submitted/pasted into Railway yet. */
const TEMPLATE_ENV_VALUES: Record<string, string | undefined> = {
  TWILIO_DAILY_TEMPLATE_SID: process.env.TWILIO_DAILY_TEMPLATE_SID,
  TWILIO_WEEKLY_TEMPLATE_SID: process.env.TWILIO_WEEKLY_TEMPLATE_SID,
  TWILIO_PAYMENT_TEMPLATE_SID: process.env.TWILIO_PAYMENT_TEMPLATE_SID,
  TWILIO_REENGAGE_TEMPLATE_SID: process.env.TWILIO_REENGAGE_TEMPLATE_SID,
};

export function templateSid(name: string): string {
  const t = TEMPLATES.find(x => x.name === name);
  if (!t) return "";
  return (TEMPLATE_ENV_VALUES[t.env] || "").trim();
}

/** Templates with no SID in the environment — i.e. the proactive messages that cannot go out. */
export function unwiredTemplates(): WaTemplate[] {
  return TEMPLATES.filter(t => !templateSid(t.name));
}

/** True once every template has an approved SID — the condition for proactive messaging to work. */
export function templatesReady(): boolean {
  return unwiredTemplates().length === 0;
}
