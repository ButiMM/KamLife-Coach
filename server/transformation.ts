/**
 * TRANSFORMATION STORY + COHORT TRACKER — the growth engine's data layer (2026-07-19).
 *
 * The insight that drove this (Kam + third-party GTM review): KamLife's biggest growth asset
 * isn't the AI — it's that it holds the WHOLE JOURNEY as data. Most fitness businesses have a
 * before photo, an after photo, a testimonial. KamLife has Day-1 words, the weight trend, the
 * streak, sessions, the forecast — a RECEIPT, not a claim. This assembles that receipt into a
 * shareable card, and tracks the proof cohort on the only two numbers that matter:
 *   • Day-30 paid retention  • average weight change of the retained.
 *
 * Deterministic, read-only, WhatsApp-formatted. Uses the same pool + trajectory the rest of
 * the reporting layer uses, so the numbers can never disagree with what the client sees.
 */

import { pool } from "./db";
import { maintenanceKcal } from "./targets";
import { predictTrajectory, type DayEnergy } from "./trajectory";

const round1 = (n: number) => Math.round(n * 10) / 10;
const daysBetween = (a: Date, b: Date) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000));

export interface TransformationStory {
  found: boolean;
  whatsappText: string;
}

/** Assemble ONE client's journey into a shareable transformation card. `identifier` matches
 *  a name (fuzzy) or the last digits of a phone number. */
