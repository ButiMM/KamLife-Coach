/**
 * GLOBAL AI-SPEND WATCHDOG — the account-wide cost tripwire.
 *
 * We already brake spend PER USER (a monthly $ cap in gpt.ts, a daily call cap in
 * gpt-block.ts). What neither catches is the account-wide runaway the security
 * playbooks warn about: "$20 → $200 in a single day" — one loop, one abused
 * endpoint, one bad deploy calling the model in a hot path. Per-user caps don't
 * see the SUM across everyone.
 *
 * This job sums TODAY's gpt_costs (SAST day) across all users each hour and pings
 * Kam when the account crosses 50% and then 100% of a soft daily budget. It is a
 * TRIPWIRE, not a killswitch — it never stops coaching (silencing real clients
 * mid-spike is worse than the spend; the per-user caps are the hard brakes). Kam
 * sees the runaway early and decides. Fail-open: a scheduler job must never throw.
 *
 * Tunable: GLOBAL_AI_DAILY_SOFT_CAP_USD (default $15). Set from the real daily
 * spend once there's a baseline — the alert should mean "today is abnormal", not
 * fire every busy day.
 */

import {
  db,
  gte,
  sql,
  sendWhatsApp,
  loadState,
  saveState,
  todaySAST,
  sastDayStart,
  resolveOpsAlertMsisdn,
} from "../shared";
import { gptCosts } from "../../../shared/schema";

const DEFAULT_SOFT_CAP_USD = 15;

function softCapUsd(): number {
  const v = parseFloat(process.env.GLOBAL_AI_DAILY_SOFT_CAP_USD || String(DEFAULT_SOFT_CAP_USD));
  return isFinite(v) && v > 0 ? v : DEFAULT_SOFT_CAP_USD;
}

export async function runSpendWatchdog(): Promise<void> {
  try {
    const coachPhone = await resolveOpsAlertMsisdn();
    if (!coachPhone) return; // nobody to alert, or destination is a client thread

    const cap = softCapUsd();
    const dayStart = sastDayStart();

    // Sum today's spend across EVERY user (userId null included — pre-user classifiers).
    const [row] = await db
      .select({ total: sql<string>`COALESCE(SUM(${gptCosts.costUsd}::numeric), 0)` })
      .from(gptCosts)
      .where(gte(gptCosts.createdAt, dayStart));
    const spent = parseFloat(row?.total ?? "0") || 0;
    const pct = (spent / cap) * 100;

    console.log(`[SPEND_WATCHDOG] today=$${spent.toFixed(2)} of soft cap $${cap.toFixed(2)} (${pct.toFixed(0)}%)`);

    // Two thresholds, each alerts at most ONCE per SAST day (dedupe via state keys).
    // 100% is checked first so a day that blows straight past the cap sends the
    // louder message, not the 50% one.
    const today = todaySAST();
    const state = loadState();
    const to = coachPhone.startsWith("whatsapp:") ? coachPhone : `whatsapp:${coachPhone}`;

    if (spent >= cap && state["spend_watchdog_100"] !== today) {
      saveState("spend_watchdog_100", today);
      await sendWhatsApp(
        to,
        `🚨 *KamLife AI spend* — today is at *$${spent.toFixed(2)}*, past the $${cap.toFixed(2)} daily soft cap (${pct.toFixed(0)}%).\n\n` +
        `Per-user caps are still holding the hard line, so clients aren't cut off — but the account total is abnormal. ` +
        `Check for a loop, an abused endpoint, or a hot-path model call. If this is just a busy day, raise GLOBAL_AI_DAILY_SOFT_CAP_USD.`,
      );
      console.log("[SPEND_WATCHDOG] 100% alert sent");
      return;
    }

    if (spent >= cap * 0.5 && state["spend_watchdog_50"] !== today) {
      saveState("spend_watchdog_50", today);
      await sendWhatsApp(
        to,
        `⚠️ *KamLife AI spend* — today has reached *$${spent.toFixed(2)}*, half of the $${cap.toFixed(2)} daily soft cap. ` +
        `Just a heads-up, nothing's broken — watching in case it keeps climbing.`,
      );
      console.log("[SPEND_WATCHDOG] 50% alert sent");
    }
  } catch (err) {
    console.error("[SPEND_WATCHDOG] failed:", err);
    return; // fail-open
  }
}
