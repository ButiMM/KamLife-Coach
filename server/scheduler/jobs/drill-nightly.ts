/**
 * NIGHTLY DRILL BATTERY — box one of the stabilization contract.
 *
 * Every night at 03:00 SAST this replays every tester failure ever recorded
 * (server/drill-cases.ts — the same cases the manual CLI drills) against the
 * LIVE production brain prompt and model. A prompt edit, a model-side change,
 * or an OpenAI regression that re-opens an old failure mode is caught here,
 * hours before a tester meets it.
 *
 * Escalation: any hard `mustNot` failure WhatsApps the founder immediately
 * (same channel as every other system alert) with the failing case names, and
 * the run result lands in scheduler-state telemetry for the ops endpoint.
 * Fail-open like every job — an OpenAI outage logs and exits, never throws.
 */

import OpenAI from "openai";
import { sendWhatsApp, loadState, saveState, todaySAST } from "../shared";
import { DRILL_CASES, runDrillCase } from "../../drill-cases";

export async function runDrillNightly(): Promise<void> {
  const key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) { console.log("[DRILL_NIGHTLY] no OpenAI key — skipped"); return; }
  const today = todaySAST();
  if (loadState()["drill_nightly"] === today) return; // already ran today
  saveState("drill_nightly", today);

  const openai = new OpenAI({ apiKey: key });
  const leaks: string[] = [];   // raw-brain fails on inputs the brain OWNS in production
  const canary: string[] = [];  // raw-brain fails on inputs a deterministic handler claims first
  const warns: string[] = [];
  let passed = 0;

  for (const c of DRILL_CASES) {
    try {
      const r = await runDrillCase(openai, c);
      if (r.pass) {
        passed++;
        if (r.warns.length) warns.push(`${c.name}: ${r.warns.join("; ")}`);
      } else {
        (r.protection === "deterministic" ? canary : leaks).push(c.name);
        console.error(`[DRILL_NIGHTLY] FAIL (${r.protection}) — ${c.name}\n  reply: ${r.reply.slice(0, 300)}\n  ${r.warns.join("\n  ")}`);
      }
    } catch (e: any) {
      // A single case erroring (timeout, rate limit) is an ERROR, not a regression —
      // report it as a leak so a flaky night is visible, not silently swallowed.
      leaks.push(`${c.name} (ERROR: ${String(e?.message || e).slice(0, 80)})`);
      console.error(`[DRILL_NIGHTLY] ERROR — ${c.name}:`, e?.message || e);
    }
  }

  const total = DRILL_CASES.length;
  const failCount = leaks.length + canary.length;
  const summary = `${passed}/${total} passed${failCount ? ` (${leaks.length} leak-risk, ${canary.length} canary-only)` : ""}`;
  saveState("drill_nightly_result", `${today} ${summary}`);
  console.log(`[DRILL_NIGHTLY] ${summary}${warns.length ? ` (${warns.length} soft warns)` : ""}`);

  // Only a genuine leak-risk (the brain IS the production path for this input) warrants the
  // loud "reaching clients" alarm. Canary-only fails mean the retiring brain drifted but a
  // deterministic handler claims that input in production, so clients are protected — we
  // still report them, quietly, so drift never goes fully unseen. No alert if only canary
  // fails would be dishonest the other way, so we always send SOMETHING when anything fails.
  if (failCount > 0) {
    const coachPhone = process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE;
    if (coachPhone) {
      const leakList = leaks.slice(0, 6).map(f => `• ${f}`).join("\n");
      const canaryList = canary.slice(0, 4).map(f => `• ${f}`).join("\n");
      const body = leaks.length > 0
        ? `🧪 Nightly drill: ${leaks.length} of ${total} cases FAILED on the brain's OWN production path — these can reach clients.\n\n${leakList}${leaks.length > 6 ? `\n…and ${leaks.length - 6} more` : ""}` +
          (canary.length ? `\n\n(+${canary.length} canary-only — the retiring brain drifted but production routes these to a deterministic handler, so clients are safe.)` : "")
        : `🧪 Nightly drill: ${canary.length} canary-only fail${canary.length > 1 ? "s" : ""} — the retiring brain drifted, but production routes ${canary.length > 1 ? "these" : "this"} to a deterministic handler, so CLIENTS ARE NOT AFFECTED. Logged for awareness, no action needed:\n\n${canaryList}`;
      await sendWhatsApp(`whatsapp:${coachPhone.replace(/\D/g, "")}`,
        `${body}\n\nRun it yourself: npx tsx script/drill-battery.ts (Railway shell). Full replies in the logs under [DRILL_NIGHTLY].`
      ).catch(e => console.error("[DRILL_NIGHTLY] alert send failed:", e?.message || e));
    }
  }
}
