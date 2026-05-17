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
import { db } from "../db";
import {
  users, chatHistory, stepLogs, mealLogs, progressPhotos,
} from "../../shared/schema";
import { eq, and, gte, asc, sql } from "drizzle-orm";
import {
  buildMediaTrace, withTimeout,
  logMediaFailure, logMediaSuccess, logChat,
} from "./chat-log";
import { getStepResponse, getStepStreak } from "./steps";
import { checkPerfectDay, checkFoodPatterns } from "./checks";
import { recomputeTodayFoodTotals } from "./food-scanner";
import { selectVisionModel, estimateVisionCostUSD } from "../gpt";
import { calculateTargets } from "../targets";
import { sastDayStart } from "../utils";

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

      // ---- UNCAPTIONED IMAGE PRE-CLASSIFIER ----
      let uncaptionedType: "food" | "steps" | "exercise" | "progress" | "other" | null = null;
      if (noCaption && !isStepScreenshot) {
        try {
          const classifyResp = await withTimeout("image_classify", 8000, () => openai.chat.completions.create({
            model: "gpt-4o-mini",
            max_tokens: 8,
            temperature: 0,
            messages: [
              { role: "system", content: "Classify a WhatsApp photo sent to a fitness coach. Reply with ONE word only, lowercase: food | steps | exercise | progress | other.\n- food: plate of food, drink, snack, meal\n- steps: screenshot showing a step count or pedometer reading\n- exercise: person actively performing an exercise movement (mid-squat, lifting, running)\n- progress: person standing/posing still to show body shape — front, side or back pose, even if wearing gym clothes. Before/after transformation photos. Multiple people posing.\n- other: none of the above\nIMPORTANT: If a person is POSING or STANDING STILL (not mid-movement), classify as progress, not exercise." },
              { role: "user", content: [
                { type: "text", text: "What is this photo?" },
                { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } },
              ] },
            ],
          }));
          const raw = (classifyResp.choices[0]?.message?.content || "").trim().toLowerCase();
          if (raw.includes("food")) uncaptionedType = "food";
          else if (raw.includes("steps") || raw.includes("step")) uncaptionedType = "steps";
          else if (raw.includes("exercise")) uncaptionedType = "exercise";
          else if (raw.includes("progress")) uncaptionedType = "progress";
          else uncaptionedType = "other";
          console.log(`[MEDIA][${mediaTrace}] uncaptioned_classified=${uncaptionedType}`);
          if (uncaptionedType === "steps") isStepScreenshot = true;
          if (uncaptionedType === "exercise") {
            const exReply = `${user.name || "Sharp"} — I can see that's a gym / exercise photo, but I cannot give form feedback from a still shot taken mid-set.\n\nFor form coaching: send a clear photo from the side showing the bottom of the movement (e.g. deepest point of squat, bar touching chest on bench). Or tell me the exercise and what feels off.\n\nIf you were trying to log a workout, reply *done* — I will log today's session.`;
            await logChat(user.id, "[Exercise Photo]", exReply, "EXERCISE_PHOTO");
            return exReply;
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
          const looksLikeStepCount = extractedSteps >= 500 && extractedSteps <= 60000;
          const acceptableLowCount = explicitStepIntent && extractedSteps >= 100 && extractedSteps < 500;
          if (!visionRejected && !isNaN(extractedSteps) && (looksLikeStepCount || acceptableLowCount)) {
            const target = user.stepsTarget || 10000;
            const todayStartSteps = sastDayStart();
            const existingStep = await db.select({ id: stepLogs.id })
              .from(stepLogs)
              .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStartSteps)))
              .limit(1);
            if (existingStep.length > 0) {
              await db.update(stepLogs).set({ steps: extractedSteps }).where(eq(stepLogs.id, existingStep[0].id));
            } else {
              await db.insert(stepLogs).values({ userId: user.id, steps: extractedSteps });
            }
            await db.update(users).set({ lastActiveAt: new Date(), awaitingInputType: null }).where(eq(users.phoneNumber, phone));
            const [perfectDay, streak] = await Promise.all([checkPerfectDay(user.id, user.proteinTarget || 130), getStepStreak(user.id)]);
            const stepReply = getStepResponse(extractedSteps, target, parseFloat(user.currentWeight as string || "75") || 75, streak);
            await logChat(user.id, `[Step Screenshot: ${extractedSteps}]`, stepReply, "STEP_LOG");
            console.log(`[MEDIA][${mediaTrace}] step_logged value=${extractedSteps}`);
            return stepReply + (perfectDay || "");
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

        if (existingPhotos.length >= 1) {
          const firstPhoto = existingPhotos[0];
          const prevPhoto = existingPhotos[existingPhotos.length - 1]; // most recent before this one
          const daysSinceStart = Math.round((Date.now() - new Date(firstPhoto.loggedAt || "").getTime()) / 86_400_000);
          const daysSincePrev = Math.round((Date.now() - new Date(prevPhoto.loggedAt || "").getTime()) / 86_400_000);
          const progressDecision = selectVisionModel("progress_compare", isCoach ? "active" : user.subscriptionStatus);
          console.log(`[VISION][${mediaTrace}] progress model=${progressDecision.model} tier=${user.subscriptionStatus} photos=${photoNumber}`);

          const isThirdPlusPhoto = existingPhotos.length >= 2;
          const imageContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: string } }> = [];

          if (isThirdPlusPhoto) {
            const weeksStart = Math.round(daysSinceStart / 7);
            const weeksPrev = Math.round(daysSincePrev / 7);
            imageContent.push({
              type: "text",
              text: `You have three photos to compare. Photo A is the original baseline (${weeksStart} weeks ago). Photo B is the most recent check-in (${weeksPrev} days ago). Photo C is today's check-in (Photo ${photoNumber}).\n\nStructure your response:\n1. *Since the beginning:* What has changed from Photo A to Photo C in body composition, posture, waist/hip shape, muscle definition?\n2. *Since last check-in:* What is visibly different between Photo B and Photo C? Even small changes.\n3. One specific coaching cue for the next 30 days based on what you see.\n\nBe direct and specific. If you cannot see a change — say why (lighting, angle, clothing) and what would help. SA voice, max 150 words total.`,
            });
            imageContent.push({ type: "image_url", image_url: { url: `data:${firstPhoto.contentType};base64,${firstPhoto.photoBase64}`, detail: progressDecision.detail } });
            imageContent.push({ type: "image_url", image_url: { url: `data:${prevPhoto.contentType};base64,${prevPhoto.photoBase64}`, detail: progressDecision.detail } });
            imageContent.push({ type: "image_url", image_url: { url: `data:${contentType};base64,${base64}`, detail: progressDecision.detail } });
          } else {
            imageContent.push({
              type: "text",
              text: `Compare these two progress photos. Photo 1 was taken ${daysSinceStart} days ago (${Math.round(daysSinceStart / 7)} weeks). Photo 2 is today. Describe specifically what has changed in the body. Focus on: body composition, posture, visible muscle, waist and hip shape. Be honest — if nothing has changed say so and say why (lighting, angle, clothing). If it has — describe exactly what you see. End with one specific coaching cue for the next 30 days. SA voice, max 120 words.`,
            });
            imageContent.push({ type: "image_url", image_url: { url: `data:${firstPhoto.contentType};base64,${firstPhoto.photoBase64}`, detail: progressDecision.detail } });
            imageContent.push({ type: "image_url", image_url: { url: `data:${contentType};base64,${base64}`, detail: progressDecision.detail } });
          }

          const comparisonResponse = await openai.chat.completions.create({
            model: progressDecision.model,
            max_tokens: progressDecision.maxTokens,
            messages: [
              {
                role: "system",
                content: `You are Coach K, a South African fitness and nutrition coach with 20 years experience. The client's name is ${clientName}. Their goal is ${goal}. Direct, warm, specific — SA voice. Focus on visible physical changes only. Never discuss weight unless you can see a scale. Never say "great progress" as a standalone — describe what you actually see.`,
              },
              { role: "user", content: imageContent },
            ],
          });
          const progressTokens = comparisonResponse.usage?.completion_tokens || 0;
          console.log(`[COST][${mediaTrace}] progress_compare ~$${estimateVisionCostUSD(progressDecision, progressTokens).toFixed(5)} (${progressDecision.reason})`);
          const comparisonText = comparisonResponse.choices[0]?.message?.content?.trim()
            || "I can see the photos but could not compare them clearly. Send in good lighting, same pose if possible.";
          await logChat(user.id, `[Progress Photo ${photoNumber}]`, comparisonText, "PROGRESS_COMPARISON");
          const weeksLabel = Math.round(daysSinceStart / 7);
          const weekStr = weeksLabel === 1 ? "1 week" : `${weeksLabel} weeks`;
          return `Photo ${photoNumber} — ${weekStr} of work.\n\n${comparisonText}\n\n_Next check-in: 30 days. Keep the same pose and lighting — it makes the comparison sharper._`;
        } else {
          return `Saved, ${clientName}. That is your baseline — the before. The photo you will look back at in 8 weeks and not believe.\n\nSend your next one in 30 days. I will compare them side by side and tell you exactly what changed — muscle, posture, body shape. Everything. Keep showing up.`;
        }
      }

      // ---- FOOD PHOTO ----
      const todayStartPhoto = sastDayStart();
      const photoCountResult = await db.select({ count: sql`count(*)` })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), gte(chatHistory.createdAt, todayStartPhoto), eq(chatHistory.intent, "FOOD_LOG"), eq(chatHistory.messageIn, "[Photo]")));
      const photoCountToday = parseInt(String(photoCountResult[0]?.count || 0));
      if (photoCountToday >= 3) {
        return `3 food photos logged today — I have a clear picture of how you're eating. Keep it consistent and send me tomorrow's first meal.`;
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
            content: `You are Coach K, a South African fitness and nutrition coach with 20 years experience. Client: ${clientName}. Goal: ${goal}. Daily targets: ${liveCal} kcal and ${liveProt}g protein. SA voice — direct, warm, specific. Never generic. Max 3 sentences. End with exactly one specific action. Never say "Reply MENU". Never say "I hope this helps".`,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Analyse this food photo as Coach K.

IDENTIFICATION: Always use SA names — pap not polenta, pilchards not sardines, vetkoek not fried dough, morogo not wild spinach, umngqusho not samp-and-beans, kota not bunny chow, magwinya not fat cake, smileys not sheep head, walkie talkies not chicken feet, mogodu not tripe, chakalaka not relish, boerewors not sausage, biltong not dried meat.

ESTIMATION: State specific calories and protein for the FULL plate as actually served. Format: "That plate is roughly 650 kcal and 35g protein." Then immediately say how that leaves them against their ${liveCal} kcal and ${liveProt}g protein daily target. Example: "That leaves 1,150 kcal and 85g protein for the rest of the day."

COACHING: One sentence on whether this meal works for their ${goal} goal. If good — say exactly why. If not — suggest a better way to prepare THE SAME FOOD they are already eating (e.g. grilled instead of fried, less oil, bigger portion of protein). NEVER suggest a completely different cheaper food — if they are eating fish, coach them on fish. If they are eating steak, coach them on steak. If they are eating sushi, coach them on sushi. Meet the client where they are.

FOOD CHECK FIRST: Before anything else, verify this image actually shows food or a drink the client is consuming. If the image is clearly NOT food (selfie, gym mirror, screenshot of an app, document, scenery, body progress photo, scale, supplement bottle, exercise equipment, pet, person without food, meme, blank/black/blurry, etc.) — respond with EXACTLY this single line and nothing else: NOT_FOOD${message ? ` — unless the client caption "${message}" clearly says they are reporting food they ate, in which case treat the caption as the food log.` : ""}

BEST GUESS RULE: For images that ARE food, always make your best estimate even if the photo is not perfect. A bowl of white porridge = oats or pap. Brown liquid in a cup = coffee or tea. Dark stew = beef or chicken stew. If you are 70%+ sure — state your estimate with "roughly" and give the numbers. Only if it IS food but you genuinely cannot tell what kind (completely dark, blurry beyond recognition) — respond only with: Eish, I cannot make out the food clearly. Take the photo in better light and send again.${message ? `\n\nCLIENT CAPTION: "${message}" — use this as the primary food identification. Even if the photo is unclear, log based on the caption.` : ""}`,
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
      if (!visionReply || visionReply.length < 10) {
        return "Eish, I cannot make out the food clearly. Take the photo in better light and send again.";
      }
      if (/^NOT_FOOD\b/i.test(visionReply)) {
        console.log(`[FOOD_VISION] not_food image rejected user=${user.id.slice(-6)}`);
        return "That photo doesn't look like food to me. Send a photo of your plate or just type what you ate (e.g. \"pap, chicken, spinach\") and I'll log it.";
      }

      await logChat(user.id, "[Photo]", visionReply, "FOOD_LOG");

      const extractKcal = (text: string) => {
        const mx = text.match(/roughly\s+(\d[\d,]*)\s*kcal/i) || text.match(/\b(\d{2,4})\s*kcal/i);
        if (!mx) return 0;
        const n = parseInt(mx[1].replace(/,/g, ""), 10);
        if (!Number.isFinite(n) || n < 50 || n > 3000) return 0;
        return n;
      };
      const extractProt = (text: string) => {
        const mx = text.match(/\b(\d{1,3})\s*g\s*protein/i);
        if (!mx) return 0;
        const n = parseInt(mx[1], 10);
        if (!Number.isFinite(n) || n < 0 || n > 200) return 0;
        return n;
      };

      let totalPhotoKcal = extractKcal(visionReply);
      let totalPhotoProt = extractProt(visionReply);

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
            const extraVision = await withTimeout("food_vision_extra", 18000, () => openai.chat.completions.create({
              model: foodVisionDecision.model,
              max_tokens: Math.min(foodVisionDecision.maxTokens, 200),
              messages: [
                { role: "system", content: `You are Coach K, a South African fitness coach. Client: ${clientName}. Give calories and protein only for this food photo. Format: "Photo X: [food name] — roughly Y kcal and Zg protein." One sentence max.` },
                { role: "user", content: [
                  { type: "text", text: "Estimate calories and protein in this food photo." },
                  { type: "image_url", image_url: { url: `data:${extraCtype};base64,${extraB64}`, detail: "low" } },
                ]},
              ],
            }));
            const extraText = extraVision.choices[0]?.message?.content?.trim() || "";
            if (extraText && extraText.length > 5) {
              extraReplies.push(extraText);
              totalPhotoKcal += extractKcal(extraText);
              totalPhotoProt += extractProt(extraText);
              await logChat(user.id, "[Photo]", extraText, "FOOD_LOG");
            }
          } catch (e) { console.warn("[multi-photo extra vision]", e); }
        }
      }

      if (totalPhotoKcal > 0 || totalPhotoProt > 0) {
        await db.insert(mealLogs).values({
          userId: user.id,
          rawMessage: message || "[Photo]",
          source: "photo",
          kcalInt: totalPhotoKcal,
          proteinInt: totalPhotoProt,
          carbsInt: 0,
          fatInt: 0,
        }).catch(e => console.warn("[photo mealLogs write]", e));
      }

      const [photoPattern, photoDay] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id, user.proteinTarget || 130)]);
      let photoDailyTotal = "";
      try {
        const totals = await recomputeTodayFoodTotals(user.id);
        const calTarget = user.calorieTarget || 1800;
        const protTarget = user.proteinTarget || 130;
        if (totals.calories > 0) {
          const remaining = calTarget - totals.calories;
          photoDailyTotal = `\n\n_Today so far: ~${totals.calories} kcal | ${totals.protein}g protein. Target: ${calTarget} kcal | ${protTarget}g protein.${remaining > 100 ? ` ${remaining} kcal remaining.` : " On target."}_`;
        }
        await db.update(users).set({
          todayCalories: totals.calories,
          todayProteinG: totals.protein,
          todayCaloriesDate: sastToday(),
        }).where(eq(users.id, user.id)).catch(e => console.warn("[photo todayCalories sync]", e));
      } catch (e) { console.warn("[non-fatal]", e); }

      const extraSection = extraReplies.length > 0 ? `\n\n${extraReplies.join("\n")}` : "";
      const multiPhotoNote = extraReplies.length > 0 ? `\n_${extraReplies.length + 1} photos logged — total: ~${totalPhotoKcal} kcal | ${totalPhotoProt}g protein_` : "";
      const photoTotalMs = Date.now() - mediaFlowStart;
      console.log(`[MEDIA][${mediaTrace}] photo_ok total_ms=${photoTotalMs}`);
      await logMediaSuccess(user.id, "photo", photoTotalMs);
      return `${visionReply}${extraSection}${multiPhotoNote}${photoPattern ? "\n\n" + photoPattern : ""}${photoDay || ""}${photoDailyTotal}`;
    } catch (err) {
      const photoFailMs = Date.now() - mediaFlowStart;
      console.error(`[MEDIA][${mediaTrace}] vision_error ms=${photoFailMs}:`, err);
      await logMediaFailure(user.id, "vision", err, photoFailMs);
      return "Eish, I cannot read that photo right now. Tell me what you ate in text — 'chicken and sweet potato' — and I will give you the full breakdown.";
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

      let transcription;
      console.log(`[VOICE] whisper_attempt_1 bytes=${audioBuffer.byteLength} ext=${audioExt} lang=${whisperLang || "auto"}`);
      try {
        transcription = await withTimeout("voice_transcribe", 25000, () => openai.audio.transcriptions.create({
          file: createReadStream(tmpAudioPath),
          model: "whisper-1",
          prompt: whisperPrompt,
          ...(whisperLang ? { language: whisperLang } : {}),
        }));
        console.log(`[VOICE] whisper_attempt_1_result text="${(transcription.text || "").slice(0, 80)}" len=${transcription.text?.length ?? 0}`);
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

      let transcribedText = transcription.text?.trim();
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
      if (wordCount < 3) {
        const failCount = bumpVoiceFailure(user.id);
        if (failCount >= 3) {
          clearVoiceFailure(user.id);
          return `I keep only picking up a few words — "${transcribedText}". Please type your message — I'll reply properly.`;
        }
        return `I only caught a few words — "${transcribedText}". Send again or type your message.`;
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

  // ---- FORM CHECK VIDEO ----
  if (ctype.startsWith("video/")) {
    const isFormCheck = /\b(form|check|correct|right|wrong|how does|how do i look|am i doing|check my|my form|form check|squat form|deadlift form|bench form|my squat|my deadlift|my bench|watch this|look at this)\b/i.test(message);
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
