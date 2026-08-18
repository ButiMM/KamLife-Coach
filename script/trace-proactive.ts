/**
 * TRACE THE PROACTIVE MORNING — what the scheduled jobs read, decide, and would send.
 *
 * (2026-08-18, Issue #49 step 1.) script/trace-turn.ts made a REACTIVE turn observable and that
 * immediately found three real defects. The proactive path had no equivalent, and that is exactly
 * where the product is failing under live use: two jobs, fifteen minutes apart, both able to speak,
 * only one of them budgeted.
 *
 *   05:45 SAST  runAdaptiveTargets   scheduler.ts:201   sends at adaptive.ts:128 and :151
 *   06:00 SAST  runMorningCheckin    scheduler.ts:202   sends at 6 points, ALL slot-claimed
 *
 * Neither adaptive send passes claimDailySlot. So a client whose targets move gets the adaptive
 * message AND, a quarter of an hour later, the morning message — from what is supposed to be one
 * coach. This prints that collision per client instead of leaving it to be reasoned about.
 *
 * HONEST LIMIT, stated rather than hidden: runMorningCheckin cannot be executed here. It needs a
 * database and it sends. What this trace shows for morning is STRUCTURAL and read from source —
 * which health source it trusts, which sends are budgeted — not a simulated decision. Everything
 * shown for adaptive is really computed: adaptTargets is pure and this calls it.
 *
 *   npx tsx script/trace-proactive.ts
 *   npx tsx script/trace-proactive.ts --days=4      compound the same client N mornings
 */

process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-trace-offline";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";
process.env.PROACTIVE_PAUSED = "true";

import { readFileSync } from "node:fs";
const { adaptTargets } = await import("../server/adaptive-targets");
const { contactState } = await import("../server/understanding/reentry");

const argv = process.argv.slice(2);
const DAYS = Number((argv.find(a => a.startsWith("--days=")) || "--days=1").split("=")[1]) || 1;

const W = 98;
const rule = (t = "") => console.log(t ? `\n${"═".repeat(2)} ${t} ${"═".repeat(Math.max(0, W - t.length - 4))}` : "─".repeat(W));

interface Client {
  name: string; why: string;
  baseCalories: number; baseProtein: number; baseSteps: number; weightKg: number;
  sick?: boolean; daysSick?: number; recovering?: boolean;
  weeklyKgChange?: number; stalledWeeks?: number; avgSteps7d?: number;
  avgKcal7d?: number; loggedDays7d?: number;
  lastActiveAt: string | null;
  /** What a durable sick_until token would say vs what the last 20 messages contain. */
  durableSickUntil?: string | null; recentMessages: string[];
}

const now = Date.now();
const ago = (d: number) => new Date(now - d * 86_400_000).toISOString();

const CLIENTS: Client[] = [
  {
    name: "STALLED — the ratchet", why: "3 weeks flat, logging well, eating close to target",
    baseCalories: 2000, baseProtein: 150, baseSteps: 8000, weightKg: 80,
    stalledWeeks: 3, loggedDays7d: 7, avgKcal7d: 1980, weeklyKgChange: 0,
    lastActiveAt: ago(0), recentMessages: ["did 8000 steps", "chicken and pap for lunch"],
  },
  {
    name: "SICK — durable vs keyword", why: "not sick; mentioned someone else being sick",
    baseCalories: 2000, baseProtein: 150, baseSteps: 8000, weightKg: 80,
    sick: false, lastActiveAt: ago(0), durableSickUntil: null,
    recentMessages: ["my mom is sick so I skipped gym", "had eggs"],
  },
  {
    name: "RE-ENTRY — 10 days quiet", why: "returning client; must not be punished",
    baseCalories: 2000, baseProtein: 150, baseSteps: 8000, weightKg: 80,
    lastActiveAt: ago(10), recentMessages: ["I'm back, sorry I've been busy"],
  },
  {
    name: "ON TRACK — nothing to say", why: "hitting targets; least intervention applies",
    baseCalories: 2000, baseProtein: 150, baseSteps: 8000, weightKg: 80,
    weeklyKgChange: -0.4, avgSteps7d: 8200, loggedDays7d: 6, avgKcal7d: 1960,
    lastActiveAt: ago(0), recentMessages: ["morning", "logged breakfast"],
  },
];

// ── Structural facts, read from source so they cannot drift from the code ────────────────────
const adaptiveSrc = readFileSync("server/scheduler/jobs/adaptive.ts", "utf-8");
const morningSrc = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
const sharedSrc = readFileSync("server/scheduler/shared.ts", "utf-8");
const countOf = (s: string, re: RegExp) => (s.match(re) || []).length;

console.log("═".repeat(W));
console.log("PROACTIVE MORNING TRACE — Issue #49 step 1");
console.log("═".repeat(W));

