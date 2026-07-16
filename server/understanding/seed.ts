/**
 * Seed an UnderstandingState from data we ALREADY hold — no new table, no migration.
 *
 * Cross-turn persistence of the evolving narrative/observations is a later step (it needs
 * a durable column, applied via db:push). But we don't need that to START: we can build a
 * solid prior for each turn from the durable signals already in the system —
 *   - name, number-free preference, tone            (users row + profileNotes tokens)
 *   - active health state                            (sick_until token)
 *   - streak / weight direction / recent averages    (parsed from the real snapshot)
 * The Perception pass then refines this per message. This lets the Meaning Engine run in
 * shadow immediately against real clients, and upgrades cleanly when persistence lands.
 */

import { getDisplayName } from "../utils";
import { getNumbersMode } from "../numbers-mode";
import { type UnderstandingState, defaultUnderstanding, type WeightDirection } from "./state";

function isActivelySick(user: any): boolean {
  const notes = user?.profileNotes || "";
  const m = notes.match(/sick_until:(\d{4}-\d{2}-\d{2})/);
  if (!m) return false;
  return new Date(m[1]) >= new Date(new Date().toISOString().slice(0, 10));
}

// Pull the few trustworthy stats out of the snapshot text (it's the DB's own numbers).
function statsFromSnapshot(snapshot?: string): Partial<UnderstandingState["stats"]> {
  if (!snapshot) return {};
  const out: Partial<UnderstandingState["stats"]> = {};
  const streak = snapshot.match(/Current streak:\s*(\d+)/i);
  if (streak) out.streak = Math.max(0, parseInt(streak[1], 10) || 0);
  // "+0.8kg overall" / "falling about 0.21kg/week" → a coarse direction
  if (/falling|down .*kg|losing/i.test(snapshot)) out.weightDirection = "down" as WeightDirection;
  else if (/rising|gained|up .*kg overall/i.test(snapshot)) out.weightDirection = "up" as WeightDirection;
  const prot = snapshot.match(/averaging\s*(\d+)g\/day/i);
  if (prot) out.recentProteinAvg = parseInt(prot[1], 10) || 0;
  const steps = snapshot.match(/averaging\s*([\d,]+)\/day/i);
  if (steps) out.recentStepAvg = parseInt(steps[1].replace(/,/g, ""), 10) || 0;
  return out;
}

function keyFactsFromUser(user: any): string[] {
  const facts: string[] = [];
  const inj = (user?.injuries || "").trim();
  if (inj && inj.toLowerCase() !== "none") facts.push(`injury/limitation: ${inj}`);
  const goal = user?.goalType;
  if (goal) facts.push(`goal: ${String(goal).replace(/_/g, " ")}`);
  const job = (user?.jobType || user?.lifeSituation || "").trim();
  if (job) facts.push(`life/work: ${job}`);
  // FOOD IDENTITY (2026-07-16: Coach K asked a 6-month client "what do you usually like
  // to eat?" — the onboarding answers existed all along and never reached the engine).
  const likes = (user?.foodLikes || "").trim();
  if (likes) facts.push(`their staple foods: ${likes.slice(0, 90)}`);
  const dislikes = (user?.foodDislikes || "").trim();
  if (dislikes && dislikes.toLowerCase() !== "none") facts.push(`won't eat: ${dislikes.slice(0, 60)}`);
  const budget = String(user?.weeklyFoodBudget || user?.budgetLevel || "").trim();
  if (budget) facts.push(`food budget: ${budget.replace(/_/g, " ")}`);
  const med = (user?.medicalConditions || "").trim();
  if (med && med.toLowerCase() !== "none") facts.push(`medical: ${med.slice(0, 60)}`);
  if (user?.trainingMode) facts.push(`trains: ${String(user.trainingMode).replace(/_/g, " ")}${user?.homeEquipment ? ` (${user.homeEquipment})` : ""}, ${user?.trainingDaysPerWeek || "?"} days/week`);
  return facts.slice(0, 10);
}

export function seedUnderstanding(user: any, snapshot?: string): UnderstandingState {
  const name = (() => { try { return getDisplayName(user) || "there"; } catch { return user?.name || "there"; } })();
  const s = defaultUnderstanding(name);
  s.profile.preferences.numberFree = getNumbersMode(user) !== "normal"; // low/default → number-free
  s.profile.keyFacts = keyFactsFromUser(user);
  if (isActivelySick(user)) s.current.healthStatus = "sick";
  s.stats = { ...s.stats, ...statsFromSnapshot(snapshot) };
  return s;
}
