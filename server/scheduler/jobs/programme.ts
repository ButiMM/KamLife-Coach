import {
  db, users, workoutLogs,
  eq, gte, and,
  sendWhatsApp,
  getActiveClients, isPaused,
  claimProactive,
} from "../shared";

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
      const name = client.name || "there";
      await sendWhatsApp(client.phoneNumber, `${name}, you have completed Phase ${currentPhase} (${phaseNames[currentPhase]}). ${completedSessions.length} of ${plannedSessions} planned sessions done — ${Math.round(compliance * 100)}% compliance. You have earned Phase ${newPhase}: ${phaseNames[newPhase]}. Your programme has been updated. Reply "today" for your first Phase ${newPhase} session.`);
    } catch (err) { console.error(`[SCHEDULER] Phase advancement error — ${client.phoneNumber}:`, err); }
  }
}