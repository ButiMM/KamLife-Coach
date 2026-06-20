/**
 * Media message handler — images, audio/voice, video.
 * Extracted from handleMessage in routes.ts.
 * Always returns a string (every branch is a return).
 */

import crypto from "crypto";
import { tmpdir } from "os";
import { writeFile, unlink } from "fs/promises";
import { createReadStream } from "fs";
import { join as pathJoin } from "path";
import type OpenAI from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { db } from "../db";
import {
  users, chatHistory, stepLogs, mealLogs, progressPhotos,
} from "../../shared/schema";
import { eq, and, gte, lt, asc, desc, sql } from "drizzle-orm";
import {
  buildMediaTrace, withTimeout,
  logMediaFailure, logMediaSuccess, logChat,
} from "./chat-log";
import { askCoachK } from "../gpt";
import { getStepResponse, getStepStreak } from "./steps";
import { checkPerfectDay, checkFoodPatterns } from "./checks";
import { handleWeightLog } from "./weight";
import { handleWater } from "./water";
import { recomputeTodayFoodTotals, invalidateFoodTotalsCache, scanForSAFoods } from "./food-scanner";
import { selectVisionModel, estimateVisionCostUSD } from "../gpt";
import { calculateTargets } from "../targets";
import { sastDayStart, parseMealDate, isRetroactiveMeal, mealDateLabel } from "../utils";
import { sendWhatsApp } from "../scheduler/shared";
import { getExerciseGifUrl } from "../exercise-media";
import { getCurrentDayExercises } from "../programme";
import { matchMachineToDay, machineSetup, machineHowTo, primaryExerciseName } from "../machine-coach";
import { variantGuideHint } from "../exercise-variants";
import { scribeTranscribe } from "../elevenlabs";
import { extractVideoFrames } from "../video-frames";

// ── SAST today string (YYYY-MM-DD) ──
function sastToday(): string {
  const sast = new Date(Date.now() + 2 * 3_600_000);
  return sast.toISOString().slice(0, 10);
}

// ============================================================
// VOICE NOTE FAILURE TRACKER
// Escalates to "please type" after 3 failures in 30 min.
// Keyed by userId. Reset on first successful transcription.
// ============================================================
const voiceFailureMap = new Map<string, { count: number; lastAt: number }>();
const VOICE_FAILURE_RESET_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of voiceFailureMap.entries()) {
    if (now - val.lastAt > VOICE_FAILURE_RESET_MS) voiceFailureMap.delete(key);
  }
}, 15 * 60 * 1000);

export function bumpVoiceFailure(userId: string): number {
  const now = Date.now();
  const prev = voiceFailureMap.get(userId);
  const count = prev && (now - prev.lastAt) < VOICE_FAILURE_RESET_MS ? prev.count + 1 : 1;
  voiceFailureMap.set(userId, { count, lastAt: now });
  return count;
}

export function clearVoiceFailure(userId: string): void {
  voiceFailureMap.delete(userId);
}

// ============================================================
// EQUIPMENT VISION HELPERS
// ============================================================

/** Maps a vision-identified machine description to an exercise slug. */
function getMachineSlug(machineId: string): string | null {
  const m = machineId.toLowerCase();
  if (m.includes("leg press"))                                   return "leg-press";
  if (m.includes("hack squat"))                                  return "hack-squat";
  if (m.includes("smith"))                                       return "squat";
  if (m.includes("squat rack") || m.includes("power rack"))     return "barbell-back-squat";
  if (m.includes("lat pulldown") || m.includes("pull-down") || m.includes("pull down")) return "lat-pulldown";
  if (m.includes("seated row") || (m.includes("cable") && m.includes("row"))) return "seated-row";
  if (m.includes("pec deck") || m.includes("chest fly") || m.includes("pec fly")) return "chest-fly";
  if (m.includes("chest press") || m.includes("bench press"))   return "chest-press";
  if (m.includes("incline") && m.includes("press"))             return "incline-dumbbell-press";
  if (m.includes("shoulder press") || m.includes("overhead press")) return "shoulder-press";
  if (m.includes("leg extension"))                               return "leg-extension";
  if (m.includes("leg curl") || m.includes("hamstring curl"))   return "leg-curl";
  if (m.includes("hip thrust") || m.includes("glute machine"))  return "hip-thrust";
  if (m.includes("calf raise") || m.includes("calf machine"))   return "calf-raise";
  if (m.includes("face pull") || (m.includes("cable") && m.includes("rear"))) return "face-pull";
  if (m.includes("tricep") || m.includes("pushdown"))           return "tricep-pushdown";
  if (m.includes("cable") && m.includes("bicep"))               return "cable-bicep-curl";
  if (m.includes("cable") && m.includes("lateral"))             return "lateral-raise";
  if (m.includes("cable"))                                       return "lat-pulldown"; // generic cable → lat pulldown default
  if (m.includes("rdl") || m.includes("romanian deadlift"))     return "rdl";
  if (m.includes("barbell"))                                     return "barbell-back-squat";
  if (m.includes("pull-up") || m.includes("pull up") || m.includes("assisted pull")) return "lat-pulldown";
  if (m.includes("resistance band"))                             return "resistance-band-row";
  return null;
}

/**
 * Identify a gym machine from a photo and return ready-to-send coaching, or null if the
 * machine can't be recognised. Pulled out of the inline equipment branch so it can ALSO be
 * used as a fallback when the food path misfires on a gym photo (e.g. cluttered, plate-loaded
 * machines that the first classifier missed) — a machine photo must never get a food error.
 */
async function coachGymMachineFromPhoto(
  openai: OpenAI, user: any, base64: string, contentType: string,
): Promise<string | null> {
  try {
    const machineIdRes = await withTimeout("equipment_id", 9000, () =>
      openai.chat.completions.create({
        model: "gpt-4o-mini", max_tokens: 15, temperature: 0,
        messages: [
          {
            role: "system",
            content: `Identify the gym machine or equipment in this photo. Reply with ONLY the equipment name, 2-5 words. Use these terms: leg press, smith machine, lat pulldown, cable machine, chest press machine, shoulder press machine, leg extension machine, leg curl machine, hip thrust machine, seated row machine, hack squat machine, pec deck, squat rack, dumbbells, barbell, resistance bands, pull-up bar, calf raise machine, cable bicep curl, cable lateral raise, face pull. The machine may be plate-loaded (big weight plates on pegs) or have a weight stack — judge by its shape and the seat/pad/handle layout, not the plates. If you genuinely cannot tell, reply: unknown.`,
          },
          { role: "user", content: [{ type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } }] },
        ],
      })
    );
    const machineRaw = machineIdRes.choices[0]?.message?.content?.trim().toLowerCase() || "unknown";
    console.log(`[EQUIPMENT_ID] identified="${machineRaw}" user=${user.id}`);
    if (machineRaw === "unknown" || machineRaw.length <= 2) return null;

    const slug = getMachineSlug(machineRaw);
    const displayName = machineRaw.replace(/\b\w/g, (c: string) => c.toUpperCase());

    if (machineRaw.includes("dumbbell")) {
      let reply = `*Dumbbells* — your programme uses these.\n\nReply *workout* to see exactly what you are doing today with them.\n\nOr type *show me* followed by any exercise name for a form demo.`;
      const dumbbellImg = getExerciseGifUrl("bicep-curl");
      if (dumbbellImg) reply += `\n[MEDIA:${dumbbellImg}]`;
      return reply;
    }

    const imageUrl = slug ? getExerciseGifUrl(slug) : null;
    let day = null;
    try { day = getCurrentDayExercises(user); } catch { /* no programme yet */ }
    const match = matchMachineToDay(slug, machineRaw, day);
    const setup = machineSetup(slug);
    const setupLine = setup ? `⚙️ *Setup:* ${setup}\n` : "";

    let reply: string;
    if (match.kind === "exact" && match.prescribed) {
      const p = match.prescribed;
      reply = `✅ *That's the ${displayName} — exactly what your plan calls for today.*\n\n`
        + `📋 *Your sets:* ${p.setsDisplay}\n`
        + setupLine
        + `✅ *How:* ${p.description}\n`
        + `⚠️ *Don't:* ${p.mistake}`;
    } else if (match.kind === "substitute" && match.prescribed) {
      const p = match.prescribed;
      reply = `*That's a ${displayName}* — not the exact machine your plan names, but it trains the same muscles the same way. Use it today, no problem.\n\n`
        + `📋 *Swap it in for your ${primaryExerciseName(p.name)} — same sets:* ${p.setsDisplay}\n`
        + setupLine
        + `✅ *How:* ${machineHowTo(slug)}`;
    } else {
      reply = `*${displayName}*\n\n`
        + setupLine
        + `✅ *How:* ${machineHowTo(slug)}`;
      reply += day
        ? `\n\nThis isn't on today's session — reply *workout* to see what you're doing today.`
        : `\n\nReply *workout* to get your programme.`;
    }
    const hint = variantGuideHint(slug);
    if (hint) reply += `\n\n${hint}`;
    if (imageUrl) reply += `\n[MEDIA:${imageUrl}]`;
    return reply;
  } catch (e) {
    console.warn("[coachGymMachineFromPhoto] vision failed:", e);
    return null;
  }
}

// ============================================================
// WORKOUT IDENTIFICATION (TikTok/IG screenshots & video frames)
// ============================================================

interface IdentifiedExercise {
  name: string;
  muscles?: string;
  reps?: string | null;
  sets?: string | null;
}
interface WorkoutIdResult {
  exercises: IdentifiedExercise[];
  category?: string | null;
  difficulty?: string | null;
}

/**
 * Identify every distinct exercise across one screenshot or several video frames.
 * Single image → cheap gpt-4o-mini (often just reading an on-screen list); multiple
 * frames → gpt-4o (needs to read the movement). Throws on a malformed reply — callers catch.
 */
async function identifyExercisesFromImages(
  openai: OpenAI,
  images: Array<{ b64: string; ct: string }>,
  model = "gpt-4o",
): Promise<WorkoutIdResult> {
  const userContent: ChatCompletionContentPart[] = [
    {
      type: "text",
      text: images.length > 1
        ? "These are frames from a workout video, in order. Identify every DISTINCT exercise shown across all the frames — do not list the same exercise twice."
        : "This is a screenshot of a workout — the exercises may be listed as on-screen text/caption or shown being performed. Identify every exercise.",
    },
    ...images.map(im => ({
      type: "image_url" as const,
      image_url: { url: `data:${im.ct};base64,${im.b64}`, detail: (images.length > 1 ? "low" : "auto") as "low" | "auto" },
    })),
  ];
  const res = await withTimeout("workout_identify", 25000, () => openai.chat.completions.create({
    model,
    max_tokens: 400,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `You identify exercises from workout images or video frames for a fitness coach. Reply with JSON ONLY:
{"exercises":[{"name":"exercise name","muscles":"primary muscles worked","reps":"reps if visible or null","sets":"sets if visible or null"}],"category":"push|pull|legs|core|cardio|upper|full_body|null","difficulty":"beginner|intermediate|advanced|null"}
List each distinct exercise ONCE, in the order performed. Use common exercise names (hip thrust, RDL, lat pulldown, push-up, lateral raise). If you cannot identify any exercise, reply exactly {"exercises":[],"category":null,"difficulty":null}.`,
      },
      { role: "user", content: userContent },
    ],
  }));
  const raw = res.choices[0]?.message?.content?.trim() || "{}";
  return JSON.parse(raw.replace(/```json|```/g, "").trim()) as WorkoutIdResult;
}

/** Turn an identified workout into a WhatsApp-ready breakdown, or "" if nothing was found. */
function formatWorkoutBreakdown(parsed: WorkoutIdResult | null): string {
  const ex = parsed?.exercises;
  if (!ex || ex.length === 0) return "";
  const lines = ex.slice(0, 12).map((e, i) => {
    const setsReps = e.sets && e.reps ? ` (${e.sets}×${e.reps})` : e.reps ? ` (${e.reps} reps)` : "";
    return `${i + 1}. *${e.name}*${setsReps}${e.muscles ? ` — ${e.muscles}` : ""}`;
  }).join("\n");
  const metaBits = [
    parsed?.category ? String(parsed.category).replace(/_/g, " ") : null,
    parsed?.difficulty ? `${parsed.difficulty} level` : null,
  ].filter(Boolean);
  const meta = metaBits.length ? `\n\n_${metaBits.join(", ")}_` : "";
  const firstMove = ex[0].name.toLowerCase();
  return `Here's the workout — *${ex.length} exercise${ex.length !== 1 ? "s" : ""}*:\n\n${lines}${meta}`
    + `\n\n• Reply *show me ${firstMove}* for a form demo on any move`
    + `\n• Reply *done* once you've trained and I'll log the session`;
}

