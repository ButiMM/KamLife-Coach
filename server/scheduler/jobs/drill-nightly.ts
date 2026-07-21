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

  // WHO HEARS ABOUT DRIFT:
  //   The builder — always, via the console logs + telemetry above (case names, replies, the
  //     backstop/canary taxonomy, how to re-run the battery). That's where engineering detail belongs.
  //   The founder — ONLY when something can actually reach a client (a live front-door fail), and
  //     then in plain English, no jargon, no shell commands. Quiet internal drift where clients are
  //     safe (backstop/canary only) never pings the phone — it would just be 3am noise.
  if (frontDoor.length > 0) {
    const coachPhone = process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE;
    if (coachPhone) {
      const n = frontDoor.length;
      const body = `⚠️ Morning — this morning's automatic check found ${n} thing${n !== 1 ? "s" : ""} the coach might be getting wrong that could reach clients. The full details are logged for the tech team to fix. Nothing needs you right now — I'll flag it again tomorrow if it's still there.`;
      await sendWhatsApp(`whatsapp:${coachPhone.replace(/\D/g, "")}`, body)
        .catch(e => console.error("[DRILL_NIGHTLY] alert send failed:", e?.message || e));
    }
  }
}
