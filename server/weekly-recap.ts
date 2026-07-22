/**
 * Weekly voice recap engine.
 *
 * Every Sunday at 10pm SAST, each active client receives a personalized
 * 30-second voice note in Coach K's cloned voice summarising their week.
 *
 * Flow per client:
 *   1. Fetch their week's data (workouts, steps, weight, meals)
 *   2. GPT writes a personal 70-word script based on real numbers
 *   3. ElevenLabs converts it to audio in the coach's voice
 *   4. Audio stored in voice_recap_logs
 *   5. Sent via Twilio WhatsApp
 */

import OpenAI from "openai";
import { assertAiOnline } from "./ai-offline";
import { getGoalProfile } from "./goal-profiles";
import { pool } from "./db";
import { sendWhatsApp } from "./scheduler";
import { isProactivePaused, claimProactive } from "./scheduler/shared";
import { textToSpeech, isElevenLabsConfigured } from "./elevenlabs";
import { recordServiceCost, voiceCostUsd } from "./cost-tracking";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-missing-key",
});

interface ClientWeekData {
  id: string;
  name: string | null;
  phoneNumber: string;
  currentWeight: number | null;
  calorieTarget: number | null;
  proteinTarget: number | null;
  stepsTarget: number | null;
  goalType: string | null;
  workoutsThisWeek: number;
  trainingDaysPerWeek: number;
  avgStepsThisWeek: number;
  weightChange: number | null; // kg change vs 2 weeks ago
  mealsLoggedDays: number;
  workoutStreak: number;
  lifeContext: string | null; // illness, bereavement, injury, family crisis detected this week
  topFoods: string[]; // the client's ACTUAL most-logged foods this week — makes the voice personal, not generic
}