rule("THE TWO JOBS, AS WIRED");
console.log(`  05:45 SAST  runAdaptiveTargets   sends: ${countOf(adaptiveSrc, /sendWhatsApp\(/g)}   slot-claimed: ${countOf(adaptiveSrc, /claimDailySlot\(/g)}`);
console.log(`  06:00 SAST  runMorningCheckin    sends: ${countOf(morningSrc, /sendWhatsApp(Buttons)?\(/g)}   slot-claimed: ${countOf(morningSrc, /claimDailySlot\(/g)}`);
console.log(`  → every adaptive send bypasses the shared daily budget; every morning send claims it.`);

rule("HEALTH TRUTH — which source decides TODAY");
const keywordScan = /recentMessages\.some\(row => row\.messageIn && SICK_PATTERNS\.test/.test(sharedSrc);
console.log(`  wasSickOrInjured() reads chat_history, last 20 inbound, regex: ${keywordScan}`);
console.log(`  morning.ts calls it at: ${[...morningSrc.matchAll(/wasSickOrInjured\(/g)].length} site(s)`);
console.log(`  durable sick_until / sick_since exist in profileNotes and are NOT what morning asks.`);

// ── Per-client ────────────────────────────────────────────────────────────────────────────────
for (const c of CLIENTS) {
  rule(c.name);
  console.log(`  ${c.why}`);

  // ADAPTIVE — really computed. Compounds across N mornings exactly as the job does.
  let base = c.baseCalories;
  let adaptiveWouldSend = false;
  for (let day = 1; day <= DAYS; day++) {
    const out = adaptTargets({
      baseCalories: base, baseProtein: c.baseProtein, baseSteps: c.baseSteps,
      goalType: "fat_loss", weightKg: c.weightKg,
      sick: !!c.sick, daysSick: c.daysSick, recovering: c.recovering,
      weeklyKgChange: c.weeklyKgChange, stalledWeeks: c.stalledWeeks, avgSteps7d: c.avgSteps7d,
      avgKcal7d: c.avgKcal7d, loggedDays7d: c.loggedDays7d,
    });
    // The job's own send gates, mirrored from adaptive.ts.
    const noteOnly = out.reason === "stalled_unlogged" || out.reason === "stalled_over_target";
    const targetsMoved = out.calorieTarget !== base || out.proteinTarget !== c.baseProtein || out.stepsTarget !== c.baseSteps;
    const sends = out.changed && (noteOnly || targetsMoved) && !!out.note;
    if (sends) adaptiveWouldSend = true;
    console.log(`  adaptive day ${day}: base ${base} → ${out.calorieTarget}  reason=${out.reason}  `
      + `sends=${sends ? "YES (unbudgeted)" : "no"}`);
    if (sends && day === 1) console.log(`     "${out.note.slice(0, 88)}…"`);
    // THE COMPOUNDING: the job writes calorieTarget back, so tomorrow's base is today's output.
    base = out.calorieTarget;
  }
  if (DAYS > 1 && base !== c.baseCalories) {
    const pct = Math.round(((c.baseCalories - base) / c.baseCalories) * 1000) / 10;
    console.log(`  → ${DAYS} mornings from one baseline: ${c.baseCalories} → ${base} (${pct}% down), because`);
    console.log(`    adaptive.ts:96 feeds the STORED target back in as baseCalories. No baseline column exists.`);
  }

  // MORNING — structural, not simulated. Stated as such.
  const re = contactState(c.lastActiveAt);
  const keywordSaysSick = c.recentMessages.some(t => /\b(sick|ill|flu|injur|hurt|pain)\b/i.test(t));
  console.log(`  morning: re-entry ${re.isReturning ? `RETURNING (${re.daysSinceLastContact}d)` : "current"}`
    + `  ·  durable sick=${c.durableSickUntil ? "yes" : "no"}  ·  keyword scan says sick=${keywordSaysSick}`);
  if (keywordSaysSick && !c.durableSickUntil) {
    console.log(`     ⚠ SPLIT TRUTH: morning would read SICK from "${c.recentMessages.find(t => /sick/i.test(t))}"`);
    console.log(`       while the durable state says otherwise. Today's health decided by a regex.`);
  }
  console.log(`  morning would claim the daily slot and send: yes (all 6 of its sends are gated)`);

  // THE COLLISION.
  if (adaptiveWouldSend) {
    console.log(`  ✗ COLLISION: this client receives TWO proactive messages 15 minutes apart —`);
    console.log(`    adaptive at 05:45 (unbudgeted) and morning at 06:00 (budgeted). Two coaches.`);
  } else {
    console.log(`  ✓ one proactive message today (adaptive stayed silent)`);
  }
}

rule();
console.log("Instrument only — nothing written, nothing sent, no model called.");
console.log("Adaptive figures are really computed. Morning is structural, read from source: it");
console.log("cannot be executed without a database and it sends.");
process.exit(0);
