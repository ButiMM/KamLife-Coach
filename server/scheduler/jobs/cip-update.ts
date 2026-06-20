/**
 * Weekly Client Intelligence Profile update — Sunday 10pm SAST (20:00 UTC).
 * Rebuilds the CIP for every active client so Monday's messages have the
 * full picture of the week that just ended.
 *
 * After each build, a lightweight audit verifies the written values are
 * internally consistent and physiologically plausible. Anomalies are logged
 * and capped so a data quirk never corrupts a client's coaching context.
 */

import { db, getActiveClients, clientIntelligenceProfiles, eq } from "../shared";
import { buildClientProfile } from "../../intelligence/profile";

// ── CIP audit — checks key numeric constraints after each build ───────────────
// Detects: streaks longer than time-on-programme, impossible compliance values,
// implausible weight entries, and empty narratives on established clients.
async function auditCip(
  userId: string,
  weeksOnProgramme: number,
): Promise<void> {
  const rows = await db
    .select({
      longestWorkoutStreak: clientIntelligenceProfiles.longestWorkoutStreak,
      longestFoodStreak: clientIntelligenceProfiles.longestFoodStreak,
      lifetimeSessionCompliance: clientIntelligenceProfiles.lifetimeSessionCompliance,
      startWeightKg: clientIntelligenceProfiles.startWeightKg,
      bestWeightKg: clientIntelligenceProfiles.bestWeightKg,
      totalKgChanged: clientIntelligenceProfiles.totalKgChanged,
      coachNarrative: clientIntelligenceProfiles.coachNarrative,
    })
    .from(clientIntelligenceProfiles)
    .where(eq(clientIntelligenceProfiles.userId, userId))
    .limit(1);

  if (rows.length === 0) return; // build silently failed — already logged

  const cip = rows[0];
  const uid = userId.slice(-6);
  const maxDays = weeksOnProgramme * 7;
  const issues: string[] = [];
  const fixes: Partial<typeof cip> = {};

  // Streak can't exceed total days on programme
  if ((cip.longestWorkoutStreak ?? 0) > maxDays) {
    issues.push(`longestWorkoutStreak ${cip.longestWorkoutStreak} > maxDays ${maxDays}`);
    fixes.longestWorkoutStreak = maxDays;
  }
  if ((cip.longestFoodStreak ?? 0) > maxDays) {
    issues.push(`longestFoodStreak ${cip.longestFoodStreak} > maxDays ${maxDays}`);
    fixes.longestFoodStreak = maxDays;
  }

  // Compliance > 2.0 means something is double-counting (>1.0 is fine — bonus sessions)
  const compliance = cip.lifetimeSessionCompliance ? parseFloat(String(cip.lifetimeSessionCompliance)) : null;
  if (compliance !== null && compliance > 2.0) {
    issues.push(`lifetimeSessionCompliance ${compliance} > 2.0 — likely double-count`);
    fixes.lifetimeSessionCompliance = "2.000";
  }

  // Weight values must be physiologically plausible (30–300 kg)
  const startW = cip.startWeightKg ? parseFloat(String(cip.startWeightKg)) : null;
  const bestW = cip.bestWeightKg ? parseFloat(String(cip.bestWeightKg)) : null;
  if (startW !== null && !isNaN(startW) && (startW < 30 || startW > 300)) {
    issues.push(`startWeightKg ${startW} outside plausible range (30–300kg)`);
  }
  if (bestW !== null && !isNaN(bestW) && (bestW < 30 || bestW > 300)) {
    issues.push(`bestWeightKg ${bestW} outside plausible range (30–300kg)`);
  }

  // Weight change rate: > 0.5kg/week average is suspicious (0.3–0.5 is typical max)
  const totalKgChanged = cip.totalKgChanged ? parseFloat(String(cip.totalKgChanged)) : null;
  if (totalKgChanged !== null && !isNaN(totalKgChanged) && weeksOnProgramme > 4) {
    const weeklyRate = Math.abs(totalKgChanged) / weeksOnProgramme;
    if (weeklyRate > 1.0) {
      issues.push(`totalKgChanged ${totalKgChanged}kg over ${weeksOnProgramme} weeks = ${weeklyRate.toFixed(2)}kg/week — unusually fast`);
    }
  }

  // Narrative must exist for clients > 2 weeks on programme
  if (weeksOnProgramme >= 2 && (!cip.coachNarrative || cip.coachNarrative.trim().length < 50)) {
    issues.push(`coachNarrative missing or too short (${cip.coachNarrative?.length ?? 0} chars) after ${weeksOnProgramme} weeks`);
  }

  if (issues.length === 0) return;

  console.warn(`[CIP AUDIT] ${uid} — ${issues.length} issue(s):`, issues);

  // Apply safe numeric caps (never touch weight or narrative — only streak/compliance)
  if (Object.keys(fixes).length > 0) {
    await db
      .update(clientIntelligenceProfiles)
      .set(fixes)
      .where(eq(clientIntelligenceProfiles.userId, userId))
      .catch(e => console.error(`[CIP AUDIT] fix write failed for ${uid}:`, e));
    console.log(`[CIP AUDIT] ${uid} — applied fixes:`, fixes);
  }
}

export async function runCipUpdate(): Promise<void> {
  console.log("[SCHEDULER] JOB: CIP update");
  let updated = 0, audited = 0, errored = 0;
  const clients = await getActiveClients();

  for (const client of clients) {
    try {
      const createdAt = client.createdAt ? new Date(client.createdAt) : new Date();
      const weeksOnProgramme = Math.max(1, Math.floor((Date.now() - createdAt.getTime()) / (7 * 86_400_000)));

      await buildClientProfile(client);
      updated++;

      // Audit runs after the build — catches any value that violated constraints
      await auditCip(client.id, weeksOnProgramme).catch(e =>
        console.error(`[CIP AUDIT] failed for ${client.id?.slice(-6)}:`, e)
      );
      audited++;
    } catch (err) {
      errored++;
      console.error(`[CIP] Failed for ${client.id?.slice(-6)}:`, err);
    }
  }

  console.log(`[CIP] Updated ${updated} profiles, audited ${audited}, ${errored} errors`);
}
