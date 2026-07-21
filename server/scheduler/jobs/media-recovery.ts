import { sendWhatsApp } from "../../scheduler";
import { claimStuckMediaJobs, purgeOldMediaJobs } from "../../media-jobs";

/**
 * MEDIA CRASH RECOVERY — runs every 2 minutes. Any media job still 'pending' past 3 minutes
 * means the process died mid-processing (OOM, deploy, restart) and the client got silence. We
 * nudge them to resend (Twilio media URLs expire, so re-processing isn't reliable — "please
 * resend" beats dead air) and mark the job recovered so it's nudged exactly once.
 */
export async function runMediaJobRecovery(): Promise<void> {
  const stuck = await claimStuckMediaJobs();
  if (stuck.length) {
    console.log(`[SCHEDULER] JOB: recovering ${stuck.length} stuck media job(s)`);
    for (const j of stuck) {
      const kind = (j.mediaType || "").startsWith("audio/") ? "voice note"
        : (j.mediaType || "").startsWith("video/") ? "video" : "photo";
      const to = j.phoneNumber.startsWith("whatsapp:") ? j.phoneNumber : `whatsapp:${j.phoneNumber.replace(/\D/g, "")}`;
      await sendWhatsApp(to, `Eish — I didn't manage to finish looking at that ${kind}. Please send it again and I'll get it right this time. 🙏`)
        .catch((e) => console.error("[MEDIA_RECOVERY] nudge failed:", e?.message || e));
    }
  }
  await purgeOldMediaJobs();
}
