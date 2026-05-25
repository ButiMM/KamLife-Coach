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
import { pool } from "./db";
import { sendWhatsApp } from "./scheduler";
import { textToSpeech, isElevenLabsConfigured } from "./elevenlabs";

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

  const context = [
    `Name: ${firstName}`,
    `Goal: ${data.goalType || "fat loss"}`,
    `Workouts this week: ${data.workoutsThisWeek} / ${trainingTarget} target`,
    `Average steps: ${data.avgStepsThisWeek.toLocaleString()} / ${stepsTarget.toLocaleString()} target`,
    data.weightChange !== null
      ? `Weight change (last 2 weeks): ${data.weightChange > 0 ? "+" : ""}${data.weightChange}kg`
      : "Weight: not logged this week",
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

  const toneRules = data.lifeContext
    ? `TONE: Compassionate. Life comes first. Do NOT frame missed targets as failures.
- Acknowledge the hard week directly. One sentence.
- Give them permission to have had a slow week.
- End with one warm, specific invitation to restart — no pressure, no urgency.`
    : `TONE: Direct South African coach. No cheerleading. No corporate speak.
STRUCTURE (follow this exactly):
1. Name the biggest NUMBER (one stat — workouts or steps). One sentence, no adjectives.
2. Tell them what that number MEANS for their ${data.goalType || "fat loss"} goal. One sentence of real analysis — cause and effect. E.g. "That deficit means your body had to tap into fat stores" or "Missing those sessions means your muscle stimulus was below what we need for growth this month."
3. ONE specific instruction for next week. Tied to their goal. Not vague. E.g. "This week: hit all ${trainingTarget} sessions AND log your weight every morning so I can tell if the recomp is actually shifting."

BANNED PHRASES — if any of these appear, rewrite: "keep pushing", "keep the momentum going", "you've got this", "let's keep pushing", "stay focused", "keep it up", "great effort", "fantastic effort", "well done", "amazing", "impressive", "that's great"`;

  const prompt = `You are Coach K — a direct South African fitness coach. Write a weekly voice note script. Max 75 words. No fluff.

CLIENT DATA:
${context}${lifeNote}
Steps context: ${stepsVsTarget}
Workouts context: ${workoutsVsTarget}

RULES:
- Start with EXACTLY: "Hey ${firstName}, it's Coach K."
- Follow the STRUCTURE above — analysis then direction, not narration
- Use real numbers. Say what they mean. Tell them what to do next week.
- South African voice. Speak to them like a person, not a report card.
- Hard limit: 75 words. No filler. No banned phrases.`;

  try {
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
  const s = data.avgStepsThisWeek.toLocaleString();
  const target = data.trainingDaysPerWeek;
  const stepsTarget = data.stepsTarget ?? 8500;
  const goal = data.goalType || "fat_loss";
  if (w >= target) {
    const stepLine = data.avgStepsThisWeek >= stepsTarget
      ? `${s} steps a day on top of that means your daily deficit is real.`
      : `Steps at ${s} — that needs to come up to ${stepsTarget.toLocaleString()} to support the deficit.`;
    return `Hey ${firstName}, it's Coach K. ${w} out of ${target} sessions this week — you earned that. ${stepLine} This week: log your weight every morning. I need that data to tell if the ${goal === "muscle_gain" ? "muscle" : "fat"} is actually moving.`;
  }
  const missed = target - w;
  return `Hey ${firstName}, it's Coach K. ${w} out of ${target} sessions — ${missed} missed. For ${goal === "muscle_gain" ? "muscle growth" : "fat loss"}, that shortfall matters. Your body needed that stimulus. This week: no skipping. Set an alarm for every training day and treat it like a meeting you can't move.`;
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

export async function runWeeklyRecaps(): Promise<{ sent: number; failed: number; skipped: number }> {
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

  // Get Monday of current week as the week identifier
  const d = new Date();
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

      const data = await getClientWeekData(id);
      if (!data) { failed++; continue; }

      const script = await generateRecapScript(data);
      const audio = elevenLabsReady ? await textToSpeech(script) : null;
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