const LIFE_EVENT_PATTERNS = /\b(sick|ill|flu|fever|vomit|nausea|hospital|clinic|doctor|emergency|funeral|died|death|passed away|passed on|lost my|losing my|granny|grandma|grandfather|gran|bereave|mourning|grieving|surgery|operation|injury|injured|hurt|broken|fracture|sprain|overwhelm|breakdown|depressed|depression|anxiety|mental health|can't cope|cant cope|crisis|accident|icu|intensive care|covid|quarantine|isolat)\b/i;

async function getClientWeekData(userId: string): Promise<ClientWeekData | null> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000);

  try {
    const { rows: userRows } = await pool.query<{
      id: string; name: string | null; phone_number: string;
      current_weight: string | null; calorie_target: number | null;
      protein_target: number | null; steps_target: number | null;
      goal_type: string | null; training_days_per_week: number | null;
      workout_streak: number | null;
    }>(
      `SELECT id, name, phone_number, current_weight, calorie_target, protein_target,
              steps_target, goal_type, training_days_per_week, workout_streak
       FROM users WHERE id = $1`,
      [userId]
    );
    if (!userRows.length) return null;
    const u = userRows[0];

    const [workoutRes, stepsRes, weightRes, mealsRes] = await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*) FROM workout_logs WHERE user_id=$1 AND logged_at > $2 AND workout_completed=true`,
        [userId, weekAgo]
      ),
      pool.query<{ avg: string }>(
        `SELECT COALESCE(AVG(steps), 0) AS avg FROM step_logs WHERE user_id=$1 AND logged_at > $2`,
        [userId, weekAgo]
      ),
      pool.query<{ weight: string; logged_at: string }>(
        `SELECT weight, logged_at FROM weight_logs WHERE user_id=$1 ORDER BY logged_at DESC LIMIT 1`,
        [userId]
      ),
      pool.query<{ days: string }>(
        `SELECT COUNT(DISTINCT DATE(logged_at)) AS days FROM meal_logs WHERE user_id=$1 AND logged_at > $2`,
        [userId, weekAgo]
      ),
    ]);

    // Weight change vs oldest weight in last 2 weeks
    const { rows: oldWeightRows } = await pool.query<{ weight: string }>(
      `SELECT weight FROM weight_logs WHERE user_id=$1 AND logged_at > $2 ORDER BY logged_at ASC LIMIT 1`,
      [userId, twoWeeksAgo]
    );
    const latestWeight = weightRes.rows[0]?.weight ? parseFloat(weightRes.rows[0].weight) : null;
    const oldWeight = oldWeightRows[0]?.weight ? parseFloat(oldWeightRows[0].weight) : null;
    const weightChange = latestWeight !== null && oldWeight !== null ? latestWeight - oldWeight : null;

    // The client's ACTUAL most-logged foods this week — this is what stops the voice
    // note sounding like a generic report card read aloud (2026-07-12, Kam: "it sounds
    // generic"). A coach who names what you actually ate feels like they know you.
    let topFoods: string[] = [];
    try {
      const { rows: foodRows } = await pool.query<{ food: string; n: string }>(
        `SELECT lower(trim(item->>'name')) AS food, COUNT(*) AS n
           FROM meal_logs, jsonb_array_elements(items) AS item
          WHERE user_id=$1 AND logged_at > $2 AND items IS NOT NULL
            AND length(trim(coalesce(item->>'name',''))) > 1
          GROUP BY 1 ORDER BY n DESC, food ASC LIMIT 4`,
        [userId, weekAgo]
      );
      topFoods = foodRows.map(r => r.food).filter(Boolean);
    } catch (e: any) {
      console.warn("[RECAP] Top-foods fetch failed:", e.message);
    }

    // Detect life events from last 14 days of chat history + memories
    let lifeContext: string | null = null;
    try {
      const [chatEvents, memEvents] = await Promise.all([
        pool.query<{ message_in: string; intent: string }>(
          `SELECT message_in, intent FROM chat_history
           WHERE user_id=$1 AND created_at > NOW() - INTERVAL '14 days'
           AND (intent IN ('SICK_DAY','INJURY') OR message_in ~* $2)
           ORDER BY created_at DESC LIMIT 6`,
          [userId, '\\m(sick|ill|flu|fever|hospital|funeral|died|death|passed away|passed on|lost my|injury|injured|surgery|operation|overwhelm|depression|anxiety|emergency|bereav|griev|mourn|covid|icu|quarantine|isolat|breakdown|fracture|sprain)\\M']
        ),
        pool.query<{ content: string }>(
          `SELECT content FROM memories
           WHERE phone=$1 AND category='medical' AND created_at > NOW() - INTERVAL '14 days'
           ORDER BY created_at DESC LIMIT 3`,
          [u.phone_number]
        ),
      ]);
      const lifeMessages = chatEvents.rows.map(r => r.message_in).filter(Boolean);
      const lifeMemories = memEvents.rows.map(r => r.content).filter(Boolean);
      const hasSick = chatEvents.rows.some(r => r.intent === 'SICK_DAY' || LIFE_EVENT_PATTERNS.test(r.message_in || ''));
      const hasInjury = chatEvents.rows.some(r => r.intent === 'INJURY');
      const hasBereavement = [...lifeMessages, ...lifeMemories].some(t =>
        /\b(funeral|died|death|passed away|passed on|lost my|granny|grandma|grandfather|gran|bereave|mourn|griev)\b/i.test(t)
      );
      const hasEmergency = lifeMessages.some(t => /\b(emergency|accident|icu|intensive care|surgery|operation)\b/i.test(t));

      if (hasBereavement) {
        lifeContext = `This client experienced a bereavement or loss this week.`;
      } else if (hasEmergency) {
        lifeContext = `This client dealt with a medical emergency or surgery this week.`;
      } else if (hasInjury) {
        lifeContext = `This client had an injury this week.`;
      } else if (hasSick) {
        lifeContext = `This client was sick or unwell this week.`;
      } else if (lifeMemories.length > 0) {
        lifeContext = `Recent medical note: ${lifeMemories[0]}`;
      }
    } catch (e: any) {
      console.warn("[RECAP] Life context fetch failed:", e.message);
    }

    return {
      id: u.id,
      name: u.name,
      phoneNumber: u.phone_number,
      currentWeight: u.current_weight ? parseFloat(u.current_weight) : null,
      calorieTarget: u.calorie_target,
      proteinTarget: u.protein_target,
      stepsTarget: u.steps_target,
      goalType: u.goal_type,
      workoutsThisWeek: parseInt(workoutRes.rows[0].count, 10),
      trainingDaysPerWeek: u.training_days_per_week ?? 3,
      avgStepsThisWeek: Math.round(parseFloat(stepsRes.rows[0].avg)),
      weightChange: weightChange !== null ? Math.round(weightChange * 10) / 10 : null,
      mealsLoggedDays: parseInt(mealsRes.rows[0].days, 10),
      workoutStreak: u.workout_streak ?? 0,
      lifeContext,
      topFoods,
    };
  } catch (e: any) {
    console.error(`[RECAP] Failed to fetch data for ${userId}:`, e.message);
    return null;
  }
}

export async function generateRecapScript(data: ClientWeekData): Promise<string> {
  const firstName = (data.name || "").split(" ")[0] || "there";
  const stepsTarget = data.stepsTarget ?? 8500;
  const trainingTarget = data.trainingDaysPerWeek;

  // GOAL-AWARE FRAMING (2026-07-22, reviewer verification: the recap hardcoded "fat loss" and
  // framed every client around weight change + a deficit — so a wellness / has-a-condition client
  // got a body-comp recap they never signed up for). Read the profile: macro goals keep the
  // weight-and-progress frame; health-led goals (weightIsGoal=false) are coached on consistency
  // and how they feel, and the scale line is dropped so a gogo is never chased on a number.
  const profile = getGoalProfile(data.goalType);
  const goalLabel = profile.label;
  const framesOnWeight = profile.weightIsGoal;

  const context = [
    `Name: ${firstName}`,
    `Goal: ${goalLabel}`,
    `Workouts this week: ${data.workoutsThisWeek} / ${trainingTarget} target`,
    `Average steps: ${data.avgStepsThisWeek.toLocaleString()} / ${stepsTarget.toLocaleString()} target`,
    framesOnWeight
      ? (data.weightChange !== null
          ? `Weight change (last 2 weeks): ${data.weightChange > 0 ? "+" : ""}${data.weightChange}kg`
          : "Weight: not logged this week")
      : "", // health-led: the scale is NOT their goal — never frame the week on it
    `Meals logged: ${data.mealsLoggedDays} / 7 days`,
    data.workoutStreak > 3 ? `Workout streak: ${data.workoutStreak} days` : "",
  ].filter(Boolean).join("\n");

  const lifeNote = data.lifeContext
    ? `\n\nIMPORTANT LIFE CONTEXT: ${data.lifeContext}`
    : "";

  const stepsVsTarget = data.avgStepsThisWeek >= stepsTarget
    ? `steps ABOVE target (${data.avgStepsThisWeek.toLocaleString()} vs ${stepsTarget.toLocaleString()} target)`
    : `steps BELOW target (${data.avgStepsThisWeek.toLocaleString()} vs ${stepsTarget.toLocaleString()} target)`;
  const workoutsVsTarget = data.workoutsThisWeek >= trainingTarget
    ? `hit training target (${data.workoutsThisWeek}/${trainingTarget})`
    : `missed ${trainingTarget - data.workoutsThisWeek} session${trainingTarget - data.workoutsThisWeek > 1 ? "s" : ""} (${data.workoutsThisWeek}/${trainingTarget})`;

  const foodLine = data.topFoods.length
    ? `Foods they actually logged this week (name one of these back to them so they know you saw it): ${data.topFoods.join(", ")}`
    : `They logged little or no food this week — do NOT invent foods. Nudge them to snap one meal.`;

  const toneRules = data.lifeContext
    ? `TONE: Compassionate. Life comes first. Do NOT frame missed targets as failures.
