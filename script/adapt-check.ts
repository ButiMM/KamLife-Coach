/**
 * ADAPT CHECK — does the coach actually read the person in front of it?
 *
 * (2026-07-29, founder: "does it adapt to the client? does it know when they last logged, their
 * patterns, a client that works sixteen-hour shifts, that feels demotivated, that hasn't logged
 * in six weeks and wants to get back?")
 *
 * A fair question that was being answered with opinion. This answers it with the running code:
 * the real scenarios, through the real decision, printed as the client would receive them.
 *
 * Companion to day-transcript.ts — that one reads a single client across a day, this one reads
 * many clients at a single moment. Neither asserts anything. Both exist so the product can be
 * judged by looking at it rather than by arguing about it.
 *
 * Run: npx tsx script/adapt-check.ts
 */

const { chooseAction, formatOneAction } = await import("../server/one-action");
const base = { goal: "fat_loss" as const, weeksOnProgramme: 6, daysSinceWeighIn: 3,
  loggedToday: true, proteinPct: 0.9, caloriePct: 0.9, sessionsThisWeek: 3,
  sessionsTarget: 3, stepsToday: 9000, stepsTarget: 8000, hour: 18 };

const people = [
  ["16-hour shift worker, logged today",
   { ...base, firstName: "Sipho", biggestStruggle: "I work 16 hour shifts and get home after 10pm",
     dreamGoal: "Get my energy back for my kids", proteinPct: 0.3 }],
  ["Gone 3 weeks, wants back in",
   { ...base, firstName: "Nomsa", daysSinceAnyLog: 21, loggedToday: false,
     dreamGoal: "Fit into my old work clothes", biggestStruggle: "I lose motivation after a few weeks" }],
  ["Gone 6 weeks, night shifts",
   { ...base, firstName: "Thabo", daysSinceAnyLog: 42, loggedToday: false,
     biggestStruggle: "night shift, no time to cook" }],
  ["Never weighed, 4 weeks in",
   { ...base, firstName: "Lerato", daysSinceWeighIn: null, dreamGoal: "Lower my blood sugar the healthy way" }],
  ["Sick this week",
   { ...base, firstName: "Ayanda", sick: true, sessionsThisWeek: 0 }],
  ["Doing everything right",
   { ...base, firstName: "Kabelo", dreamGoal: "Run the Comrades next year" }],
];

for (const [label, s] of people as any[]) {
  console.log(`\n──── ${label} ────`);
  const a = chooseAction({ daysSinceAnyLog: 0, ...s });
  console.log(`[${a.kind}]`);
  console.log(formatOneAction(a, s.firstName));
}
