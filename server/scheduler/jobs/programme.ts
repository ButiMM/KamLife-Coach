import {
  db, users, workoutLogs,
  eq, gte, and,
  getActiveClients, isPaused,
  claimProactive,
} from "../shared";
import { sendProactive } from "../proactive-decision";
import { scheduledWords } from "../../core/coach";

export async function runPhaseAdvancement(): Promise<void> {
  console.log("[SCHEDULER] JOB: Phase advancement check");
  const clients = await getActiveClients();
  const fourWeeksAgo = new Date(Date.now() - 28 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      if ((client.programmeWeek || 1) < 4) continue;
      if (client.phaseReadyToAdvance) continue;
      const plannedSessions = (client.trainingDaysPerWeek || 3) * 4;
      const completedSessions = await db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, fourWeeksAgo)));
      const compliance = completedSessions.length / plannedSessions;
      if (compliance < 0.75) continue;
      const currentPhase = client.programmePhase || 1;
      if (currentPhase >= 5) continue;
      const newPhase = currentPhase + 1;
      // Claim before mutating + sending so a container recycle can't re-advance/re-send.
      if (!(await claimProactive(client.id, "phase_advance", `phase${newPhase}`))) continue;
      const phaseNames: Record<number, string> = { 1: "Foundation", 2: "Build", 3: "Push", 4: "Peak", 5: "Deload" };
      await db.update(users).set({ programmePhase: newPhase, programmeWeek: 1, programmeDayInWeek: 1, phaseReadyToAdvance: false }).where(eq(users.id, client.id));
      const name = (client.name || "there").split(" ")[0];
      // B5 (#319): the new coach's words, then the one move. CORE_WAVE4=off: the plain fact.
      const words = await scheduledWords(client.phoneNumber, "phase", `Phase ${currentPhase} (${phaseNames[currentPhase]}) done with ${completedSessions.length} of ${plannedSessions} planned sessions in 4 weeks; now Phase ${newPhase}: ${phaseNames[newPhase]}.`);
      await sendProactive(client, { claimed: "phase_advance" }, `${words ?? `${name}, Phase ${newPhase}: ${phaseNames[newPhase]} is unlocked.`}\n\nReply *today* for your first Phase ${newPhase} session.`);
    } catch (err) { console.error(`[SCHEDULER] Phase advancement error — ${client.phoneNumber}:`, err); }
  }
}