- Acknowledge the hard week directly. One sentence.
- Give them permission to have had a slow week.
- End with one warm, specific invitation to restart — no pressure, no urgency.`
    : `TONE: Direct South African coach talking to a mate on a voice note — warm, personal, spoken. NOT a report card read aloud.
STRUCTURE (follow this exactly):
1. Say ONE specific, human thing that proves you actually watched THEIR week — name a food they logged, their training streak${framesOnWeight ? ", or their weight move" : ", or how consistent they were"}. Real detail, not a stat dump. This is what makes it feel personal.
2. Tell them what it MEANS for their ${goalLabel} goal in plain words — cause and effect, one sentence.${framesOnWeight ? "" : " This client is NOT chasing the scale — frame it around energy, consistency and feeling better, never weight lost."}
3. ONE specific thing to do next week. Tied to their goal. Concrete, not vague.

DO NOT recite the numbers like a scorecard (they already got the written report card — repeating it is what makes the voice note feel generic). Pick ONE detail and talk about it like a human. Max ONE number in the whole script.

BANNED PHRASES — if any of these appear, rewrite: "keep pushing", "keep the momentum going", "you've got this", "let's keep pushing", "stay focused", "keep it up", "keep it going", "great effort", "fantastic effort", "well done", "amazing", "impressive", "that's great", "let's dive in", "your week in review", "here's your recap"`;

  const prompt = `You are Coach K — a direct South African fitness coach recording a short, personal voice note for ONE client. Max 65 words. It must sound spoken, warm, and specific to THEM — never like a template.