export async function getTransformationStory(identifier: string): Promise<TransformationStory> {
  const id = (identifier || "").trim();
  if (!id) return { found: false, whatsappText: "Give me a name or the last 4 digits: *story Thabo* or *story 4821*." };
  try {
    const { rows } = await pool.query<{
      id: string; name: string | null; current_weight: string | null; goal_type: string | null;
      target_weight_kg: string | null; workout_streak: number | null; created_at: string;
      gender: string | null; age: number | null; height_cm: string | null; life_situation: string | null;
      training_days_per_week: number | null; training_experience: string | null;
    }>(
      `SELECT id, name, current_weight, goal_type, target_weight_kg, workout_streak, created_at,
              gender, age, height_cm, life_situation, training_days_per_week, training_experience
         FROM users
        WHERE (name ILIKE '%'||$1||'%' OR phone_number LIKE '%'||$1)
          AND onboarding_state IN ('COMPLETE','COMPLETED')
        ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    if (!rows.length) return { found: false, whatsappText: `No client found for "${id}". Try a name or the last 4 digits of their number.` };
    const u = rows[0];

    const [startW, latestW, sessions, mealDays, steps14, firstMsg, weekDays, photos, beforePhoto, afterPhoto] = await Promise.all([
      pool.query<{ weight: string }>(`SELECT weight FROM weight_logs WHERE user_id=$1 ORDER BY logged_at ASC LIMIT 1`, [u.id]),
      pool.query<{ weight: string; logged_at: string }>(`SELECT weight, logged_at FROM weight_logs WHERE user_id=$1 ORDER BY logged_at DESC LIMIT 1`, [u.id]),
      pool.query<{ n: string }>(`SELECT COUNT(*) n FROM workout_logs WHERE user_id=$1 AND workout_completed=true`, [u.id]),
      pool.query<{ n: string }>(`SELECT COUNT(DISTINCT DATE(logged_at)) n FROM meal_logs WHERE user_id=$1`, [u.id]),
      pool.query<{ avg: string }>(`SELECT COALESCE(AVG(steps),0) avg FROM step_logs WHERE user_id=$1 AND logged_at > now() - interval '14 days'`, [u.id]),
      pool.query<{ message_in: string }>(`SELECT message_in FROM chat_history WHERE user_id=$1 AND message_in IS NOT NULL AND message_in !~ '^\\[' AND length(trim(message_in)) > 3 ORDER BY created_at ASC LIMIT 1`, [u.id]),
      // last 7 days of intake+steps for the live forecast line
      pool.query<{ day: string; kcal: string; steps: string }>(
        `SELECT DATE(m.logged_at) day, COALESCE(SUM(m.kcal_int),0) kcal,
                COALESCE((SELECT SUM(s.steps) FROM step_logs s WHERE s.user_id=$1 AND DATE(s.logged_at)=DATE(m.logged_at)),0) steps
           FROM meal_logs m WHERE m.user_id=$1 AND m.logged_at > now() - interval '7 days' GROUP BY 1`, [u.id]),
      // before/after PHOTOS — the emotional proof. Count + span of distinct shoot days.
      pool.query<{ shoots: string; first: string | null; last: string | null }>(
        `SELECT COUNT(DISTINCT DATE(logged_at)) shoots, MIN(logged_at) first, MAX(logged_at) last FROM progress_photos WHERE user_id=$1`, [u.id]),
      // the actual BEFORE (earliest) and AFTER (latest) photo ids, to attach as images.
      pool.query<{ id: string }>(`SELECT id FROM progress_photos WHERE user_id=$1 ORDER BY logged_at ASC LIMIT 1`, [u.id]),
      pool.query<{ id: string }>(`SELECT id FROM progress_photos WHERE user_id=$1 ORDER BY logged_at DESC LIMIT 1`, [u.id]),
    ]);

    const name = (u.name || "").split(" ")[0] || "This client";
    const joined = new Date(u.created_at);
    const dayN = daysBetween(joined, new Date()) + 1;
    const startWeight = startW.rows[0]?.weight ? parseFloat(startW.rows[0].weight) : null;
    const currentWeight = latestW.rows[0]?.weight ? parseFloat(latestW.rows[0].weight) : (u.current_weight ? parseFloat(u.current_weight) : null);
    const streak = u.workout_streak ?? 0;
    const sessionCount = parseInt(sessions.rows[0]?.n || "0", 10);
    const mealLoggedDays = parseInt(mealDays.rows[0]?.n || "0", 10);
    const avgSteps = Math.round(parseFloat(steps14.rows[0]?.avg || "0"));
    const opening = (firstMsg.rows[0]?.message_in || "").replace(/\s+/g, " ").trim().slice(0, 90);
    const goal = (u.goal_type || "fat_loss").toLowerCase();

    // Weight delta + direction framed by goal.
    let weightLine: string;
    if (startWeight !== null && currentWeight !== null) {
      const delta = round1(currentWeight - startWeight);
      const lost = -delta;
      if (Math.abs(delta) < 0.1) weightLine = `Now: *${currentWeight}kg* (started ${startWeight}kg) — holding steady`;
      else if (goal === "muscle_gain") weightLine = `Now: *${currentWeight}kg* (started ${startWeight}kg) — *${delta > 0 ? "+" + delta : delta}kg*`;
      else weightLine = `Now: *${currentWeight}kg* (started ${startWeight}kg) — *${lost > 0 ? lost + "kg down 📉" : Math.abs(delta) + "kg up"}*`;
    } else if (currentWeight !== null) {
      weightLine = `Currently *${currentWeight}kg* — no starting weigh-in logged yet (get one so we can show the drop).`;
    } else {
      weightLine = `No weight logged yet — first weigh-in starts the story.`;
    }

    // Live forecast line (reuses the deterministic engine).
    let forecastLine = "";
    try {
      const days: DayEnergy[] = weekDays.rows.map(r => ({ intakeKcal: parseInt(r.kcal, 10) || 0, steps: parseInt(r.steps, 10) || 0 }));
      if (days.length) {
        const maint = maintenanceKcal(currentWeight || 75, u.gender || "male", u.age || 30, parseFloat(u.height_cm || "170") || 170, u.life_situation || "office", u.training_days_per_week || 3, u.training_experience || "beginner");
        const t = predictTrajectory({ maintenanceKcal: maint, weightKg: currentWeight || 75, goalType: goal, days, targetWeightKg: u.target_weight_kg ? parseFloat(u.target_weight_kg) : null });
        if (t.daysLogged > 0) forecastLine = `\n📊 Forecast: ${t.direction === "losing" ? `on track to lose ~${Math.abs(t.predictedWeeklyChangeKg)}kg/week` : t.direction === "gaining" ? `gaining ~${Math.abs(t.predictedWeeklyChangeKg)}kg/week` : "holding at maintenance"}`;
      }
    } catch { /* forecast is a bonus, never blocks the card */ }

    // before/after photo line — the visual proof most fitness businesses would kill for.
    const shoots = parseInt(photos.rows[0]?.shoots || "0", 10);
    const pFirst = photos.rows[0]?.first ? new Date(photos.rows[0].first) : null;
    const pLast = photos.rows[0]?.last ? new Date(photos.rows[0].last) : null;
    let photoLine = "";
    if (shoots >= 2 && pFirst && pLast) {
      photoLine = `\n📸 *Before + after photos* — baseline Day 1 & re-shoot Day ${daysBetween(joined, pLast) + 1}. Sending them now 👇`;
    } else if (shoots === 1) {
      photoLine = `\n📸 Baseline photos captured — schedule the re-shoot to complete the before/after.`;
    }

    // Attach the actual before/after images (Twilio needs https media URLs). The command is
    // coach-only; the reply pipeline turns [MEDIA:url] markers into WhatsApp image sends.
    const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
    const raw = (process.env.APP_URL || railwayDomain || "").replace(/\/$/, "");
    const appUrl = raw && /^https?:\/\//i.test(raw) ? raw : raw ? `https://${raw}` : "";
    let mediaMarkers = "";
    if (appUrl.startsWith("https://")) {
      const beforeId = beforePhoto.rows[0]?.id;
      const afterId = afterPhoto.rows[0]?.id;
      if (beforeId) mediaMarkers += `\n[MEDIA:${appUrl}/api/progress-photo/${beforeId}/image]`;
      if (afterId && afterId !== beforeId) mediaMarkers += `\n[MEDIA:${appUrl}/api/progress-photo/${afterId}/image]`;
    }

    const text =
      `🏆 *${name}'s journey* — Day ${dayN}\n\n` +
      (opening ? `Day 1: _"${opening}"_\n` : "") +
      `${weightLine}\n\n` +
      `🔥 ${streak}-day streak · 💪 ${sessionCount} session${sessionCount === 1 ? "" : "s"}\n` +
      `🍽️ ${mealLoggedDays} days logged${avgSteps > 0 ? ` · 👟 ${avgSteps.toLocaleString()} avg steps` : ""}` +
      forecastLine +
      photoLine +
      `\n\n_The whole journey — words, weight, streak, and the photos — from their own logs. This is the receipt you share._` +
      mediaMarkers;

    return { found: true, whatsappText: text };
  } catch (e: any) {
    return { found: false, whatsappText: `Story hit a snag: ${e?.message || e}` };
  }
}

export interface CohortSnapshot {
  whatsappText: string;
}

/** The proof-cohort dashboard: the two numbers that decide the business — Day-30 paid
 *  retention and the average weight change of the retained — plus a per-member line. */
export async function getCohortSnapshot(limit = 15): Promise<CohortSnapshot> {
  try {
    // Everyone onboarded ≥30 days ago is "eligible"; still active among them = retained.
    const { rows: ret } = await pool.query<{ eligible: string; retained: string }>(
      `SELECT COUNT(*) FILTER (WHERE created_at <= now() - interval '30 days') eligible,
              COUNT(*) FILTER (WHERE created_at <= now() - interval '30 days' AND subscription_status='active') retained
         FROM users WHERE onboarding_state IN ('COMPLETE','COMPLETED')`,
    );
    const eligible = parseInt(ret[0]?.eligible || "0", 10);
    const retained = parseInt(ret[0]?.retained || "0", 10);
    const retPct = eligible > 0 ? Math.round((retained / eligible) * 100) : null;

    // Per-member journey rows (most recent joiners first), with first→latest weight delta.
    const { rows: members } = await pool.query<{
      name: string | null; created_at: string; subscription_status: string | null;
      start_w: string | null; latest_w: string | null; streak: number | null;
    }>(
      `SELECT u.name, u.created_at, u.subscription_status, u.workout_streak streak,
              (SELECT weight FROM weight_logs w WHERE w.user_id=u.id ORDER BY logged_at ASC LIMIT 1) start_w,
              (SELECT weight FROM weight_logs w WHERE w.user_id=u.id ORDER BY logged_at DESC LIMIT 1) latest_w
         FROM users u
        WHERE u.onboarding_state IN ('COMPLETE','COMPLETED')
        ORDER BY u.created_at DESC LIMIT $1`,
      [Math.max(5, Math.min(40, limit))],
    );

    // Average weight change of the RETAINED (≥30 days AND active) who have two weigh-ins.
    const now = Date.now();
    const retainedDeltas: number[] = [];
    const lines: string[] = [];
    for (const m of members) {
      const days = daysBetween(new Date(m.created_at), new Date());
      const start = m.start_w ? parseFloat(m.start_w) : null;
      const latest = m.latest_w ? parseFloat(m.latest_w) : null;
      const delta = start !== null && latest !== null ? round1(latest - start) : null;
      const isRetained = days >= 30 && m.subscription_status === "active";
      if (isRetained && delta !== null) retainedDeltas.push(delta);
      const nm = (m.name || "?").split(" ")[0].slice(0, 12);
      const deltaStr = delta === null ? "—" : delta === 0 ? "0.0" : (delta < 0 ? `${delta}` : `+${delta}`);
      const flag = m.subscription_status === "active" ? "🟢" : m.subscription_status === "trial" ? "🟡" : "⚪";
      lines.push(`${flag} ${nm} · d${days} · ${start ?? "?"}→${latest ?? "?"}kg (${deltaStr}) · 🔥${m.streak ?? 0}`);
    }
    const avgDelta = retainedDeltas.length ? round1(retainedDeltas.reduce((a, b) => a + b, 0) / retainedDeltas.length) : null;

    const header =
      `📊 *Proof Cohort — the two numbers that matter*\n\n` +
      `*Day-30 paid retention:* ${retPct === null ? "no one's hit 30 days yet" : `${retPct}% (${retained}/${eligible})`}\n` +
      `*Avg weight change (retained):* ${avgDelta === null ? "—" : `${avgDelta > 0 ? "+" : ""}${avgDelta}kg`}\n\n` +
      `_If people pay past 30 days AND lose weight, you have a real business. Everything else is optimisation._\n\n` +
      `*Members* (🟢 active · 🟡 trial · ⚪ lapsed):\n`;
    return { whatsappText: header + lines.join("\n") };
  } catch (e: any) {
    return { whatsappText: `Cohort hit a snag: ${e?.message || e}` };
  }
}
