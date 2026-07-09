/**
 * MONTHLY PROGRESS-PHOTO CHECK-IN — the re-shoot prompt (2026-07-09, Kam: photos must
 * come in monthly, not just at 90/180/365 days). Runs daily but self-gates: only fires
 * once ~30 days have passed since the client's last photo (or since they joined if they
 * have none), and only once per calendar month per client. Front/side/back so the
 * physique read + comparison have a full set to work with.
 */
import { db, users, eq, desc, sendWhatsApp, getActiveClients, isPaused, claimProactive } from "../shared";
import { progressPhotos } from "../../../shared/schema";

const MONTH_MS = 30 * 86_400_000;

export async function runMonthlyPhotoCheckin(): Promise<void> {
  console.log("[SCHEDULER] JOB: Monthly progress-photo check-in");
  const clients = await getActiveClients();
  const monthBucket = new Date().toISOString().slice(0, 7); // YYYY-MM — one prompt / month

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const last = await db.select({ loggedAt: progressPhotos.loggedAt })
        .from(progressPhotos).where(eq(progressPhotos.userId, client.id))
        .orderBy(desc(progressPhotos.loggedAt)).limit(1);

      // Anchor on the last photo, else when they joined. Wait a full ~30 days.
      const anchor = last[0]?.loggedAt ? new Date(last[0].loggedAt).getTime()
        : client.createdAt ? new Date(client.createdAt).getTime() : Date.now();
      if (Date.now() - anchor < MONTH_MS) continue;

      // Dedupe to one send per client per calendar month.
      if (!(await claimProactive(client.id, "monthly_photo", monthBucket))) continue;

      const name = client.name?.split(" ")[0] || "there";
      const msg = last.length > 0
        ? `${name}, it's been a month — time for your progress photos 📸\n\nSend *three*: front, side and back. Same lighting and pose as last time if you can. I'll line them up against your baseline and show you exactly what's shifted.`
        : `${name}, let's lock in your baseline 📸\n\nSend *three photos*: front, side and back. Good lighting, fitted clothes. This is your Day 0 — everything we track from here compares back to it.`;
      await sendWhatsApp(client.phoneNumber, msg);
    } catch (e) {
      console.warn(`[MONTHLY_PHOTO] failed for ${client.id}:`, (e as Error)?.message || e);
    }
  }
}