CLIENT DATA:
${context}${lifeNote}
Steps context: ${stepsVsTarget}
Workouts context: ${workoutsVsTarget}
${foodLine}

${toneRules}

RULES:
- Start with EXACTLY: "Hey ${firstName}, Coach K here."
- The written report card already gave them every number — your job is the HUMAN layer, not a re-read.
- South African voice, spoken rhythm. One idea, then the next.
- Hard limit: 65 words. No filler. No banned phrases. At most ONE number.`;

  try {
    assertAiOnline("weeklyRecap");
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
      temperature: 0.7,
    });
    return res.choices[0].message.content?.trim() ?? fallbackScript(firstName, data);
  } catch (e: any) {
    console.error("[RECAP] GPT script generation failed:", e.message);
    return fallbackScript(firstName, data);
  }
}

function fallbackScript(firstName: string, data: ClientWeekData): string {
  const w = data.workoutsThisWeek;
  const target = data.trainingDaysPerWeek;
  const goal = data.goalType || "fat_loss";
  // Lead with a real, personal detail — a food they actually logged — so even the
  // offline fallback doesn't sound like a generic scorecard (2026-07-12).
  const food = data.topFoods[0];
  const foodOpener = food ? ` Saw the ${food} in your log — good real food.` : "";
  if (w >= target) {
    return `Hey ${firstName}, Coach K here.${foodOpener} You showed up all ${target} sessions this week, and that consistency is exactly what moves your ${goal === "muscle_gain" ? "muscle" : "fat loss"} goal. This week: log your weight every morning so I can see if it's actually shifting.`;
  }
  const missed = target - w;
  const trainedBit = w > 0 ? `You got ${w} in, but ${missed} slipped.` : `Training went quiet this week.`;
  return `Hey ${firstName}, Coach K here.${foodOpener} ${trainedBit} For ${goal === "muscle_gain" ? "muscle growth" : "fat loss"} your body needs that stimulus regular. This week, pick your training days now and treat each one like a meeting you can't move.`;
}

