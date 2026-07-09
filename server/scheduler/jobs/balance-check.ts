/**
 * TWILIO BALANCE ALARM — warns the founder before the account runs dry.
 *
 * Every WhatsApp check-in, every reply, every payment alert runs through Twilio.
 * When the balance hits zero the channel goes silent with NO error — the bot just
 * stops, invisibly, until a client complains (the 2026-07-09 scare: balance sat at
 * $11.85 with nothing watching it). This daily job checks the balance and texts the
 * founder while there's still credit to send the warning over WhatsApp itself.
 *
 * Alert while balance is still ABOVE zero (default $15) is deliberate: at zero the
 * WhatsApp alert couldn't send. sendCriticalAlert also falls back to SMS if needed.
 */
import { sendCriticalAlert, fetchTwilioBalance } from "../shared";

// Threshold (account currency, usually USD) below which we warn. Env-tunable so the
// founder can raise it as the base grows without a redeploy.
export const LOW_BALANCE_THRESHOLD = Number(process.env.TWILIO_LOW_BALANCE_THRESHOLD) || 15;

// Pure: given a fetched balance, return the alert text to send, or null when the
// balance is healthy. Unit-tested so the threshold and wording never silently drift.
export function buildLowBalanceAlert(
  balance: number,
  currency: string,
  threshold: number = LOW_BALANCE_THRESHOLD,
): string | null {
  if (!Number.isFinite(balance)) return null; // couldn't read a number — never cry wolf
  if (balance >= threshold) return null;
  const cur = (currency || "USD").toUpperCase();
  return `⚠️ *Twilio balance low: ${cur} ${balance.toFixed(2)}*\n\nTop up before the bot goes silent — every WhatsApp check-in, reply and payment alert runs through Twilio. At this level you have roughly a day or two of runway.\n\nTop up now: console.twilio.com → Billing.`;
}

export async function runBalanceCheck(): Promise<void> {
  console.log("[SCHEDULER] JOB: Twilio balance check");
  const alertTo = process.env.COACH_ALERT_PHONE;
  if (!alertTo) {
    console.warn("[BALANCE] COACH_ALERT_PHONE not set — cannot send balance alert, skipping");
    return;
  }
  const res = await fetchTwilioBalance();
  if (!res) return; // fetch failed — already logged, don't guess
  const alert = buildLowBalanceAlert(res.balance, res.currency);
  if (!alert) {
    console.log(`[BALANCE] OK — ${res.currency} ${res.balance.toFixed(2)} (threshold ${LOW_BALANCE_THRESHOLD})`);
    return;
  }
  console.warn(`[BALANCE] LOW — ${res.currency} ${res.balance.toFixed(2)} < ${LOW_BALANCE_THRESHOLD}, alerting founder`);
  await sendCriticalAlert(alertTo, alert).catch(e => console.error("[BALANCE] alert send failed:", e?.message || e));
}
