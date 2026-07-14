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
  const failures: string[] = [];
  const warns: string[] = [];
  let passed = 0;

  for (const c of DRILL_CASES) {
    try {
      const r = await runDrillCase(openai, c);
      if (r.pass) {
        passed++;
        if (r.warns.length) warns.push(`${c.name}: ${r.warns.join("; ")}`);
      } else {
        failures.push(c.name);
        console.error(`[DRILL_NIGHTLY] FAIL — ${c.name}\n  reply: ${r.reply.slice(0, 300)}\n  ${r.warns.join("\n  ")}`);
      }
    } catch (e: any) {
      // A single case erroring (timeout, rate limit) is an ERROR, not a regression —
      // report it separately so a flaky night doesn't read as a broken brain.
      failures.push(`${c.name} (ERROR: ${String(e?.message || e).slice(0, 80)})`);
      console.error(`[DRILL_NIGHTLY] ERROR — ${c.name}:`, e?.message || e);
    }
  }

  const total = DRILL_CASES.length;
  const summary = `${passed}/${total} passed`;
  saveState("drill_nightly_result", `${today} ${summary}`);
  console.log(`[DRILL_NIGHTLY] ${summary}${warns.length ? ` (${warns.length} soft warns)` : ""}`);

  if (failures.length > 0) {
    const coachPhone = process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE;
    if (coachPhone) {
      const list = failures.slice(0, 6).map(f => `• ${f}`).join("\n");
      const more = failures.length > 6 ? `\n…and ${failures.length - 6} more` : "";
      await sendWhatsApp(`whatsapp:${coachPhone.replace(/\D/g, "")}`,
        `🧪 Nightly drill battery: ${failures.length} of ${total} tester cases FAILED — an old failure mode may be back in production.\n\n${list}${more}\n\nRun it yourself: npx tsx script/drill-battery.ts (Railway shell). Full replies in the logs under [DRILL_NIGHTLY].`
      ).catch(e => console.error("[DRILL_NIGHTLY] alert send failed:", e?.message || e));
    }
  }
}
