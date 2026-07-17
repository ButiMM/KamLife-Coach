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
import { DRILL_CASES, runDrillCase, runDrillCaseEngine } from "../../drill-cases";

export async function runDrillNightly(): Promise<void> {
  const key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) { console.log("[DRILL_NIGHTLY] no OpenAI key — skipped"); return; }
  const today = todaySAST();
  if (loadState()["drill_nightly"] === today) return; // already ran today
  saveState("drill_nightly", today);

  const openai = new OpenAI({ apiKey: key });
  // Three honesty tiers (2026-07-17 — the drill now tests the REAL front door):
  //   frontDoor — Coach K's LIVE engine failed on an input it owns → can reach clients.
  //   backstop  — the retiring raw brain drifted; clients meet it only if the engine
  //               fails open on that turn.
  //   canary    — either model path failed on an input a deterministic handler claims
  //               first in production, so clients never see it.
  const frontDoor: string[] = [];
  const backstop: string[] = [];
  const canary: string[] = [];
  const warns: string[] = [];
  let passed = 0;

  for (const c of DRILL_CASES) {
    try {
      const eng = await runDrillCaseEngine(openai, c);
      const raw = await runDrillCase(openai, c);
      if (eng.pass && raw.pass) {
        passed++;
        const w = [...eng.warns, ...raw.warns];
        if (w.length) warns.push(`${c.name}: ${w.join("; ")}`);
        continue;
      }
      if (eng.protection === "deterministic") {
        canary.push(c.name);
      } else {
        if (!eng.pass) frontDoor.push(c.name);
        else backstop.push(c.name);
      }
      if (!eng.pass) console.error(`[DRILL_NIGHTLY] ENGINE FAIL (${eng.protection}) — ${c.name}\n  reply: ${eng.reply.slice(0, 300)}\n  ${eng.warns.join("\n  ")}`);
      if (!raw.pass) console.error(`[DRILL_NIGHTLY] BRAIN FAIL (${raw.protection}) — ${c.name}\n  reply: ${raw.reply.slice(0, 300)}\n  ${raw.warns.join("\n  ")}`);
    } catch (e: any) {
      // A single case erroring (timeout, rate limit) is an ERROR, not a regression —
      // report it loudly so a flaky night is visible, not silently swallowed.
      frontDoor.push(`${c.name} (ERROR: ${String(e?.message || e).slice(0, 80)})`);
      console.error(`[DRILL_NIGHTLY] ERROR — ${c.name}:`, e?.message || e);
    }
  }

  const total = DRILL_CASES.length;
  const failCount = frontDoor.length + backstop.length + canary.length;
  const summary = `${passed}/${total} passed${failCount ? ` (${frontDoor.length} front-door, ${backstop.length} backstop, ${canary.length} canary-only)` : ""}`;
  saveState("drill_nightly_result", `${today} ${summary}`);
  console.log(`[DRILL_NIGHTLY] ${summary}${warns.length ? ` (${warns.length} soft warns)` : ""}`);

  // Only a front-door failure (Coach K's live engine, on an input it owns) warrants the
  // loud "reaching clients" alarm. Backstop and canary fails are reported quietly so
  // drift never goes unseen — but the alert says plainly that clients are protected.
  if (failCount > 0) {
    const coachPhone = process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE;
    if (coachPhone) {
      const fdList = frontDoor.slice(0, 6).map(f => `• ${f}`).join("\n");
      const bsList = backstop.slice(0, 4).map(f => `• ${f}`).join("\n");
      const cnList = canary.slice(0, 4).map(f => `• ${f}`).join("\n");
      const quiet = [
        backstop.length ? `+${backstop.length} backstop-only (retiring brain drifted; clients meet it only if Coach K fails open):\n${bsList}` : "",
        canary.length ? `+${canary.length} canary-only (a deterministic handler owns these in production — clients are safe):\n${cnList}` : "",
      ].filter(Boolean).join("\n\n");
      const body = frontDoor.length > 0
        ? `🧪 Nightly drill: ${frontDoor.length} of ${total} cases FAILED on Coach K's LIVE front door — these can reach clients.\n\n${fdList}${frontDoor.length > 6 ? `\n…and ${frontDoor.length - 6} more` : ""}${quiet ? `\n\n(${quiet})` : ""}`
        : `🧪 Nightly drill: Coach K's live front door passed every case. Quiet drift logged, CLIENTS NOT AFFECTED:\n\n${quiet}`;
      await sendWhatsApp(`whatsapp:${coachPhone.replace(/\D/g, "")}`,
        `${body}\n\nRun it yourself: npx tsx script/drill-battery.ts (Railway shell). Full replies in the logs under [DRILL_NIGHTLY].`
      ).catch(e => console.error("[DRILL_NIGHTLY] alert send failed:", e?.message || e));
    }
  }
}
