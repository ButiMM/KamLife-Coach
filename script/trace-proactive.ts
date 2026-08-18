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
// adaptiveInputFrom is the projection the SCHEDULED JOB uses — not a copy of it. adaptive-targets
// is pure, so this trace exercises the real path instead of a mirror that can drift.
const { adaptTargets, adaptiveInputFrom } = await import("../server/adaptive-targets");
const { contactState } = await import("../server/understanding/reentry");

const argv = process.argv.slice(2);
const DAYS = Number((argv.find(a => a.startsWith("--days=")) || "--days=1").split("=")[1]) || 1;

const W = 98;
const rule = (t = "") => console.log(t ? `\n${"═".repeat(2)} ${t} ${"═".repeat(Math.max(0, W - t.length - 4))}` : "─".repeat(W));

// A fixture is now a ProactiveState — the SAME structure both scheduled jobs read at runtime,
// shaped here by hand instead of by loadProactiveState (which needs a database). The fields are
// the contract, so a field either job stops honouring shows up here as a compile error.
type State = import("../server/scheduler/shared").ProactiveState;
interface Client { name: string; why: string; state: State; recentMessages: string[] }

const now = Date.now();
const ago = (d: number) => new Date(now - d * 86_400_000).toISOString();

/** Everything a healthy, well-logged 80kg client looks like. Each case overrides what it is about. */
const base = (over: Partial<State> = {}): State => ({
  userId: "trace", phone: "+27000000000", name: "Trace", goalType: "fat_loss", weightKg: 80,
  baseline: { calories: 2000, protein: 150, steps: 8000 },
  current: { calories: 2000, protein: 150, steps: 8000 },
  health: { sick: false, sickYesterday: false, recovering: false, daysSick: 0 },
  food: { avgKcal7d: null, avgProtein7d: null, loggedDays7d: null },
  workout: { sessionsLast7d: 0, daysSinceLastSession: null },
  steps: { avg7d: null },
  weight: { weeklyKgChange: null, trendUsable: false, stalledWeeks: 0 },
  reentry: contactState(ago(0)),
  evidence: { foodSufficient: false, weightSufficient: false },
  ...over,
});

const CLIENTS: Client[] = [
  {
    name: "STALLED — the ratchet", why: "3 weeks flat, logging well, eating close to target",
    recentMessages: ["did 8000 steps", "chicken and pap for lunch"],
    state: base({
      food: { avgKcal7d: 1980, avgProtein7d: 145, loggedDays7d: 7 },
      weight: { weeklyKgChange: 0, trendUsable: true, stalledWeeks: 3 },
      evidence: { foodSufficient: true, weightSufficient: true },
    }),
  },
  {
    name: "SICK — durable vs keyword", why: "not sick; mentioned someone else being sick",
    recentMessages: ["my mom is sick so I skipped gym", "had eggs"],
    state: base(),
  },
  {
    name: "RE-ENTRY — 10 days quiet", why: "returning client; must not be punished",
    recentMessages: ["I'm back, sorry I've been busy"],
    state: base({ reentry: contactState(ago(10)) }),
  },
  {
    name: "ON TRACK — nothing to say", why: "hitting targets; least intervention applies",
    recentMessages: ["morning", "logged breakfast"],
    state: base({
      food: { avgKcal7d: 1960, avgProtein7d: 148, loggedDays7d: 6 },
      steps: { avg7d: 8200 },
      weight: { weeklyKgChange: -0.4, trendUsable: true, stalledWeeks: 0 },
      evidence: { foodSufficient: true, weightSufficient: true },
    }),
  },
];

// ── Structural facts, read from source so they cannot drift from the code ────────────────────
const adaptiveSrc = readFileSync("server/scheduler/jobs/adaptive.ts", "utf-8");
const morningSrc = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
const sharedSrc = readFileSync("server/scheduler/shared.ts", "utf-8");
/** Count CODE only. Counting raw source made this instrument report a call site that was a
 *  sentence in a comment about having removed that call — the trace lying about the fix. */
const strip = (s: string) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const countOf = (s: string, re: RegExp) => (strip(s).match(re) || []).length;

console.log("═".repeat(W));
console.log("PROACTIVE MORNING TRACE — Issue #49 step 1");
console.log("═".repeat(W));

