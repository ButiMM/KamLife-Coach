/**
 * Weekly Client Intelligence Profile update — Sunday 10pm SAST (20:00 UTC).
 * Rebuilds the CIP for every active client so Monday's messages have the
 * full picture of the week that just ended.
 */

import { getActiveClients } from "../shared";
import { buildClientProfile } from "../../intelligence/profile";

export async function runCipUpdate(): Promise<void> {
  console.log("[SCHEDULER] JOB: CIP update");
  let updated = 0, errored = 0;
  const clients = await getActiveClients();

  for (const client of clients) {
    try {
      await buildClientProfile(client);
      updated++;
    } catch (err) {
      errored++;
      console.error(`[CIP] Failed for ${client.id?.slice(-6)}:`, err);
    }
  }

  console.log(`[CIP] Updated ${updated} profiles, ${errored} errors`);
}