async function storeRecapAudio(
  userId: string,
  weekStart: string,
  messageText: string,
  audioBuffer: Buffer | null,
): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO voice_recap_logs (user_id, week_start, message_text, audio_base64, content_type)
       VALUES ($1, $2, $3, $4, 'audio/mpeg')
       ON CONFLICT (user_id, week_start) DO UPDATE
         SET message_text = EXCLUDED.message_text,
             audio_base64 = EXCLUDED.audio_base64
       RETURNING id`,
      [userId, weekStart, messageText, audioBuffer ? audioBuffer.toString("base64") : null]
    );
    return rows[0]?.id ?? null;
  } catch (e: any) {
    console.error("[RECAP] Failed to store audio:", e.message);
    return null;
  }
}

export async function runWeeklyRecaps(opts?: { force?: boolean }): Promise<{ sent: number; failed: number; skipped: number }> {
  if (!opts?.force && isProactivePaused()) {
    console.log("[RECAP] PROACTIVE_PAUSED=true — skipping weekly voice recaps (use force-rerun to override)");
    return { sent: 0, failed: 0, skipped: 0 };
  }
  if (opts?.force && isProactivePaused()) {
    console.log("[RECAP] PROACTIVE_PAUSED=true but force=true — proceeding with manual rerun");
  }
  const elevenLabsReady = isElevenLabsConfigured();
  if (!elevenLabsReady) {
    console.warn("[RECAP] ElevenLabs not configured — sending text-only recaps (set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID for voice)");
  }

  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;
  const rawUrl = (process.env.APP_URL || railwayDomain || "https://kamlifecoach.co.za").replace(/\/$/, "");
  // Auto-prepend https:// if the URL has no protocol (e.g. APP_URL set without it in Railway)
  const appUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const appUrlIsPublicHttps = appUrl.startsWith("https://");
  console.log(`[RECAP] Base URL: ${appUrl} | source: ${process.env.APP_URL ? "APP_URL" : railwayDomain ? "RAILWAY_PUBLIC_DOMAIN" : "fallback"} | HTTPS: ${appUrlIsPublicHttps} | ElevenLabs: ${elevenLabsReady}`);

  // Get Monday of current SAST week as the week identifier
  const d = new Date(Date.now() + 2 * 3_600_000); // shift to SAST before computing calendar week
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  const weekStart = monday.toISOString().slice(0, 10);

  const { rows: activeUsers } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE onboarding_state = 'COMPLETE' AND (subscription_status IN ('active','trial') OR (beta_bypass_until IS NOT NULL AND beta_bypass_until >= NOW())) ORDER BY created_at`
  );

  console.log(`[RECAP] Starting weekly recaps for ${activeUsers.length} active clients (week ${weekStart})`);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const { id } of activeUsers) {
    try {
      // Skip if already sent this week
      const { rows: existing } = await pool.query(
        `SELECT id FROM voice_recap_logs WHERE user_id=$1 AND week_start=$2 AND sent_at IS NOT NULL`,
        [id, weekStart]
      );
      if (existing.length) { skipped++; continue; }

      // Respect the unified daily proactive budget. Sunday already stacks the report
      // card + shopping list + meal plan/audit — the voice recap was the only client
      // message that bypassed the cap entirely, pushing busy Sundays to 5+ messages
      // (the classic "WhatsApp block" churn trigger).
      if (!(await claimProactive(id, "weekly_recap", weekStart))) { skipped++; continue; }

      const data = await getClientWeekData(id);
      if (!data) { failed++; continue; }

      const script = await generateRecapScript(data);
      const audio = elevenLabsReady ? await textToSpeech(script) : null;
      if (audio) recordServiceCost({ userId: id, feature: "voice", costUsd: voiceCostUsd(script.length) }); // whale tracking
      console.log(`[RECAP] ${data.name ?? id.slice(-6)} — audio: ${audio ? `${audio.length} bytes` : "null"}, mediaUrl will be: ${(audio && appUrlIsPublicHttps) ? "set" : "none (text fallback)"}`);

      const recapId = await storeRecapAudio(id, weekStart, script, audio);
      if (!recapId) { failed++; continue; }

      const mediaUrl = (audio && appUrlIsPublicHttps) ? `${appUrl}/api/voice-recap/${recapId}/audio` : undefined;

      let sendSucceeded = false;
      if (mediaUrl) {
        try {
          // WhatsApp requires a non-empty body even with media — include the script text
          await sendWhatsApp(data.phoneNumber, script, mediaUrl);
          sendSucceeded = true;
        } catch (mediaErr: any) {
          console.warn(`[RECAP] Audio send failed for ${data.name ?? id.slice(-6)} (${mediaErr.message}) — falling back to text`);
        }
      }
      if (!sendSucceeded) {
        await sendWhatsApp(data.phoneNumber, script);
      }

      await pool.query(
        `UPDATE voice_recap_logs SET sent_at = NOW() WHERE id = $1`,
        [recapId]
      );

      // NOTE: the week card is NOT sent here anymore (2026-07-12). The Sunday report
      // job (scheduler/jobs/weekly.ts) already sends the *Week Report Card* text with
      // all the numbers — the recap engine sending buildWeekCard too meant the client
      // got the same stats TWICE plus the voice note reading them a third time. The
      // voice note is now the ONLY thing this engine sends: one personal bubble.

      sent++;
      console.log(`[RECAP] ✓ ${data.name ?? id.slice(-6)} — ${script.slice(0, 60)}…`);

      // Respect ElevenLabs + Twilio rate limits — 1 per second
      await new Promise(r => setTimeout(r, 1100));
    } catch (e: any) {
      failed++;
      console.error(`[RECAP] ✗ Failed for user ${id.slice(-6)}:`, e.message);
    }
  }

  console.log(`[RECAP] Done — sent: ${sent}, failed: ${failed}, skipped (already sent): ${skipped}`);
  return { sent, failed, skipped };
}

/**
 * Preview the script that would be generated for a specific user.
 * Used by the dashboard — no audio generated, no message sent.
 */
export async function previewRecapScript(userId: string): Promise<{ script: string; data: ClientWeekData } | null> {
  const data = await getClientWeekData(userId);
  if (!data) return null;
  const script = await generateRecapScript(data);
  return { script, data };
}