rule("THE TWO JOBS, AS WIRED");
const adaptiveSends = countOf(adaptiveSrc, /sendWhatsApp\(/g);
console.log(`  05:45 SAST  runAdaptiveTargets   sends: ${adaptiveSends}   claim sites: ${countOf(adaptiveSrc, /claimDailySlot\(/g)}`);
console.log(`  06:00 SAST  runMorningCheckin    sends: ${countOf(morningSrc, /sendWhatsApp(Buttons)?\(/g)}   claim sites: ${countOf(morningSrc, /claimDailySlot\(/g)}`);
console.log(`  Counts do NOT map 1:1 and are not the claim: morning's sends at :136 :148 :150 share`);
console.log(`  the one claim at :126, and :106 sits under :96. Read them — every morning send is`);
console.log(`  inside a claimed block. Adaptive's ${adaptiveSends} are inside none.`);

rule("SHARED STATE — do both jobs read one structure?");
console.log(`  loadProactiveState defined in scheduler/shared.ts: ${/export async function loadProactiveState/.test(sharedSrc)}`);
console.log(`  adaptive.ts loads it: ${countOf(adaptiveSrc, /loadProactiveState\(/g)} site(s)`
  + `   morning.ts loads it: ${countOf(morningSrc, /loadProactiveState\(/g)} site(s)`);

rule("HEALTH TRUTH — which source decides TODAY");
const SICK_RE = /\b(sick|ill|flu|injur|hurt|pain|rest day|skip)\b/i;
console.log(`  wasSickOrInjured() (chat_history, last 20 inbound, regex) still exists: `
  + `${/export async function wasSickOrInjured/.test(sharedSrc)}`);
console.log(`  but morning.ts calls it at: ${countOf(morningSrc, /wasSickOrInjured\(/g)} site(s) — health is durable now`);
console.log(`  still keyword-driven elsewhere: evening.ts, retention.ts (audit/analytics, next sweep)`);
console.log(`  NOTE the scan could only ever be wrong in morning: sick-flow writes paused_until`);
console.log(`  beside sick_until, and morning returns on isPaused() long before the sick branch —`);
console.log(`  so a genuinely ill client never reached it. Only false positives did.`);

// ── Per-client ────────────────────────────────────────────────────────────────────────────────
for (const c of CLIENTS) {
  rule(c.name);
  console.log(`  ${c.why}`);

  const s = c.state;
  console.log(`  state: baseline ${s.baseline.calories} · current ${s.current.calories}`
    + ` · logged ${s.food.loggedDays7d === null ? "unread" : `${s.food.loggedDays7d}d`} · avg ${s.food.avgKcal7d ?? "unread"} kcal`
    + ` · stalled ${s.weight.stalledWeeks}w · trend ${s.weight.trendUsable ? `${s.weight.weeklyKgChange}kg/wk` : "unusable"}`
    + ` · sick ${s.health.sick}`);

  // ADAPTIVE — really computed, through the job's own projection. Compounds across N mornings.
  let baseline = s.baseline.calories;
  // What the client currently HOLDS. The job's guard compares its output against this, not against
  // the baseline it reasoned from — post-0005 those are different things, and modelling only the
  // base would report a send every morning when the real job goes quiet after the first.
  let overlay = { ...s.current };
  let adaptiveWouldSend = false;
  let sendCount = 0;
  for (let day = 1; day <= DAYS; day++) {
    const today: State = { ...s, baseline: { ...s.baseline, calories: baseline }, current: { ...overlay } };
    const out = adaptTargets(adaptiveInputFrom(today));
    // The job's own send gates, mirrored from adaptive.ts.
    const noteOnly = out.reason === "stalled_unlogged" || out.reason === "stalled_over_target";
    const targetsMoved = out.calorieTarget !== overlay.calories || out.proteinTarget !== overlay.protein || out.stepsTarget !== overlay.steps;
    const sends = out.changed && (noteOnly || targetsMoved) && !!out.note;
    if (sends) { adaptiveWouldSend = true; sendCount++; }
    console.log(`  adaptive day ${day}: baseline ${baseline} → ${out.calorieTarget}  reason=${out.reason}  `
      + `sends=${sends ? "YES (unbudgeted)" : "no"}`);
    if (sends && day === 1) console.log(`     "${out.note.slice(0, 88)}…"`);
    // After 0005 the job reads users.baselineCalorieTarget — which it never writes — so the base
    // does NOT become tomorrow's input. Set TRACE_RECURSIVE=1 to reproduce the pre-0005 ratchet.
    if (process.env.TRACE_RECURSIVE === "1") baseline = out.calorieTarget;
    overlay = { calories: out.calorieTarget, protein: out.proteinTarget, steps: out.stepsTarget };
  }
  if (DAYS > 1) console.log(`  → ${sendCount} proactive send(s) from adaptive across ${DAYS} mornings`);
  if (DAYS > 1 && baseline !== s.baseline.calories) {
    const pct = Math.round(((s.baseline.calories - baseline) / s.baseline.calories) * 1000) / 10;
    console.log(`  → ${DAYS} mornings from one baseline: ${s.baseline.calories} → ${baseline} (${pct}% down), because`);
    console.log(`    the job fed its own STORED target back in as baseCalories. No baseline column existed.`);
  }

  // MORNING — reads the SAME structure now for the two facts that decide whether it speaks.
  // Everything else it composes is still its own; that is the next step, not this one.
  const keywordSaysSick = c.recentMessages.some(t => SICK_RE.test(t));
  console.log(`  morning: re-entry ${s.reentry.isReturning ? `RETURNING (${s.reentry.daysSinceLastContact}d)` : "current"}`
    + `  ·  durable sick yesterday=${s.health.sickYesterday}  ·  old keyword scan said sick=${keywordSaysSick}`);
  if (keywordSaysSick && !s.health.sickYesterday) {
    console.log(`     ✓ SPLIT TRUTH CLOSED: the scan matched "${c.recentMessages.find(t => SICK_RE.test(t))}"`);
    console.log(`       and morning now ignores it — health comes from the durable token both jobs read.`);
  }
  console.log(`  morning would claim the daily slot and send: yes (every one of its sends is gated)`);

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
