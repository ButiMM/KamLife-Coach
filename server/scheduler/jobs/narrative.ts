/**
 * Monthly identity narrative — fires on the 1st of every month at 7pm SAST.
 *
 * Reads the client's CIP coachNarrative (built weekly by runCipUpdate) and
 * sends it back to them as a mirror of their own story. The goal is identity
 * anchoring: seeing your journey in words makes it real and sticky.
 *
 * Skips clients with < 4 weeks on programme (no story yet) and clients whose
 * CIP hasn't been built or has an empty narrative.
 */

import {
  db, clientIntelligenceProfiles,
  eq,
  isPaused, getActiveClients,
} from "../shared";
import { sendProactive } from "../proactive-decision";

export async function runMonthlyNarrative(): Promise<void> {
  console.log("[SCHEDULER] JOB: Monthly identity narrative");
  const clients = await getActiveClients();
  let sent = 0;

  const now = new Date(Date.now() + 2 * 3_600_000); // SAST
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const weeksSinceStart = client.programmeStartDate
        ? Math.floor((Date.now() - new Date(client.programmeStartDate).getTime()) / (7 * 86_400_000))
        : 0;
      if (weeksSinceStart < 4) continue;

      const [cipRow] = await db.select({ coachNarrative: clientIntelligenceProfiles.coachNarrative })
        .from(clientIntelligenceProfiles)
        .where(eq(clientIntelligenceProfiles.userId, client.id))
        .limit(1);

      const narrative = cipRow?.coachNarrative?.trim();
      if (!narrative || narrative.length < 50) continue;

      const name = (client.name || "there").split(" ")[0];
      const msg = `*${name} — your story so far:*\n\n${narrative}\n\n_This is what the data shows. Own it. Now go make next month's version better._`;
      // Claimed only once there is a story to send, so a client without one keeps today's slot.
      if (await sendProactive(client, { job: "monthly_narrative", window: monthKey }, msg)) sent++;
    } catch (err) { console.error(`[NARRATIVE] Monthly narrative error — ${client.phoneNumber}:`, err); }
  }
  console.log(`[NARRATIVE] Monthly narratives sent: ${sent}`);
}
