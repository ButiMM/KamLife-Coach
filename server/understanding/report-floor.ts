/**
 * THE REPORT FLOOR (#568 batch 2, CTO decision: option b).
 *
 * The new coach reads every free-text turn. When it cannot (the model is down, the spend cap is hit, the read came back
 * empty), a plain report is still saved by the tool that already owns it: weight, steps, water, sleep and "workout
 * done". Losing a client's weigh-in because the model hiccupped is the data loss we never accept. Food is not here: a
 * plate needs the read. Anything else gets the honest outage line from the caller.
 */
import { isAskingNotReporting, looksLikeWeightReport } from "../utils";

export async function reportFloor(ctx: { phone: string; message: string; m: string; user: any; sourceMessageId?: string }): Promise<string | null> {
  // The reports only: "84kg. what should I eat?" keeps the 84kg; the question waits for the coach.
  const message = ctx.message.split(/(?<=[.!?\n])\s+/).filter(c => c.trim() && !isAskingNotReporting(c)).join(" ").trim();
  if (!message) return null;
  const t = { ...ctx, message, m: message.toLowerCase().replace(/\s+/g, " ").trim() };
  const saved: string[] = [];
  const slept = await (await import("../handlers/lifecycle")).logSleep(t.user, t.message, t.m);
  if (slept) saved.push(slept);
  const water = await (await import("../handlers/water")).handleWater(t); // the water owner, with its own repeat guard
  if (water) saved.push(water);
  const steps = await (await import("../handlers/steps")).handleStepReport({ ...t, normalizedQuestion: false, commitStep: () => {}, hasStepPart: () => false });
  if (steps.kind !== "none") saved.push(steps.reply);
  // The weigh-in and the session both live in the workout owner; it is asked only when the message is one of them.
  // The workout owner finds the weigh-in clause itself ("I'm trying to lose weight, weighed 84kg this morning").
  const weighs = looksLikeWeightReport(t.m) || /\b\d{2,3}(?:\.\d+)?\s*kgs?\b|\bweigh(?:ed|s|ing)?\b/i.test(t.m);
  const trained = (/\b(?:workout|session|training|gym)\b[^.!?]{0,20}\b(?:done|complete|completed|finished)\b|^\s*(?:done|finished)\b|\b(?:trained|worked out|did (?:my )?(?:workout|session|training))\b/i).test(t.m);
  if (weighs || trained) {
    const r = await (await import("../handlers/workout")).handleWorkoutCommands(t);
    if (r) saved.push(r);
  }
  return saved.length ? saved.join("\n\n") : null;
}