// ============================================================
// HANDLE MEDIA MESSAGE
// Called from handleMessage when mediaUrl is present.
// ============================================================

export async function handleMediaMessage(ctx: {
  phone: string;
  message: string;
  mediaUrl: string;
  mediaContentType: string | undefined;
  allMediaUrls: string[] | undefined;
  user: any;
  isCoach: boolean;
  openai: OpenAI;
  handleMessage: (phone: string, message: string, mediaUrl?: string, mediaContentType?: string, allMediaUrls?: string[]) => Promise<string>;
}): Promise<string> {
  const { phone, message, mediaUrl, allMediaUrls, user, isCoach, openai, handleMessage } = ctx;
  const ctype = ctx.mediaContentType || "";
  const mediaTrace = buildMediaTrace(phone, ctype);
  const mediaFlowStart = Date.now();
  console.log(`[MEDIA][${mediaTrace}] start type=${ctype || "unknown"} hasCaption=${Boolean(message && message.trim())}`);

  // ---- STICKER DETECTION ----
  if (ctype === "image/webp" && !message) {
    return "I see you sent a sticker — send me a food photo or type what you ate and I will log it.";
  }

  // ---- IMAGE (food photo, steps screenshot, progress photo) ----
  if (ctype.startsWith("image/")) {
    try {
      const twilioSid = process.env.TWILIO_ACCOUNT_SID || "";
      const twilioToken = process.env.TWILIO_AUTH_TOKEN || "";
      const imgAuthHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
      const imgDownloadStart = Date.now();
      const imageResponse = await withTimeout("image_download", 12000, () => fetch(mediaUrl, {
        headers: { Authorization: imgAuthHeader },
      }));
      if (!imageResponse.ok) {
        const dlMs = Date.now() - imgDownloadStart;
        console.error(`[MEDIA][${mediaTrace}] image_download_failed status=${imageResponse.status} ms=${dlMs}`);
        await logMediaFailure(user.id, "image_download", `${imageResponse.status}`, dlMs);
        return "Eish, I cannot read that photo right now. Tell me what you ate in text — 'chicken and sweet potato' — and I will give you the full breakdown.";
      }
      const imageLen = parseInt(imageResponse.headers.get("content-length") || "0", 10);
      if (imageLen > 8 * 1024 * 1024) {
        console.warn(`[MEDIA][${mediaTrace}] image_too_large content_length=${imageLen}`);
        return "That image is too large for reliable processing. Please resend a smaller screenshot or crop it tighter.";
      }
      const buffer = await imageResponse.arrayBuffer();
      if (buffer.byteLength > 10 * 1024 * 1024) {
        console.warn(`[MEDIA][${mediaTrace}] image_buffer_too_large bytes=${buffer.byteLength}`);
        return "That image is too large for reliable processing. Please resend a smaller screenshot or crop it tighter.";
      }
      const imgDownloadMs = Date.now() - imgDownloadStart;
      console.log(`[MEDIA][${mediaTrace}] image_download_ok bytes=${buffer.byteLength} ms=${imgDownloadMs}`);
      const base64 = Buffer.from(buffer).toString("base64");
      const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
      const clientName = user.name || "there";
      const goal = user.goalType || "fat_loss";

      // ---- STEP SCREENSHOT DETECTION ----
      const noCaption = !message || message.trim().length === 0;
      let isStepScreenshot = /\b(steps?|pedometer|walked|walking|step count|staps?|my walk|fitness app|samsung health|google fit|apple health|health app|screenshot)\b/i.test(message)
        || (user.awaitingInputType === "steps");

      // ---- IMAGE PRE-CLASSIFIER ----
      // Runs for: (a) no caption, or (b) caption with no obvious food keywords —
      // so body photos captioned "Alot of work to be done" still get correctly classified.
      const hasObviousFoodCaption = /\b(ate|had|eat|eating|lunch|dinner|breakfast|meal|food|snack|protein|calories)\b/i.test(message || "");
      let isCollage = false;
      let uncaptionedType: "food" | "steps" | "exercise" | "progress" | "other" | null = null;
      if ((noCaption || !hasObviousFoodCaption) && !isStepScreenshot) {
        try {
          const classifyResp = await withTimeout("image_classify", 8000, () => openai.chat.completions.create({
            model: "gpt-4o-mini",
            max_tokens: 8,
            temperature: 0,
            messages: [
              { role: "system", content: "Classify a WhatsApp photo sent to a fitness coach. Reply with ONE word only, lowercase: food | steps | exercise | progress | equipment | scale | collage | other.\n- food: plate of food, drink, snack, meal, meal prep container, food packaging, protein shake can/bottle/sachet, protein bar wrapper, supplement tub/bottle showing a food product, grocery item, any branded food or nutrition product\n- steps: screenshot showing a step count or pedometer reading from a fitness app (Samsung Health, Google Fit, Apple Health, Garmin, Fitbit, Huawei Health)\n- scale: a bathroom scale or body weight scale showing a number — the person is standing on it or it is held up showing a kg/lb reading\n- exercise: person actively performing an exercise movement (mid-squat, lifting, running)\n- progress: person standing/posing still to show body shape — front, side or back pose, even if wearing gym clothes. Before/after transformation photos. Multiple people posing.\n- equipment: photo of gym equipment, dumbbells, resistance bands, treadmill, exercise machines, home gym setup, weight sets — NO person in the photo or person is incidental\n- collage: image containing MULTIPLE different panels — e.g. food photos combined with a step count screenshot, a grid of multiple meal photos, or any image where different sections show different types of content (food AND stats, multiple meals arranged together)\n- other: none of the above\nIMPORTANT: If a person is POSING or STANDING STILL (not mid-movement), classify as progress, not exercise. Protein powder tubs, protein shake cans, and any branded food product = food, NOT equipment. A grid or collage with mixed content types = collage." },
              { role: "user", content: [
                { type: "text", text: "What is this photo?" },
                { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } },
              ] },
            ],
          }));
          const raw = (classifyResp.choices[0]?.message?.content || "").trim().toLowerCase();
          if (raw.includes("collage")) uncaptionedType = "collage" as any;
          else if (raw.includes("food")) uncaptionedType = "food";
          else if (raw.includes("steps") || raw.includes("step")) uncaptionedType = "steps";
          else if (raw.includes("scale")) uncaptionedType = "scale" as any;
          else if (raw.includes("exercise")) uncaptionedType = "exercise";
          else if (raw.includes("progress")) uncaptionedType = "progress";
          else if (raw.includes("equipment")) uncaptionedType = "equipment" as any;
          else uncaptionedType = "other";
          console.log(`[MEDIA][${mediaTrace}] uncaptioned_classified=${uncaptionedType}`);
          if (uncaptionedType === "steps") isStepScreenshot = true;
          // Collage: extract steps AND run food vision on the same image
          if ((uncaptionedType as any) === "collage") {
            isCollage = true;
            isStepScreenshot = true;
            uncaptionedType = "food"; // fallback if step OCR fails
          }
          if (uncaptionedType === "exercise") {
            const isFormCheckCaption = /\b(form|check|correct|right|wrong|how does|how do i look|am i doing|my form|check my|is this right|watch me|look at me)\b/i.test(message || "");
            if (isFormCheckCaption) {
              const exReply = `${user.name || "Sharp"} — I can see that's a gym / exercise photo, but I cannot give form feedback from a still shot taken mid-set.\n\nFor form coaching: send a clear photo from the side showing the bottom of the movement (e.g. deepest point of squat, bar touching chest on bench). Or tell me the exercise and what feels off.\n\nIf you were trying to log a workout, reply *done* — I will log today's session.`;
              await logChat(user.id, "[Exercise Photo]", exReply, "EXERCISE_PHOTO");
              return exReply;
            }
            // Reference screenshot — a TikTok/IG workout the client saved. Identify the moves.
            const shotParsed = await identifyExercisesFromImages(
              openai, [{ b64: base64, ct: contentType }], "gpt-4o-mini",
            ).catch((e) => { console.warn("[exercise_identify]", e); return null; });
            const shotBreakdown = formatWorkoutBreakdown(shotParsed);
            if (shotBreakdown) {
              await logChat(user.id, "[Workout Screenshot]", shotBreakdown, "WORKOUT_SCREENSHOT");
              return shotBreakdown;
            }
            const exFallback = `I can see a workout screenshot but couldn't pick out the exercises clearly. Just type or voice-note the moves — e.g. *"hip thrusts, RDLs, leg curls"* — and I'll break them all down.`;
            await logChat(user.id, "[Exercise Photo]", exFallback, "EXERCISE_PHOTO");
            return exFallback;
          }
          if ((uncaptionedType as any) === "equipment") {
            // Only treat as a HOME-EQUIPMENT DECLARATION when the caption clearly says
            // "this is my kit" — never swallow a question like "how do I use this machine".
            const hasEquipCaption = /\b(i have (this|these|a set|dumbbell|band|kettlebell|barbell)|my (own )?(equipment|kit|gym|setup|weights)|i (just )?(got|bought) (this|these|a|some|new)|these are my|this is my (equipment|kit|gym|setup|home))\b/i.test(message || "");
            if (hasEquipCaption) {
              const equipReply = `I can see your equipment. To update your programme, tell me what you have — reply:\n\n*dumbbells* — if you have dumbbells\n*bands* — if you have resistance bands\n*mix* — if you have both\n\nOr just describe it and I will update your profile.`;
              await logChat(user.id, "[Equipment Photo]", equipReply, "EQUIPMENT_PHOTO");
              return equipReply;
            }

            // ── Smart machine identification → match against today's real plan ──────
            //   exact      → "that's the machine your plan calls for — here's your sets + how"
            //   substitute → "same muscles, same movement — swap it in"
            //   other      → "here's how to use it; it's not on today's plan"
            // Prescription (sets/how/mistake) comes from the user's real programme, so the
            // photo reply never contradicts their workout text.
            const equipReply = (await coachGymMachineFromPhoto(openai, user, base64, contentType))
              || `Nice. Reply *workout* for today's session, or type *show me* followed by any exercise name for a form demo.`;
            await logChat(user.id, "[Equipment Photo]", equipReply, "EQUIPMENT_ID");
            return equipReply;
          }
          // ---- SCALE / BODY WEIGHT PHOTO ----
          if ((uncaptionedType as any) === "scale") {
            try {
              const scaleOcr = await withTimeout("scale_ocr", 10000, () => openai.chat.completions.create({
                model: "gpt-4o-mini", max_tokens: 10, temperature: 0,
                messages: [
                  { role: "system", content: "Read the body weight number shown on this bathroom scale. Reply with ONLY the number in kg (e.g. 82.4). If you cannot read it clearly, reply NOT_VISIBLE." },
                  { role: "user", content: [{ type: "text", text: "What weight does this scale show?" }, { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } }] },
                ],
              }));
              const scaleText = (scaleOcr.choices[0]?.message?.content || "").trim();
              const weightKg = parseFloat(scaleText.replace(/[^0-9.]/g, ""));
              if (!isNaN(weightKg) && weightKg > 30 && weightKg < 300) {
                const scaleReply = await handleWeightLog(phone, user, weightKg);
                await logChat(user.id, "[Scale Photo]", scaleReply, "WEIGHT_LOG");
                return scaleReply;
              }
            } catch {}
            await db.update(users).set({ awaitingInputType: "weight" }).where(eq(users.phoneNumber, phone));
            const scaleAskReply = `I can see the scale — what does it read? Send me the number (e.g. *82.4 kg*) and I'll log it.`;
            await logChat(user.id, "[Scale Photo]", scaleAskReply, "WEIGHT_PROMPT");
            return scaleAskReply;
          }
        } catch (e) {
          console.warn(`[MEDIA][${mediaTrace}] uncaptioned_classify_failed:`, e);
        }
      }

      // ---- STEP SCREENSHOT OCR ----
      if (isStepScreenshot) {
        try {
          const stepVisionResponse = await withTimeout("step_vision", 18000, () => openai.chat.completions.create({
            model: "gpt-4o-mini",
            max_tokens: 50,
            messages: [
              { role: "system", content: "You verify and extract step counts from screenshots of pedometer/fitness apps (Samsung Health, Google Fit, Apple Health, Fitbit, Huawei Health, Garmin, etc). The number MUST be visibly labelled as steps in the image (next to the word 'steps', a footprint icon, or inside a clearly identified steps card). Distance (km), calories, heart rate, dates, phone numbers, prices, times, or any other number — DO NOT extract. If no step count is clearly labelled, reply NOT_STEPS. Otherwise reply with ONLY the step number, no other text." },
              { role: "user", content: [
                { type: "text", text: "Extract the labelled step count from this screenshot, or reply NOT_STEPS." },
                { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } },
              ] },
            ],
          }));
          const stepText = stepVisionResponse.choices[0]?.message?.content?.trim() || "UNKNOWN";
          const visionRejected = /\b(NOT_STEPS|UNKNOWN)\b/i.test(stepText);
          const extractedSteps = visionRejected ? NaN : parseInt(stepText.replace(/[^0-9]/g, ""));
          const explicitStepIntent = /\b(steps?|pedometer|walk|walking|step count|screenshot)\b/i.test(message) || (user.awaitingInputType === "steps");
          const looksLikeStepCount = extractedSteps >= 500 && extractedSteps <= 35000;
          const acceptableLowCount = explicitStepIntent && extractedSteps >= 100 && extractedSteps < 500;
          if (!visionRejected && !isNaN(extractedSteps) && (looksLikeStepCount || acceptableLowCount)) {
            const target = user.stepsTarget || 10000;
            const todayStartSteps = sastDayStart();
            // Dedup: if the exact same step count was already logged within the last 5 minutes, skip
            const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
            const recentDup = await db.select({ id: stepLogs.id, steps: stepLogs.steps })
              .from(stepLogs)
              .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, fiveMinAgo)))
              .orderBy(desc(stepLogs.loggedAt))
              .limit(1);
            if (recentDup.length > 0 && recentDup[0].steps === extractedSteps) {
              console.log(`[MEDIA][${mediaTrace}] step_dedup skipped value=${extractedSteps}`);
              return `Already logged ${extractedSteps.toLocaleString()} steps for today. ✅`;
            }
            const existingStep = await db.select({ id: stepLogs.id, steps: stepLogs.steps })
              .from(stepLogs)
              .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStartSteps)))
              .limit(1);
            if (existingStep.length > 0) {
              const currentSteps = existingStep[0].steps ?? 0;
              if (extractedSteps > currentSteps) {
                // Steps went up — valid update (cumulative daily total increasing)
                await db.update(stepLogs).set({ steps: extractedSteps }).where(eq(stepLogs.id, existingStep[0].id));
                console.log(`[MEDIA][${mediaTrace}] step_updated prev=${currentSteps} new=${extractedSteps}`);
              } else {
                // New value is lower than today's logged max — keep the higher value, still acknowledge
                console.log(`[MEDIA][${mediaTrace}] step_kept_max existing=${currentSteps} submitted=${extractedSteps}`);
                await logChat(user.id, `[Step Screenshot: ${extractedSteps}]`, `[kept existing max: ${currentSteps}]`, "STEP_LOG");
                return `Steps already logged higher today (${currentSteps.toLocaleString()}). If that's wrong, let me know and I'll fix it.`;
              }
            } else {
              await db.insert(stepLogs).values({ userId: user.id, steps: extractedSteps });
            }
            await db.update(users).set({ lastActiveAt: new Date(), awaitingInputType: null }).where(eq(users.phoneNumber, phone));
            const [perfectDay, streak] = await Promise.all([checkPerfectDay(user.id, user.proteinTarget || 120), getStepStreak(user.id)]);
            const stepReply = getStepResponse(extractedSteps, target, parseFloat(user.currentWeight as string || "75") || 75, streak, undefined, user);
            await logChat(user.id, `[Step Screenshot: ${extractedSteps}]`, stepReply, "STEP_LOG");
            console.log(`[MEDIA][${mediaTrace}] step_logged value=${extractedSteps}`);

            // Collage: run food vision on the same image async — food panel was ignored until now
            if (isCollage) {
              (async () => {
                try {
                  const { calorieTarget: cCal, proteinTarget: cProt } = calculateTargets(
                    parseFloat(user.currentWeight || "75"), goal, user.lifeSituation || "office",
                    user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30,
                    user.heightCm || 170, user.trainingExperience || "beginner"
                  );
                  const fvDecision = selectVisionModel("food_photo", isCoach ? "active" : user.subscriptionStatus);
                  if (!fvDecision.allowed) return;
                  const vis = await withTimeout("collage_food_vision", 22000, () => openai.chat.completions.create({
                    model: fvDecision.model, max_tokens: fvDecision.maxTokens,
                    messages: [
                      { role: "system", content: `You are Coach K, a South African fitness and nutrition coach. Client: ${clientName}. Goal: ${goal}. Daily targets: ${cCal} kcal and ${cProt}g protein. This is a collage image — analyse only the FOOD panels. Ignore step-counter or fitness app panels. Identify each food item with its estimated kcal and protein. Never criticise what was eaten — they have already eaten it. End with: "TOTAL: X kcal | Yg protein". If no food is visible, reply exactly: NOT_FOOD` },
                      { role: "user", content: [
                        { type: "text", text: "Identify and estimate all food visible in this collage." },
                        { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}`, detail: "auto" } },
                      ]},
                    ],
                  })).catch(() => null);
                  const txt = vis?.choices[0]?.message?.content?.trim() || "";
                  console.log(`[COLLAGE_FOOD] vision reply: ${txt.slice(0, 120)}`);
                  if (!txt || /^NOT_FOOD\b/i.test(txt)) return;
                  const tl = txt.match(/TOTAL:\s*([\d,]+)\s*kcal\s*\|\s*(\d+)\s*g\s*protein/i);
                  const kcal = tl ? parseInt(tl[1].replace(/,/g, ""), 10) : 0;
                  const prot = tl ? parseInt(tl[2], 10) : 0;
                  if (kcal <= 0 && prot <= 0) return;
                  await db.insert(mealLogs).values({
                    userId: user.id, source: "photo", kcalInt: kcal, proteinInt: prot,
                    loggedAt: new Date(), rawMessage: "[Collage food]", mealLabel: "Collage meal",
                  }).catch((e) => console.error("[COLLAGE_FOOD] mealLogs insert failed:", e));
                  await logChat(user.id, "[Photo - collage meal]", txt, "FOOD_LOG");
                  invalidateFoodTotalsCache(user.id);
                  const totals = await recomputeTodayFoodTotals(user.id).catch(() => null);
                  const totalNote = totals?.calories ? `\n\n_Today so far: ~${totals.calories} kcal | ${totals.protein}g protein._` : "";
                  const displayTxt = txt.replace(/\nTOTAL:.*$/im, "").trim();
                  await sendWhatsApp(phone, `Also logged your meal from the photo:\n\n${displayTxt}\n\n*~${kcal} kcal | ~${prot}g protein*${totalNote}`);
                  console.log(`[COLLAGE_FOOD] food logged and sent kcal=${kcal} prot=${prot}`);
                } catch (ce) { console.error("[COLLAGE_FOOD] error:", ce); }
              })();
            }

            // Album: if other images were sent in the same message, process them as food photos
            const albumExtras = (allMediaUrls || []).filter(u => u !== mediaUrl);
            if (albumExtras.length > 0) {
              const albumAuthHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
              console.log(`[ALBUM_FOOD] processing ${albumExtras.length} extra image(s) for user=${user.id.slice(-6)}`);
              (async () => {
                try {
                  let albumKcal = 0, albumProt = 0;
                  const albumParts: string[] = [];
                  for (const extraUrl of albumExtras.slice(0, 3)) {
                    const r = await fetch(extraUrl, { headers: { Authorization: albumAuthHeader } }).catch(() => null);
                    if (!r?.ok) { console.warn(`[ALBUM_FOOD] download failed url=${extraUrl.slice(-20)}`); continue; }
                    const buf = await r.arrayBuffer();
                    if (buf.byteLength > 10 * 1024 * 1024) continue;
                    const b64 = Buffer.from(buf).toString("base64");
                    const ct = r.headers.get("content-type") || "image/jpeg";
                    const vis = await withTimeout("album_food_vision", 22000, () => openai.chat.completions.create({
                      model: "gpt-4o-mini", max_tokens: 250,
                      messages: [
                        { role: "system", content: `You are Coach K, a South African fitness coach. Analyse this food photo and estimate calories and protein. Always end with a line in this exact format: "TOTAL: X kcal | Yg protein". If the image is clearly not food (fitness app screenshot, step counter, person, gym equipment), reply exactly: NOT_FOOD` },
                        { role: "user", content: [
                          { type: "text", text: "Estimate calories and protein in this photo." },
                          { type: "image_url", image_url: { url: `data:${ct};base64,${b64}`, detail: "auto" } },
                        ]},
                      ],
                    })).catch((e) => { console.warn("[ALBUM_FOOD] vision error:", e?.message); return null; });
                    const text = vis?.choices[0]?.message?.content?.trim() || "";
                    console.log(`[ALBUM_FOOD] vision reply: ${text.slice(0, 100)}`);
                    if (/^NOT_FOOD\b/i.test(text)) continue;
                    // Parse TOTAL: line first, fall back to first kcal mention
                    const totalLine = text.match(/TOTAL:\s*([\d,]+)\s*kcal\s*\|\s*(\d+)\s*g\s*protein/i);
                    const kcalRaw = totalLine ? parseInt(totalLine[1].replace(/,/g, ""), 10)
                      : (() => { const m = text.match(/\b([\d,]{2,7})\s*kcal/i); return m ? parseInt(m[1].replace(/,/g, ""), 10) : 0; })();
                    const protRaw = totalLine ? parseInt(totalLine[2], 10)
                      : (() => { const m = text.match(/\b(\d{1,3})\s*g\s*protein/i); return m ? parseInt(m[1], 10) : 0; })();
                    const kcal = Number.isFinite(kcalRaw) ? Math.min(3000, Math.max(0, kcalRaw)) : 0;
                    const prot = Number.isFinite(protRaw) ? Math.min(200, Math.max(0, protRaw)) : 0;
                    console.log(`[ALBUM_FOOD] extracted kcal=${kcal} prot=${prot}`);
                    if (kcal <= 0 && prot <= 0) continue; // non-food image — skip
                    albumKcal += kcal; albumProt += prot;
                    albumParts.push(text.replace(/\nTOTAL:.*$/i, "").trim());
                    await db.insert(mealLogs).values({
                      userId: user.id, source: "photo", kcalInt: kcal, proteinInt: prot,
                      loggedAt: new Date(), rawMessage: "[Album photo]", mealLabel: "Album meal",
                    }).catch((e) => console.error("[ALBUM_FOOD] mealLogs insert failed:", e));
                    await logChat(user.id, "[Photo - album meal]", text, "FOOD_LOG");
                  }
                  if (albumKcal > 0) {
                    invalidateFoodTotalsCache(user.id);
                    const suffix = albumParts.length > 1 ? "s" : "";
                    const totals = await recomputeTodayFoodTotals(user.id).catch(() => null);
                    const totalNote = totals && totals.calories > 0
                      ? `\n\n_Today so far: ~${totals.calories} kcal | ${totals.protein}g protein._`
                      : "";
                    await sendWhatsApp(phone, `Also logged your meal${suffix} from the photo${suffix}:\n\n${albumParts.join("\n\n")}\n\n*~${albumKcal} kcal | ~${albumProt}g protein*${totalNote}`);
                    console.log(`[ALBUM_FOOD] sent food response albumKcal=${albumKcal} albumProt=${albumProt}`);
                  } else {
                    console.warn(`[ALBUM_FOOD] no food detected in any extra image — nothing sent`);
                  }
                } catch (albumErr) { console.error("[ALBUM_FOOD] fatal:", albumErr); }
              })();
            }

            // Adaptive target suggestion — only when client has been consistently hitting
            // their target. Requires streak >= 5 so casual users never see this.
            let adaptiveNote = "";
            if (streak >= 5 && extractedSteps >= target && target < 20000) {
              try {
                const weekAgo = new Date(Date.now() - 7 * 86_400_000);
                const recentHits = await db.select({ steps: stepLogs.steps })
                  .from(stepLogs)
                  .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, weekAgo)))
                  .limit(7);
                const hitsThisWeek = recentHits.filter(l => (l.steps ?? 0) >= target).length;
                if (hitsThisWeek >= 5) {
                  const newTarget = target + 1000;
                  adaptiveNote = `\n\n_You've hit ${target.toLocaleString()} steps ${hitsThisWeek}/7 days this week. Reply *"steps goal ${newTarget}"* to raise your target to ${newTarget.toLocaleString()}._`;
                }
              } catch { /* non-fatal */ }
            }

            return stepReply + (perfectDay || "") + adaptiveNote;
          }
        } catch (e) {
          console.warn("[step-vision]", e);
          await logMediaFailure(user.id, "step_vision", e);
        }
        console.warn(`[MEDIA][${mediaTrace}] step_extract_failed`);
        await logMediaFailure(user.id, "step_extract", "unknown_or_low_confidence");
        return "I could not read the step number clearly from that screenshot. Please resend and crop to the step count only, or type: steps 7421.";
      }

      // ---- PROGRESS PHOTO ----
      const isProgressPhoto = uncaptionedType === "progress"
        || (
          /\b(progress|transformation|check.?in|monthly|before|after|month \d|week \d+)\b/i.test(message)
          && uncaptionedType === null
        );
      if (isProgressPhoto) {
        const existingPhotos = await db.select()
          .from(progressPhotos)
          .where(eq(progressPhotos.userId, user.id))
          .orderBy(asc(progressPhotos.loggedAt))
          .limit(10);

        const photoNumber = existingPhotos.length + 1;
        await db.insert(progressPhotos).values({ userId: user.id, photoNumber, photoBase64: base64, contentType });
        await logChat(user.id, `[Progress Photo ${photoNumber}]`, "[Photo received]", "PROGRESS_PHOTO");

        // Save any additional album photos as progress photos (client sends front/side/back together)
        const albumExtrasProgress = (allMediaUrls || []).filter(u => u !== mediaUrl).slice(0, 3);
        let albumSavedCount = 0;
        if (albumExtrasProgress.length > 0) {
          const imgAuthHeaderProg = "Basic " + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID || ""}:${process.env.TWILIO_AUTH_TOKEN || ""}`).toString("base64");
          for (const extraUrl of albumExtrasProgress) {
            try {
              const r = await fetch(extraUrl, { headers: { Authorization: imgAuthHeaderProg } });
              if (!r.ok) continue;
              const buf = await r.arrayBuffer();
              if (buf.byteLength > 10 * 1024 * 1024) continue;
              const extraB64 = Buffer.from(buf).toString("base64");
              const extraCtype = r.headers.get("content-type") || "image/jpeg";
              const nextNum = (await db.select({ id: progressPhotos.id }).from(progressPhotos).where(eq(progressPhotos.userId, user.id))).length + 1;
              await db.insert(progressPhotos).values({ userId: user.id, photoNumber: nextNum, photoBase64: extraB64, contentType: extraCtype });
              await logChat(user.id, `[Progress Photo ${nextNum}]`, "[Album photo received]", "PROGRESS_PHOTO");
              albumSavedCount++;
            } catch (e) { console.warn("[progress album extra]", e); }
          }
        }
        const totalProgressSaved = 1 + albumSavedCount;
        const progressCountLabel = totalProgressSaved > 1 ? `${totalProgressSaved} photos saved` : "Photo saved";

        // ── PROGRESS PHOTO COMPARISON (follow-up via WhatsApp) ──────────────────
        // Trigger if: user has at least 1 earlier photo AND the earliest is 14+ days old.
        const earliestPhoto = existingPhotos.length > 0 ? existingPhotos[0] : null;
        const earliestAgeMs = earliestPhoto ? Date.now() - new Date(earliestPhoto.loggedAt || "").getTime() : 0;
        const earliestAgeDays = Math.round(earliestAgeMs / 86_400_000);
        const comparisonEligible = earliestPhoto !== null && earliestAgeDays >= 14;

        if (comparisonEligible) {
          // Return an immediate acknowledgment, then fire comparison async.
          const ackMsg = `${progressCountLabel}, ${clientName}. Give me a moment to compare it to your baseline — I will send the breakdown right away.`;
          // Fire async — do not await so the webhook reply is fast.
          (async () => {
            try {
              const progressDecision = selectVisionModel("progress_compare", isCoach ? "active" : user.subscriptionStatus);
              console.log(`[VISION][${mediaTrace}] progress_compare model=${progressDecision.model} tier=${user.subscriptionStatus} photos=${photoNumber} earliestAgeDays=${earliestAgeDays}`);

              const goalLabel = goal === "fat_loss" ? "fat loss" : goal === "muscle_gain" ? "muscle gain" : "body recomposition";
              const weeksLabel = Math.round(earliestAgeDays / 7);
              const weekStr = weeksLabel === 1 ? "1 week" : `${weeksLabel} weeks`;

              const imageContent: ChatCompletionContentPart[] = [
                {
                  type: "text",
                  text: `Compare these two progress photos for a client whose goal is ${goalLabel}.\n\nPhoto 1 (baseline) was taken ${earliestAgeDays} days ago (${weekStr}). Photo 2 is today's check-in (Photo ${photoNumber}).\n\nAnalyse:\n- Visible changes in body composition: fat loss, muscle definition, posture\n- Be specific about what is visibly different — shoulders, waist, arms, stomach\n- Reference their goal (${goalLabel})\n- 4–5 sentences, South African coaching voice\n- Never say "I can see significant changes" if there are none — be honest about what you do or do not see, and explain why (lighting, angle, clothing) if comparison is limited\n- End with ONE specific next action they should focus on in the next 30 days`,
                },
                { type: "image_url", image_url: { url: `data:${earliestPhoto.contentType};base64,${earliestPhoto.photoBase64}`, detail: progressDecision.detail } },
                { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}`, detail: progressDecision.detail } },
              ];

              const comparisonResponse = await openai.chat.completions.create({
                model: progressDecision.model,
                max_tokens: progressDecision.maxTokens,
                messages: [
                  {
                    role: "system",
                    content: `You are Coach K, a South African fitness and nutrition coach with 20 years experience. The client's name is ${clientName}. Their goal is ${goalLabel}. Direct, warm, specific — SA voice. Focus on visible physical changes only. Never discuss weight unless you can see a scale. Never say "great progress" as a standalone — describe what you actually see.`,
                  },
                  { role: "user", content: imageContent },
                ],
              });

              const progressTokens = comparisonResponse.usage?.completion_tokens || 0;
              console.log(`[COST][${mediaTrace}] progress_compare ~$${estimateVisionCostUSD(progressDecision, progressTokens).toFixed(5)} (${progressDecision.reason})`);

              const comparisonText = comparisonResponse.choices[0]?.message?.content?.trim()
                || "I can see both photos but could not compare them clearly. Send in good lighting, same pose if possible.";

              const followUpMsg = `*${weekStr} comparison — Photo 1 vs Photo ${photoNumber}*\n\n${comparisonText}\n\n_Next check-in: 30 days. Same pose, same lighting — it makes the comparison sharper._`;

              await logChat(user.id, `[Progress Comparison Photo ${photoNumber}]`, followUpMsg, "PROGRESS_COMPARISON");
              await sendWhatsApp(phone, followUpMsg);
            } catch (compErr) {
              console.error(`[MEDIA][${mediaTrace}] progress_compare_error:`, compErr);
            }
          })();

          return ackMsg;
        } else {
          return `${progressCountLabel}, ${clientName}. Baseline saved.\n\nSend your next one in 30 days — same lighting, same pose if you can. I'll compare them side by side and show you exactly what shifted. Keep training.`;
        }
      }

      // ---- EQUIPMENT DECLARATION WITH CAPTION ----
      // Client sends "I have this set" / "these are my weights" + equipment photo → update profile
      const isEquipCaption = /\b(i have (this|these|this set|a set|dumbbells?|bands?|weights?|kettlebell|barbell)|these are my (weights?|equipment|kit|dumbbells?)|this is my (equipment|kit|set)|i (use|got|bought) (this|these|dumbbells?|bands?|weights?)|my (home )?equipment|i train with (these|this|dumbbells?|bands?))\b/i.test(message || "");
      if (isEquipCaption) {
        try {
          const equipVision = await withTimeout("equip_vision", 10000, () => openai.chat.completions.create({
            model: "gpt-4o-mini", max_tokens: 20, temperature: 0,
            messages: [
              { role: "system", content: "Identify gym equipment in this image. Reply with ONE word only: dumbbells | bands | barbell | kettlebell | machine | mixed | other" },
              { role: "user", content: [{ type: "text", text: "What equipment is shown?" }, { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } }] },
            ],
          }));
          const equipType = (equipVision.choices[0]?.message?.content || "").trim().toLowerCase();
          const hasDumbbells = equipType.includes("dumbbell") || equipType.includes("mixed");
          const hasBands = equipType.includes("band");
          const newMode = "home";
          await db.update(users).set({ trainingMode: newMode }).where(eq(users.id, user.id));
          const equipLabel = hasDumbbells ? "dumbbells" : hasBands ? "resistance bands" : "home equipment";
          const equipReply = `Got it — updated to home training with ${equipLabel}. Your programme will use what you have.\n\nReply *workout* for today's session and I'll send a dumbbell-based session that fits your goal.`;
          await logChat(user.id, "[Equipment Photo]", equipReply, "EQUIPMENT_UPDATE");
          return equipReply;
        } catch {
          // fall through to food vision if vision fails
        }
      }

      // ---- WATER BOTTLE / HYDRATION PHOTO ----
      // Detect water bottles or glasses before falling through to food vision.
      // Caption hints: "my water", "water bottle", "how much", "how full"
      const isWaterCaption = /\b(my water|water bottle|water glass|hydration|how much water|how full|filled|refill|drinking water)\b/i.test(message || "");
      if (isWaterCaption || /^(water|💧)$/i.test((message || "").trim())) {
        try {
          const bottleCheck = await withTimeout("bottle_check", 8000, () => openai.chat.completions.create({
            model: "gpt-4o-mini", max_tokens: 80, temperature: 0,
            messages: [
              { role: "system", content: `You are analysing a photo. Reply with JSON only: {"isBottle": true/false, "sizeMl": number or null, "fillPct": number 0-100 or null}.\nisBottle: true if the photo primarily shows a water bottle, glass, cup, or drinking container.\nsizeMl: your best estimate of the container's capacity in ml (500 for a standard bottle, 750 for a gym bottle, 1000 for a 1L bottle, 330 for a small bottle, 250 for a glass).\nfillPct: how full it appears (100 = completely full, 50 = half, 0 = empty).` },
              { role: "user", content: [{ type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } }] },
            ],
          }));
          const raw = bottleCheck.choices[0]?.message?.content?.trim() || "{}";
          const cleaned = raw.replace(/```json|```/g, "").trim();
          const parsed = JSON.parse(cleaned) as { isBottle?: boolean; sizeMl?: number | null; fillPct?: number | null };
          if (parsed.isBottle) {
            const sizeMl = parsed.sizeMl || 500;
            const fillPct = parsed.fillPct ?? 100;
            const drankMl = Math.round(sizeMl * (fillPct / 100));
            const litres = Math.round(drankMl / 100) / 10;
            // Estimate remaining based on fill
            const sizeLabel = sizeMl >= 900 ? `${(sizeMl / 1000).toFixed(1)}L` : `${sizeMl}ml`;
            const fillLabel = fillPct >= 90 ? "full" : fillPct >= 60 ? "about two-thirds full" : fillPct >= 35 ? "about half full" : fillPct >= 10 ? "nearly empty" : "empty";
            const waterTarget = Math.max(2.0, Math.round((parseFloat(user.currentWeight || "75")) * 0.033 * 10) / 10);
            const todayStr = sastToday();
            const waterUpdated = await db.update(users).set({
              todayWater: sql`CASE WHEN water_last_reset_date = ${todayStr} THEN COALESCE(today_water::numeric, 0) + ${litres} ELSE ${litres} END`,
              waterLastResetDate: todayStr,
            }).where(eq(users.id, user.id)).returning({ todayWater: users.todayWater });
            const newTotal = Math.round((Number(waterUpdated[0]?.todayWater) || litres) * 10) / 10;
            const remaining = Math.max(0, Math.round((waterTarget - newTotal) * 10) / 10);
            const targetHit = newTotal >= waterTarget;
            const bottleReply = targetHit
              ? `${sizeLabel} bottle, ${fillLabel} — that puts you at ${newTotal}L today. ✅ Water target hit.`
              : `${sizeLabel} bottle, ${fillLabel} — logged ${litres}L. Total today: ${newTotal}L / ${waterTarget}L. ${remaining}L to go.`;
            await logChat(user.id, "[Water Bottle Photo]", bottleReply, "WATER_LOG");
            return bottleReply;
          }
        } catch {
          // vision failed or not a bottle — fall through to food
        }
      }

      // ---- FOOD PHOTO ----
      // Detect "is this okay?" captions — client is asking for approval, not just logging
      const isApprovalCaption = /^[?!¿]+$/.test((message || "").trim())
        || /\b(is this ok|is this good|is this fine|can i eat|can i have|should i eat|good or bad|ok for me|okay for me|allowed|this ok|this good|fits? my (goal|diet|plan)|for my goal)\b/i.test(message || "");

      const todayStartPhoto = sastDayStart();
      const photoCountResult = await db.select({ count: sql`count(*)` })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), gte(chatHistory.createdAt, todayStartPhoto), eq(chatHistory.intent, "FOOD_LOG"), eq(chatHistory.messageIn, "[Photo]")));
      const photoCountToday = parseInt(String(photoCountResult[0]?.count || 0));
      if (photoCountToday >= 6) {
        return `6 food photos logged today — I have a clear picture of how you're eating. Keep it consistent and send me tomorrow's first meal.`;
      }

      const { calorieTarget: liveCal, proteinTarget: liveProt } = calculateTargets(
        parseFloat(user.currentWeight || "75"), goal, user.lifeSituation || "office", user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, user.heightCm || 170, user.trainingExperience || "beginner"
      );
      const foodVisionDecision = selectVisionModel("food_photo", isCoach ? "active" : user.subscriptionStatus);
      if (!foodVisionDecision.allowed) {
        return `${clientName}, your subscription is not currently active. Reactivate at kamlife.co.za to get your meals analysed — or type what you ate and I'll give you an estimate: e.g. "pap, chicken, spinach".`;
      }
      console.log(`[VISION][${mediaTrace}] food model=${foodVisionDecision.model} tier=${user.subscriptionStatus}`);
      const foodVisionStart = Date.now();
      const visionResponse = await withTimeout("food_vision", 22000, () => openai.chat.completions.create({
        model: foodVisionDecision.model,
        max_tokens: foodVisionDecision.maxTokens,
        messages: [
          {
            role: "system",
            content: `You are Coach K, a South African fitness and nutrition coach with 20 years experience. Client: ${clientName}. Goal: ${goal}. Daily targets: ${liveCal} kcal and ${liveProt}g protein.

HOW TO REPLY — READ CAREFULLY: The client is LOGGING food they already have. They are NOT asking for advice. Your job is to identify it, give the numbers, and make logging feel easy and judgment-free. You are NOT here to lecture.
- DEFAULT: a short, warm line plus confirmation it is logged. Nothing more.
- SNACKS, TREATS & DRINKS (chips/corn snacks, chocolate, sweets, biscuits, a cooldrink, ice cream, a single bar, a packet of anything): just acknowledge it like a friend would, give the calories, and log it. Do NOT give advice. Do NOT mention protein. Do NOT suggest adding eggs/beans/chicken/anything. Do NOT say what it "lacks" or "has no protein". People are allowed snacks — never make them feel bad for logging one.
- FULL COOKED MEALS: you MAY add ONE short, warm, optional remark, but only if it is genuinely useful — never a command, never "add X", never "low in protein".
- NEVER say a food is "low/no protein", "not enough", or list what it is missing. NEVER tell them to add something to food they already have. NEVER force a call-to-action.
Keep it human and brief — usually one sentence, two at most. SA voice. Never say "Reply MENU". Never say "I hope this helps".${isApprovalCaption ? ` EXCEPTION — THE CLIENT IS ASKING FOR ADVICE (caption shows they want a verdict, e.g. "is this okay?"): give a direct, kind yes/no for their ${goal} goal in one sentence plus one practical tip. This is the one time advice is welcome.` : ""}`,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Analyse this food photo as Coach K.

IDENTIFICATION: Always use SA names — pap not polenta, pilchards not sardines, vetkoek not fried dough, morogo not wild spinach, umngqusho not samp-and-beans, kota not bunny chow, magwinya not fat cake, smileys not sheep head, walkie talkies not chicken feet, mogodu not tripe, chakalaka not relish, boerewors not sausage, biltong not dried meat.

PACKAGED PRODUCTS: If the photo shows a branded food or supplement product (protein shake, protein bar, protein snack, cereal box, tin, can, sachet, supplement tub) — FIRST look for a visible nutritional label and read it directly. If no label is visible, identify the brand and product name if readable. Common SA nutrition brands: USN, Evox, Biogen, Pronutro, Jungle Oats, Bokomo, Parmalat, Spar, Pick n Pay, Woolworths. For protein shakes and powders without a visible label: estimate 30g serving = 22g protein, 130 kcal. For protein snack bars/bites without a label: estimate 40g serving = 10g protein, 170 kcal.

MULTIPLE ITEMS: If the photo shows more than one food item — a meal prep container with separate compartments, a snack next to a main meal, multiple dishes — describe and estimate ALL items visible in the frame, not just one. Combine into a single total. Example: "Meal prep box: chicken + spinach + butternut — roughly 420 kcal and 38g protein total."

ESTIMATION: State specific calories and protein for ALL food and drink items visible in the frame as actually served. If multiple items, list them individually then end with a combined total on its own line in this exact format: "TOTAL: X kcal | Xg protein" — e.g. "TOTAL: 950 kcal | 65g protein". This format is required for accurate logging. Then say how that total compares to their ${liveCal} kcal and ${liveProt}g protein daily target.

COACHING: Mostly say nothing beyond the log. For snacks, treats, drinks, or single packaged items add NO coaching at all — just identify and log. ONLY for a full cooked meal, and ONLY if genuinely useful, you may add one short warm remark about THE SAME FOOD they already have (e.g. "grilled keeps it lean") — never a directive, never "add" a food, never say the meal lacks protein. When unsure, stay silent. Meet the client where they are; never make them feel judged for what they logged.

FOOD CHECK FIRST: Before anything else, verify this image actually shows food or a drink the client is consuming. If the image is clearly NOT food — check these specific cases first:
- If it shows plain water only — a glass of water, a water bottle, a tap running, or a refillable bottle (no branded label, no calories to track) — estimate: (1) the bottle's total capacity in ml by looking for printed size markings or estimating from shape/label (common SA sizes: 500ml, 750ml, 1L, 1.5L, 2L), and (2) approximately what fraction of the bottle has already been consumed based on the current fill level visible. Then respond with EXACTLY: WATER:Xml where X is the millilitres already consumed (capacity × depletion fraction), e.g. a 2L bottle that is 3/4 empty = WATER:1500ml, a 500ml bottle that is half empty = WATER:250ml. If the bottle looks completely full and nothing has been drunk yet, respond WATER:0ml.
- If it shows a handwritten or typed grocery/shopping list, a receipt from a grocery store, or a list of items to BUY (not to eat right now) — respond with EXACTLY: GROCERY_LIST: [list the items you can read, comma-separated, in plain English]
- For all other non-food images (selfie, gym mirror, screenshot of an app, scenery, body progress photo, scale, exercise equipment, pet, person without food, meme, blank/black/blurry, etc.) — respond with EXACTLY: NOT_FOOD${message ? ` — unless the client caption "${message}" clearly says they are reporting food they ate, in which case treat the caption as the food log.` : ""}
- IMPORTANT: A supplement bottle, protein powder tub, protein shake can, protein bar wrapper, or food packaging IS food — do NOT return NOT_FOOD for these. Estimate the nutrition.

BEST GUESS RULE: For images that ARE food, always make your best estimate even if the photo is not perfect. Identify starches by colour AND texture — do NOT default every pale starch to pap: a smooth white or cream mound = pap OR mashed potato (use context); an orange or yellow mound = sweet potato or butternut (NOT pap); loose yellow grains = savoury/yellow rice or corn; large white kernels = samp; plain white grains = rice; a bowl of plain white porridge = oats or pap. Brown liquid in a cup = coffee or tea. Dark stew = beef or chicken stew. If you are 70%+ sure — state your estimate with "roughly" and give the numbers. Only if it IS food but you genuinely cannot tell what kind (completely dark, blurry beyond recognition) — respond only with: Eish, I cannot make out the food clearly. Take the photo in better light and send again.${message && !isApprovalCaption ? `\n\nCLIENT CAPTION: "${message}" — use this as the primary food identification. Even if the photo is unclear, log based on the caption.` : isApprovalCaption ? `\n\nCLIENT IS ASKING: "Is this food okay for my goal?" — identify the food from the photo, estimate calories/protein, give a verdict (yes/no/how much), and log it.` : ""}`,
              },
              { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}`, detail: foodVisionDecision.detail } },
            ],
          },
        ],
      }));
      const foodVisionTokens = visionResponse.usage?.completion_tokens || 0;
      const foodVisionMs = Date.now() - foodVisionStart;
      console.log(`[COST][${mediaTrace}] food_vision ~$${estimateVisionCostUSD(foodVisionDecision, foodVisionTokens).toFixed(5)} ms=${foodVisionMs} (${foodVisionDecision.reason})`);

      const visionReply = visionResponse.choices[0]?.message?.content?.trim();
      // If the photo is unreadable or misclassified but the caption names real food,
      // fall back to logging from the caption. The text pipeline applies its own gates
      // (questions, future-tense, planning) so re-routing here is safe — no double log.
      const captionHasFood = !!(message && message.trim().length > 1 && scanForSAFoods(message).length > 0);
      // If the caption is just a meal label ("lunch") with no recognised food, we can't
      // log from it — but we can ask a targeted question instead of a dead-end "can't read it".
      const mealLabelMatch = message ? message.match(/\b(breakfast|lunch|dinner|supper|snack|brunch)\b/i) : null;
      const mealAsk = mealLabelMatch
        ? `I can't make out the photo clearly — what did you have for ${mealLabelMatch[1].toLowerCase()}? Just type it (e.g. "chicken, rice, veg") and I'll log it.`
        : "Eish, I cannot make out the food clearly. Take the photo in better light and send again — or just type what you ate (e.g. \"pap, chicken, spinach\") and I'll log it.";
      // Sentinel checks must come before the length guard — "NOT_FOOD" is 8 chars and
      // "WATER" is 5 chars, both below the < 10 threshold that catches garbled replies.
      const waterSentinelMatch = (visionReply || "").match(/^WATER:(\d+(?:\.\d+)?)\s*ml\b/i);
      if (waterSentinelMatch || /^WATER$/i.test(visionReply || "")) {
        const ml = waterSentinelMatch ? parseFloat(waterSentinelMatch[1]) : 0;
        console.log(`[FOOD_VISION] water_bottle detected ml=${ml} user=${user.id.slice(-6)}`);
        if (ml >= 50) {
          // Auto-log the estimated consumed amount by reusing the water handler
          const syntheticM = `${Math.round(ml)}ml water`;
          const autoLogged = await handleWater({ phone, message: syntheticM, m: syntheticM, user });
          if (autoLogged) {
            // Prepend a note that this was read from the photo
            return `📸 Read from your photo: ${autoLogged}`;
          }
        }
        // Bottle looks full or estimation failed — prompt for amount
        const waterReply = `That's water 💧 — good. To log today's intake just type: *water 500ml* (or however much you've had).`;
        await logChat(user.id, "[Water photo]", waterReply, "WATER_LOG");
        return waterReply;
      }
      if (!visionReply || visionReply.length < 10) {
        if (captionHasFood) {
          console.log(`[FOOD_VISION] unreadable photo — logging from caption user=${user.id.slice(-6)}`);
          return handleMessage(phone, message);
        }
        return mealAsk;
      }
      if (/^NOT_FOOD\b/i.test(visionReply)) {
        console.log(`[FOOD_VISION] not_food image rejected user=${user.id.slice(-6)}`);
        // Check if this looks like a cooking ingredient/product (spray, oil, sauce, spice, etc.)
        const isIngredient = /\b(spray|oil|sauce|spice|seasoning|sugar|salt|flour|stock|baking|butter|margarine|cook.?n|cook and bake|spray.?n.?cook)\b/i.test(message || "");
        if (isIngredient) {
          return `Got it — that's a cooking ingredient. If you're adding it to a dish, tell me what you made (e.g. "chicken with non-stick spray") and I'll log the full meal.`;
        }
        // Photo isn't food, but the caption names real food — log from the caption.
        if (captionHasFood) {
          console.log(`[FOOD_VISION] not_food photo but caption has food — logging from caption user=${user.id.slice(-6)}`);
          return handleMessage(phone, message);
        }
        // Misclassified gym photo? The first classifier didn't route it to equipment and
        // food vision says it isn't food — try machine coaching before giving up, so a gym
        // machine never dead-ends on "send a photo of your plate".
        if (noCaption) {
          const machineReply = await coachGymMachineFromPhoto(openai, user, base64, contentType);
          if (machineReply) {
            console.log(`[FOOD_VISION] not_food recovered as gym machine user=${user.id.slice(-6)}`);
            await logChat(user.id, "[Equipment Photo]", machineReply, "EQUIPMENT_ID");
            return machineReply;
          }
        }
        return mealLabelMatch ? mealAsk : "That photo doesn't look like food to me. Send a photo of your plate or just type what you ate (e.g. \"pap, chicken, spinach\") and I'll log it.";
      }
      if (/^GROCERY_LIST:/i.test(visionReply)) {
        const itemsRaw = visionReply.replace(/^GROCERY_LIST:\s*/i, "").trim();
        console.log(`[FOOD_VISION] grocery_list photo detected user=${user.id.slice(-6)} items="${itemsRaw.slice(0, 60)}"`);
        const goal = user.goalType || "fat_loss";
        const pTarget = user.proteinTarget || 120;
        const cTarget = user.calorieTarget || 1800;
        const budget = user.weeklyFoodBudget || "100_300";
        const budgetLabel: Record<string, string> = { under_100: "under R100/week", "100_300": "R100–R300/week", "300_600": "R300–R600/week", over_600: "over R600/week" };
        const medicalNotes = [user.medicalConditions, user.otherMedicalNotes].filter(Boolean).join(", ") || "none";
        const listReview = await withTimeout("gpt_grocery_photo", 28000, () => askCoachK(
          `My grocery list: ${itemsRaw}`, user,
          `The client sent a photo of their grocery/shopping list. I read these items: ${itemsRaw}. REBUILD it completely — don't review it.

Client goal: ${goal.replace("_", " ")}
Weekly budget: ${budgetLabel[budget] || "R100–R300/week"}
Daily targets: ${cTarget} kcal, ${pTarget}g protein
Medical/allergies: ${medicalNotes}

RULES: Keep items that fit their goal. Replace what doesn't. Add missing essentials. SA products only with rand prices and weekly quantities. Max 20 items.

FORMAT (start immediately, no intro):
🛒 *Rebuilt list — ${goal.replace("_", " ")} optimised*

*Protein (${pTarget}g/day target):*
• [item] — [quantity] — ~R[price]

*Carbs (slow-release energy):*
• [item] — [quantity] — ~R[price]

*Vegetables:*
• [item] — [quantity] — ~R[price]

*Pantry & basics:*
• [item] — [quantity] — ~R[price]

*Week total: ~R[X]–R[Y]*

${goal === "fat_loss" ? "Fat loss: protein and veg first. Remove sugary drinks, processed snacks, white bread." : "Muscle gain: calorie-dense protein every meal. Extra carb portions."}${medicalNotes !== "none" ? `\nAllergies: ${medicalNotes} — remove ALL.` : ""}`
        )).catch(() => null);
        const reply = listReview || `Got your grocery list (${itemsRaw.slice(0, 80)}${itemsRaw.length > 80 ? "..." : ""}). Type your list as text and I'll rebuild it for your ${goal.replace("_", " ")} goal.`;
        await logChat(user.id, "[Grocery photo]", reply, "SHOPPING_LIST_REBUILD");
        return reply;
      }

      await logChat(user.id, "[Photo]", visionReply, "FOOD_LOG");

      const extractKcal = (text: string) => {
        // Prefer explicit TOTAL: line added by the updated prompt
        const totalFmt = text.match(/TOTAL:\s*(\d[\d,]*)\s*kcal/i);
        if (totalFmt) {
          const n = parseInt(totalFmt[1].replace(/,/g, ""), 10);
          if (Number.isFinite(n) && n >= 50 && n <= 6000) return n;
        }
        // Strip "leaves/remaining X kcal" context to avoid counting daily-remaining figures
        const cleaned = text.replace(/(?:leaves?|leaving|that'?s?\s+\d)|remaining[^.]*?[\d,]+\s*kcal[^.]*/gi, "");
        // Sum all "roughly/about/is X kcal" estimation phrases
        const all = [...cleaned.matchAll(/\b(?:roughly|about|approximately|around|is)\s+(\d[\d,]{1,4})\s*kcal/gi)];
        const vals = all.map(mx => parseInt(mx[1].replace(/,/g, ""), 10)).filter(n => Number.isFinite(n) && n >= 50 && n <= 3000);
        if (vals.length > 0) return vals.reduce((a, b) => a + b, 0);
        // Last resort: first bare kcal number
        const bare = text.match(/\b(\d{2,4})\s*kcal/i);
        if (!bare) return 0;
        const n = parseInt(bare[1], 10);
        return (Number.isFinite(n) && n >= 50 && n <= 3000) ? n : 0;
      };
      const extractProt = (text: string) => {
        // Prefer explicit TOTAL: line
        const totalFmt = text.match(/TOTAL:\s*[\d,]+\s*kcal\s*\|\s*(\d{1,3})\s*g\s*protein/i);
        if (totalFmt) {
          const n = parseInt(totalFmt[1], 10);
          if (Number.isFinite(n) && n >= 0 && n <= 300) return n;
        }
        // Strip "leaves/remaining X g protein" context
        const cleaned = text.replace(/(?:leaves?|leaving|remaining)[^.]*?[\d]+\s*g\s*protein[^.]*/gi, "");
        const all = [...cleaned.matchAll(/\b(\d{1,3})\s*g\s*protein/gi)];
        const vals = all.map(mx => parseInt(mx[1], 10)).filter(n => Number.isFinite(n) && n >= 0 && n <= 200);
        return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : 0;
      };

      let totalPhotoKcal = extractKcal(visionReply);
      let totalPhotoProt = extractProt(visionReply);
      // Strip internal TOTAL: line — used for extraction only, not shown to user
      const visionDisplay = visionReply.replace(/\nTOTAL:[^\n]*/i, "").trim();

      // Safety net: food vision returned NOT_FOOD (pre-classifier missed it or wasn't run).
      // Give a helpful response rather than showing "NOT_FOOD" to the user.
      if (/^NOT_FOOD\b/i.test(visionDisplay)) {
        const notFoodReply = `I can see that's not a food photo. If you're logging a meal, send a photo of the food or just type what you ate — e.g. *chicken and rice*. For steps, send a screenshot of your step count.`;
        await logChat(user.id, "[Photo]", notFoodReply, "UNRECOGNISED_PHOTO");
        return notFoodReply;
      }

      // ── MULTI-PHOTO: process any extra images sent in the same message ──
      const extraImageUrls = (allMediaUrls || []).filter(u => u !== mediaUrl);
      const extraReplies: string[] = [];
      if (extraImageUrls.length > 0) {
        const imgAuthHeaderExtra = "Basic " + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID || ""}:${process.env.TWILIO_AUTH_TOKEN || ""}`).toString("base64");
        for (const extraUrl of extraImageUrls.slice(0, 3)) {
          try {
            const extraResp = await withTimeout("image_download_extra", 10000, () => fetch(extraUrl, { headers: { Authorization: imgAuthHeaderExtra } }));
            if (!extraResp.ok) continue;
            const extraBuf = await extraResp.arrayBuffer();
            if (extraBuf.byteLength > 10 * 1024 * 1024) continue;
            const extraB64 = Buffer.from(extraBuf).toString("base64");
            const extraCtype = extraResp.headers.get("content-type") || "image/jpeg";
            const extraVision = await withTimeout("food_vision_extra", 22000, () => openai.chat.completions.create({
              model: foodVisionDecision.model,
              max_tokens: Math.min(foodVisionDecision.maxTokens, 150),
              messages: [
                { role: "system", content: `List food items visible in this photo, one per line: "Item name: ~X kcal | Yg protein". SA foods welcome (pap, vetkoek, pilchards, etc). End with "TOTAL: X kcal | Yg protein". No advice or coaching sentences. If not food, reply: NOT_FOOD` },
                { role: "user", content: [
                  { type: "text", text: "What food items are here? Numbers only." },
                  { type: "image_url", image_url: { url: `data:${extraCtype};base64,${extraB64}`, detail: "auto" } },
                ]},
              ],
            }));
            const extraText = extraVision.choices[0]?.message?.content?.trim() || "";
            if (/^NOT_FOOD\b/i.test(extraText)) { /* step OCR fallback below */ }
            const extraKcal = extractKcal(extraText);
            const extraProt = extractProt(extraText);
            if (!(/^NOT_FOOD\b/i.test(extraText)) && (extraKcal > 0 || extraProt > 0)) {
              extraReplies.push(extraText.replace(/\nTOTAL:.*$/i, "").trim());
              totalPhotoKcal += extraKcal;
              totalPhotoProt += extraProt;
              await logChat(user.id, "[Photo]", extraText, "FOOD_LOG");
            } else if (/^NOT_FOOD\b/i.test(extraText) || extraText.length > 5) {
              // Food vision found nothing — this extra image might be a step screenshot
              const stepVis = await withTimeout("extra_step_ocr", 10000, () => openai.chat.completions.create({
                model: "gpt-4o-mini", max_tokens: 20,
                messages: [
                  { role: "system", content: "Extract the step count from this fitness app screenshot. Reply with ONLY the number, or NOT_STEPS if no step count is visible." },
                  { role: "user", content: [
                    { type: "text", text: "Step count?" },
                    { type: "image_url", image_url: { url: `data:${extraCtype};base64,${extraB64}`, detail: "low" } },
                  ]},
                ],
              })).catch(() => null);
              const stepTxt = stepVis?.choices[0]?.message?.content?.trim() || "NOT_STEPS";
              if (!/NOT_STEPS|UNKNOWN/i.test(stepTxt)) {
                const extraSteps = parseInt(stepTxt.replace(/[^0-9]/g, ""), 10);
                if (extraSteps >= 500 && extraSteps <= 60000) {
                  const todayStartExtra = sastDayStart();
                  const existingExtraStep = await db.select({ id: stepLogs.id, steps: stepLogs.steps }).from(stepLogs)
                    .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStartExtra))).limit(1);
                  if (existingExtraStep.length > 0) {
                    if (extraSteps > (existingExtraStep[0].steps ?? 0)) {
                      await db.update(stepLogs).set({ steps: extraSteps }).where(eq(stepLogs.id, existingExtraStep[0].id));
                    }
                  } else {
                    await db.insert(stepLogs).values({ userId: user.id, steps: extraSteps });
                  }
                  const stepTarget = user.stepsTarget || 10000;
                  const stepStreak = await getStepStreak(user.id);
                  extraReplies.push(getStepResponse(extraSteps, stepTarget, parseFloat(user.currentWeight as string || "75") || 75, stepStreak, undefined, user));
                  await logChat(user.id, `[Step Screenshot: ${extraSteps}]`, `Steps logged: ${extraSteps}`, "STEP_LOG");
                }
              }
            }
          } catch (e) { console.warn("[multi-photo extra vision]", e); }
        }
      }

      const photoLoggedAt = parseMealDate(message || "");
      const photoIsRetro = isRetroactiveMeal(message || "");
      if (totalPhotoKcal > 0 || totalPhotoProt > 0) {
        // NO nutrition-based dedup here. Two genuinely different meals routinely land on
        // the same calorie estimate (a breakfast bun and a tuna salad are both ~350 kcal),
        // and clients send several meal photos back-to-back — so matching on kcal silently
        // dropped real meals. True duplicate DELIVERIES (Twilio webhook retries, rapid
        // same-sender bursts, and album webhooks) are already dropped upstream in
        // routes/whatsapp.ts by URL / MessageSid / phone dedup. Any photo that reaches here
        // is a distinct meal and must be logged.
        await db.insert(mealLogs).values({
          userId: user.id,
          rawMessage: message || "[Photo]",
          source: "photo",
          kcalInt: totalPhotoKcal,
          proteinInt: totalPhotoProt,
          carbsInt: 0,
          fatInt: 0,
          loggedAt: photoLoggedAt,
        }).catch(e => console.warn("[photo mealLogs write]", e));
        invalidateFoodTotalsCache(user.id);
      }

      const [photoPattern, photoDay] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id, user.proteinTarget || 120)]);
      let photoDailyTotal = "";
      try {
        const totals = await recomputeTodayFoodTotals(user.id);
        const calTarget = user.calorieTarget || 1800;
        const protTarget = user.proteinTarget || 120;
        if (totals.calories > 0) {
          const remaining = calTarget - totals.calories;
          photoDailyTotal = `\n\n_Today so far: ~${totals.calories} kcal | ${totals.protein}g protein. Target: ${calTarget} kcal | ${protTarget}g protein.${remaining > 100 ? ` ${remaining} kcal remaining.` : " On target ✅"}_`;
        }
        await db.update(users).set({
          todayCalories: totals.calories,
          todayProteinG: totals.protein,
          todayCaloriesDate: sastToday(),
        }).where(eq(users.id, user.id)).catch(e => console.warn("[photo todayCalories sync]", e));
      } catch (e) { console.warn("[non-fatal]", e); }

      // Format extra-photo replies compactly. Step responses are already well-formatted
      // paragraphs; food lines are compact "Item: ~X kcal | Yg protein" from the new prompt.
      const extraSection = extraReplies.length > 0
        ? "\n" + extraReplies.map(r => r.startsWith("📸") || /\d+,?\d* steps/i.test(r) ? `\n${r}` : `• ${r}`).join("\n")
        : "";
      const totalSentPhotos = 1 + Math.min(extraImageUrls.length, 3);
      const totalLoggedFoodPhotos = extraReplies.filter(r => !/\d+,?\d* steps/i.test(r)).length + 1;
      const logNote = totalLoggedFoodPhotos >= totalSentPhotos ? "all logged" : `${totalLoggedFoodPhotos} of ${totalSentPhotos} logged`;
      const multiPhotoNote = extraReplies.length > 0 ? `\n_${totalSentPhotos} photo${totalSentPhotos !== 1 ? "s" : ""} — ${logNote}. Total: ~${totalPhotoKcal} kcal | ${totalPhotoProt}g protein_` : "";
      const retroNote = photoIsRetro ? `\n_Logged to ${mealDateLabel(photoLoggedAt)}._` : "";

      // Honest coaching nudge for high-cal meals on fat-loss / recomp goals.
      // Fires only when a single meal eats >38% of the daily calorie budget.
      // Muscle-gain clients need the calories — no nudge for them.
      let photoCoachNudge = "";
      if (totalPhotoKcal > 0 && (goal === "fat_loss" || goal === "recomposition")) {
        const calTarget = user.calorieTarget || 1800;
        if (totalPhotoKcal > Math.round(calTarget * 0.38)) {
          photoCoachNudge = `\n\nBig meal — logged, no stress. Keep the next one lighter and you're balanced for the day.`;
        }
      }

      const photoTotalMs = Date.now() - mediaFlowStart;
      console.log(`[MEDIA][${mediaTrace}] photo_ok total_ms=${photoTotalMs} retro=${photoIsRetro}`);
      await logMediaSuccess(user.id, "photo", photoTotalMs);
      return `${visionDisplay}${extraSection}${multiPhotoNote}${retroNote}${photoCoachNudge}${photoPattern ? "\n\n" + photoPattern : ""}${photoDay || ""}${photoDailyTotal}`;
    } catch (err) {
      const photoFailMs = Date.now() - mediaFlowStart;
      console.error(`[MEDIA][${mediaTrace}] vision_error ms=${photoFailMs}:`, err);
      await logMediaFailure(user.id, "vision", err, photoFailMs);
      // Only steer them to "what you ate" if the caption was actually about food. A gym
      // machine or step screenshot that fails here must never get a food error.
      const hadFoodContext = !!(message && message.trim() && scanForSAFoods(message).length > 0);
      return hadFoodContext
        ? "Eish, I cannot read that photo right now. Tell me what you ate in text — 'chicken and sweet potato' — and I will give you the full breakdown."
        : "Eish, I couldn't process that image right now. If it's a meal, type what you ate (e.g. *chicken and rice*). If it's a gym machine, tell me which one — or reply *workout* for today's session. If it's your steps, send a clear screenshot of the step count.";
    }
  }

  // ---- VOICE NOTE ----
  if (ctype.startsWith("audio/")) {
    let voiceStage = "download";
    const voiceFlowStart = Date.now();
    let voiceStageStart = voiceFlowStart;
    let _tmpAudioCleanup: (() => void) | null = null;
    try {
      const twilioSid = process.env.TWILIO_ACCOUNT_SID || "";
      const twilioToken = process.env.TWILIO_AUTH_TOKEN || "";
      const authHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");

      let audioResponse = await withTimeout("audio_download_1", 12000, () => fetch(mediaUrl, { headers: { Authorization: authHeader } }));
      if (!audioResponse.ok) {
        console.warn(`[VOICE][${mediaTrace}] download_attempt_1_failed status=${audioResponse.status} ms=${Date.now()-voiceStageStart}`);
        await new Promise(r => setTimeout(r, 1500));
        audioResponse = await withTimeout("audio_download_2", 12000, () => fetch(mediaUrl, { headers: { Authorization: authHeader } }));
      }
      if (!audioResponse.ok) {
        const dlMs = Date.now() - voiceStageStart;
        console.error(`[VOICE][${mediaTrace}] download_failed_after_retry status=${audioResponse.status} ms=${dlMs}`);
        await logMediaFailure(user.id, "audio_download", `${audioResponse.status}`, dlMs);
        return "I got your voice note but the audio did not download properly. Please send it again, or type your message and I will respond immediately.";
      }

      const audioLen = parseInt(audioResponse.headers.get("content-length") || "0", 10);
      if (audioLen > 16 * 1024 * 1024) {
        console.warn(`[MEDIA][${mediaTrace}] audio_too_large content_length=${audioLen}`);
        return "That voice note is too large to process reliably. Keep it under about 90 seconds and resend.";
      }
      const audioBuffer = await audioResponse.arrayBuffer();
      if (audioBuffer.byteLength > 16 * 1024 * 1024) {
        console.warn(`[MEDIA][${mediaTrace}] audio_buffer_too_large bytes=${audioBuffer.byteLength}`);
        return "That voice note is too large to process reliably. Keep it under about 90 seconds and resend.";
      }

      const sourceAudioType = (audioResponse.headers.get("content-type") || ctype || "audio/ogg").split(";")[0].trim().toLowerCase();
      const extMap: Record<string, string> = {
        "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3",
        "audio/mp4": "mp4", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav",
        "audio/webm": "webm", "audio/amr": "amr",
      };
      const audioExt = extMap[sourceAudioType] || "ogg";

      const audioDownloadMs = Date.now() - voiceStageStart;
      console.log(`[VOICE][${mediaTrace}] download_ok bytes=${audioBuffer.byteLength} type=${sourceAudioType} ext=${audioExt} ms=${audioDownloadMs}`);
      if (audioBuffer.byteLength < 2000) {
        console.warn(`[VOICE][${mediaTrace}] audio_too_short bytes=${audioBuffer.byteLength} — rejecting`);
        return "That voice note was too short to transcribe — hold the mic button for at least 3 seconds and resend, or just type your message.";
      }

      voiceStage = "transcribe";
      voiceStageStart = Date.now();

      const tmpAudioPath = pathJoin(tmpdir(), `voice_${crypto.randomUUID()}.${audioExt}`);
      await writeFile(tmpAudioPath, Buffer.from(audioBuffer));
      const cleanupTmp = () => unlink(tmpAudioPath).catch(() => {});
      _tmpAudioCleanup = cleanupTmp;

      const storedLangPref = (user.profileNotes || "").match(/lang:([a-z]{2})/)?.[1];
      const whisperLangMap: Record<string, string> = { zu: "zu", xh: "xh", st: "st", tn: "tn", ts: "ts", af: "af", en: "en" };
      const whisperLang = storedLangPref && whisperLangMap[storedLangPref] ? whisperLangMap[storedLangPref] : undefined;
      const whisperPrompt = "South African fitness coaching. Client may speak English, Zulu, Xhosa, Afrikaans, or switch between them. Fitness terms: reps, sets, protein, calories, steps, workout, gym, pap, pilchards.";

      let transcribedText: string | undefined;
      // Confidence signal only available from Whisper verbose_json path.
      let voiceQuality: { avgLogprob: number; comp: number } | null = null;

      // ElevenLabs Scribe: better WER than Whisper on SA languages (Afrikaans, Zulu, Xhosa).
      // Try it first when configured; fall through to Whisper on any failure.
      if (process.env.ELEVENLABS_API_KEY) {
        try {
          const scribeText = await withTimeout("scribe_transcribe", 20000, () =>
            scribeTranscribe(audioBuffer, audioExt, storedLangPref || undefined)
          );
          if (scribeText) {
            transcribedText = scribeText;
            console.log(`[VOICE] scribe_ok text="${scribeText.slice(0, 80)}" len=${scribeText.length}`);
          }
        } catch (scribeErr: any) {
          console.warn(`[VOICE] scribe_failed: ${scribeErr?.message || scribeErr}`);
        }
      }

      // Whisper fallback (3 attempts with quality signals)
      if (!transcribedText) {
        let transcription: { text?: string } = { text: "" };
        // Confidence signal from attempt 1 (verbose_json). Whisper "hallucinates"
        // English-sounding words when handed a language it can't handle (most SA
        // languages beyond EN/AF/ZU). avg_logprob and compression_ratio are the
        // standard signals for catching that garble — see the guard further down.
        console.log(`[VOICE] whisper_attempt_1 bytes=${audioBuffer.byteLength} ext=${audioExt} lang=${whisperLang || "auto"}`);
        try {
          const v: any = await withTimeout("voice_transcribe", 25000, () => openai.audio.transcriptions.create({
            file: createReadStream(tmpAudioPath),
            model: "whisper-1",
            prompt: whisperPrompt,
            response_format: "verbose_json",
            ...(whisperLang ? { language: whisperLang } : {}),
          }));
          transcription = { text: v?.text || "" };
          const segs: any[] = Array.isArray(v?.segments) ? v.segments : [];
          if (segs.length) {
            const avgLogprob = segs.reduce((s, x) => s + (x.avg_logprob ?? 0), 0) / segs.length;
            const comp = Math.max(...segs.map((x) => x.compression_ratio ?? 0));
            voiceQuality = { avgLogprob, comp };
          }
          console.log(`[VOICE] whisper_attempt_1_result text="${(transcription.text || "").slice(0, 80)}" len=${transcription.text?.length ?? 0} avgLogprob=${voiceQuality?.avgLogprob?.toFixed(2) ?? "n/a"} comp=${voiceQuality?.comp?.toFixed(2) ?? "n/a"}`);
        } catch (transErr: any) {
          console.warn(`[VOICE] whisper_attempt_1_failed lang=${whisperLang || "auto"} error=${transErr?.message || transErr}`);
          try {
            transcription = await withTimeout("voice_transcribe_retry", 25000, () => openai.audio.transcriptions.create({
              file: createReadStream(tmpAudioPath),
              model: "whisper-1",
              prompt: whisperPrompt,
            }));
            console.log(`[VOICE] whisper_attempt_2_result text="${(transcription.text || "").slice(0, 80)}" len=${transcription.text?.length ?? 0}`);
          } catch (retryErr: any) {
            console.warn(`[VOICE] whisper_attempt_2_failed error=${retryErr?.message || retryErr}`);
            transcription = { text: "" };
          }
        }

        transcribedText = transcription.text?.trim();
        if (!transcribedText) {
          console.log(`[VOICE] whisper_attempt_3_en bytes=${audioBuffer.byteLength}`);
          try {
            const retryTranscription = await withTimeout("voice_transcribe_en_retry", 20000, () =>
              openai.audio.transcriptions.create({
                file: createReadStream(tmpAudioPath),
                model: "whisper-1",
                language: "en",
                prompt: whisperPrompt,
              })
            );
            transcribedText = retryTranscription.text?.trim() || "";
            console.log(`[VOICE] whisper_attempt_3_result text="${transcribedText.slice(0, 80)}" len=${transcribedText.length}`);
          } catch (retryErr: any) {
            console.warn(`[VOICE] whisper_attempt_3_failed error=${retryErr?.message || retryErr}`);
          }
        }
      }

      if (!transcribedText) {
        const failCount = bumpVoiceFailure(user.id);
        if (failCount >= 3) {
          clearVoiceFailure(user.id);
          return "I keep struggling to pick up your voice notes — this is on my side. Please type your message and I'll get you a detailed reply straight away.";
        }
        const noteLen = audioBuffer.byteLength;
        const likelySilent = noteLen < 12_000;
        return likelySilent
          ? "I got your voice note but couldn't make it out — might have been too quiet or too short. Hold the mic close and speak clearly, or just type your message."
          : "I got your voice note but had trouble processing it right now. Please resend it, or type your message and I'll reply straight away.";
      }

      const wordCount = transcribedText.split(/\s+/).filter(Boolean).length;
      if (wordCount < 2) {
        // Known single-word commands pass through directly — asking to resend wastes a round trip.
        const cleanWord = transcribedText.toLowerCase().replace(/[.!?,\s]+$/, "");
        const KNOWN_COMMANDS = new Set([
          "workout", "done", "hi", "hello", "hey", "steps", "water", "progress",
          "sleep", "weight", "supplements", "supps", "vitamins", "menu", "help",
          "log", "stats", "badges", "referral", "shopping", "groceries", "portions",
          "reset", "pause", "resume", "yes", "no", "ok", "okay", "food", "macros",
          "calories", "protein", "cardio", "gym", "home", "mkhaba", "continue",
          "cancel", "unsubscribe", "monthly", "weekly", "today", "tomorrow",
        ]);
        if (!KNOWN_COMMANDS.has(cleanWord)) {
          const failCount = bumpVoiceFailure(user.id);
          if (failCount >= 3) {
            clearVoiceFailure(user.id);
            return `I keep only picking up a single word — "${transcribedText}". Please type your message — I'll reply properly.`;
          }
          return `I only caught one word — "${transcribedText}". Send again or type your message.`;
        }
        clearVoiceFailure(user.id);
      }

      // Low-confidence (garble) guard — when Whisper invents English-sounding words
      // from a language it can't handle, a very negative avg_logprob or a high
      // compression ratio gives it away. Don't coach on nonsense — ask the client to
      // type instead (GPT reads typed SA languages well). Soft fail (recoverable);
      // thresholds are conservative to avoid rejecting genuine accented English, and
      // the metrics are logged above so they can be tuned against real notes.
      if (voiceQuality && wordCount >= 2 && (voiceQuality.avgLogprob < -1.0 || voiceQuality.comp > 2.5)) {
        console.log(`[VOICE] low_confidence_garble avgLogprob=${voiceQuality.avgLogprob.toFixed(2)} comp=${voiceQuality.comp.toFixed(2)} text="${transcribedText.slice(0, 80)}"`);
        const garbleCount = bumpVoiceFailure(user.id);
        if (garbleCount >= 2) {
          clearVoiceFailure(user.id);
          return "I'm struggling to make out your voice notes clearly — that's a limit on voice, not you. I understand *typed* messages in any South African language, so please type what you need and I'll help you properly. 🙏";
        }
        return "I caught some of that, but not clearly enough to be sure I understood you right. Could you type it instead? I read English, Zulu, Xhosa, Sotho, Tswana, Tsonga and Afrikaans text well. 🙏";
      }
      clearVoiceFailure(user.id);

      const ZULU_WORDS = ["sawubona", "yebo", "ngiyabonga", "unjani", "siyabonga", "hawu", "eish", "askies", "ngicela", "ngifuna"];
      const SOTHO_WORDS = ["dumela", "ke a leboga", "o kae", "kea leboha", "ntate", "mme", "ke kopa", "ke batla"];
      const XHOSA_WORDS = ["molo", "enkosi", "unjani", "ewe", "hayi", "camagu", "ndiyabona", "ndicela", "ndifuna"];
      const TSWANA_WORDS = ["go siame", "ke a leboga", "rra", "lo kae", "ke tsile", "ke kopa", "thobela", "pula"];
      const TSONGA_WORDS = ["avuxeni", "nkhensa", "ndza khensa", "hi kona", "ndzi lava", "ndzi kopa", "swinene"];
      const AFRIKAANS_WORDS = ["dankie", "asseblief", "môre", "more", "lekker", "baie", "nee", "ja nee", "ag nee", "eina", "ek is", "ek het"];
      const lowerTranscribed = transcribedText.toLowerCase();
      let languageNote = "";
      if (ZULU_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Zulu. Respond in simple SA English but acknowledge their language naturally — you may use a word or two of Zulu.";
      else if (SOTHO_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Sesotho. Respond in simple SA English but acknowledge their language naturally.";
      else if (XHOSA_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Xhosa. Respond in simple SA English but acknowledge their language naturally.";
      else if (TSWANA_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Setswana. Respond in simple SA English but acknowledge their language naturally.";
      else if (TSONGA_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Xitsonga. Respond in simple SA English but acknowledge their language naturally.";
      else if (AFRIKAANS_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Afrikaans. Respond in simple SA English but acknowledge their language naturally — you may use a word or two of Afrikaans.";

      const transcribeMs = Date.now() - voiceStageStart;
      console.log(`[MEDIA][${mediaTrace}] transcribe_ok words=${wordCount} ms=${transcribeMs} lang=${whisperLang || "auto"}${languageNote ? " detected=" + languageNote.split(" ")[4] : ""}`);

      voiceStage = "coach_reply";
      voiceStageStart = Date.now();
      const voiceReply = await withTimeout("voice_coach_reply", 20000, () =>
        handleMessage(phone, transcribedText + (languageNote ? `\n\n[LANGUAGE NOTE: ${languageNote}]` : ""))
      );
      const coachReplyMs = Date.now() - voiceStageStart;
      const voiceTotalMs = Date.now() - voiceFlowStart;
      console.log(`[MEDIA][${mediaTrace}] voice_ok words=${wordCount} coach_reply_ms=${coachReplyMs} total_ms=${voiceTotalMs}`);
      await logMediaSuccess(user.id, "voice", voiceTotalMs);
      await cleanupTmp();
      return `🎤 I heard: "${transcribedText}"\n\n${voiceReply}`;

    } catch (err) {
      if (_tmpAudioCleanup) _tmpAudioCleanup();
      const stageMs = Date.now() - voiceStageStart;
      console.error(`[VOICE][${mediaTrace}] error stage=${voiceStage} ms=${stageMs}:`, err);
      await logMediaFailure(user.id, `voice_${voiceStage}`, err, stageMs);
      if (voiceStage === "transcribe") {
        const failCount = bumpVoiceFailure(user.id);
        if (failCount >= 3) {
          clearVoiceFailure(user.id);
          return "I am having trouble transcribing your voice notes — this is on my side. Please type your message and I will reply straight away.";
        }
        return "I received your voice note but could not transcribe it clearly. Try again in a quieter spot, or type your message.";
      }
      if (voiceStage === "coach_reply") {
        return "I heard your voice note but could not generate the coaching reply right now. Send it once more, or type your message.";
      }
      return "I got your voice note but could not process it right now. Please send it again, or type your message and I will respond immediately.";
    }
  }

  // ---- VIDEO (form check OR workout save from TikTok/IG) ----
  if (ctype.startsWith("video/")) {
    const isFormCheck = /\b(form|check|correct|right|wrong|how does|how do i look|am i doing|check my|my form|form check|squat form|deadlift form|bench form|my squat|my deadlift|my bench|watch this|look at this)\b/i.test(message);

    // Workout save — user forwarded a TikTok or Instagram workout video
    const isWorkoutSave = !isFormCheck && /\b(this workout|try this|these exercises|what exercises|what are these|save this|what is this|add this|do this|can i do this|is this good|found this|check this out|these moves|new workout|workout i saw|is this a good workout)\b/i.test(message || "")
      || (!isFormCheck && message && /\b(workout|routine|circuit|hiit|leg day|push day|pull day|glute|cardio|abs|core)\b/i.test(message));
    if (isWorkoutSave || (!isFormCheck && !message?.trim())) {
      const fallbackMsg = `I couldn't pick out the exercises from that video clearly. Two easy ways:\n\n1. Take *one screenshot* that shows the moves (most workout videos list them on screen) and send it\n2. Or just type or voice-note the exercises — e.g. *"hip thrusts, RDLs, leg curls"*\n\nEither way I'll break them down and can slot them into your plan.`;
      // Download → frame-extract → identify, all async, so the webhook replies fast.
      // The breakdown lands as a follow-up WhatsApp message (same pattern as photo comparison).
      (async () => {
        try {
          const sid = process.env.TWILIO_ACCOUNT_SID || "";
          const token = process.env.TWILIO_AUTH_TOKEN || "";
          const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
          const vr = await fetch(mediaUrl, { headers: { Authorization: auth } });
          if (!vr.ok) { await sendWhatsApp(phone, fallbackMsg); return; }
          const vlen = parseInt(vr.headers.get("content-length") || "0", 10);
          if (vlen > 20 * 1024 * 1024) {
            await sendWhatsApp(phone, `That clip's a bit large for me to process. Take *one screenshot* showing the moves and send it, or just type the exercises — I'll break them down.`);
            return;
          }
          const vbuf = await vr.arrayBuffer();
          const vct = (vr.headers.get("content-type") || ctype || "video/mp4").split(";")[0].trim();
          const vext = (vct.split("/")[1] || "mp4").replace("quicktime", "mov");
          const frames = await extractVideoFrames(vbuf, vext, 8);
          if (frames.length === 0) { await sendWhatsApp(phone, fallbackMsg); return; }
          const parsed = await identifyExercisesFromImages(
            openai, frames.map(b => ({ b64: b, ct: "image/jpeg" })), "gpt-4o",
          ).catch((e) => { console.warn("[WORKOUT_VIDEO] identify", e); return null; });
          const breakdown = formatWorkoutBreakdown(parsed);
          if (!breakdown) { await sendWhatsApp(phone, fallbackMsg); return; }
          await logChat(user.id, "[Workout Video]", breakdown, "WORKOUT_VIDEO");
          await sendWhatsApp(phone, breakdown);
        } catch (e) {
          console.error(`[WORKOUT_VIDEO] error:`, e);
          await sendWhatsApp(phone, fallbackMsg);
        }
      })();
      const ack = `Got the workout video 💪 Give me a few seconds — I'm breaking down every exercise in it...`;
      await logChat(user.id, "[Workout Video]", ack, "WORKOUT_VIDEO_ACK");
      return ack;
    }

    const exerciseHint = /\b(squat|deadlift|rdl|bench|row|press|curl|hip thrust|lunge|pull.?up)\b/i.exec(message);
    const exerciseName = exerciseHint ? exerciseHint[1] : null;
    const clientNameVid = user.name || "there";
    const formCheckKeyPoints: Record<string, string> = {
      squat: "bottom position (thighs parallel or below)",
      deadlift: "mid-shin position as the bar passes your knee",
      rdl: "bottom of the hinge where you feel the hamstring stretch",
      bench: "bar at the chest — lowest point of the press",
      "hip thrust": "top of the movement — full hip extension",
      row: "peak contraction — elbow fully back",
      press: "starting position — bar or dumbbell at shoulder height",
      curl: "peak contraction — arm fully shortened",
      lunge: "bottom of the lunge — back knee near the floor",
      "pull-up": "chin at bar level",
    };
    const keyPoint = exerciseName ? formCheckKeyPoints[exerciseName.toLowerCase()] : null;
    const specificAsk = keyPoint
      ? `For the *${exerciseName}*, send me a clear photo of the *${keyPoint}*. That is the moment I need to see to give you accurate feedback.`
      : `Send me a clear still photo at the most important moment of the movement — usually the bottom of a squat or deadlift, or the peak contraction for upper body. Good lighting, full body in frame.`;
    const videoReply = `Got the video${clientNameVid !== "there" ? `, ${clientNameVid}` : ""}. I cannot analyse video directly — WhatsApp compresses it too much for accurate form coaching.\n\n${specificAsk}\n\nOnce I see the photo I will tell you exactly what to fix.`;
    await logChat(user.id, "[Video]", videoReply, "FORM_CHECK");
    return videoReply;
  }

  console.log(`[MEDIA] Unhandled content type: ${ctype} — ignoring`);
  return "I received your file but I can only process voice notes and food photos. Send those or type your message.";
}
