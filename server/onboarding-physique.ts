/**
 * DAY-ZERO PHYSIQUE READ (2026-07-17, founder: "shouldn't they be sending us pictures
 * that the system analyzes BEFORE we make huge mistakes and put people on the wrong
 * program? A lot of people don't know their heights.").
 *
 * During onboarding (state ASK_BODY_PHOTOS) the client may send 1–3 photos (front /
 * side / back). This module downloads them, stores them as the BASELINE progress set
 * (the existing 30-day comparison loop picks them up automatically), runs ONE vision
 * read (lagging muscles + body-composition state), and — when what the body shows
 * disagrees with the goal the client picked — has Coach K RECOMMEND the right phase,
 * warmly, with the client confirming. An assist, never an override: their choice wins
 * every tie, and *skip* always works (self-select stays the fallback).
 *
 * This is the safety net for the client who says "I don't want to lose my curves"
 * while carrying fat she can't see past, and for everyone whose BMI gate is blind
 * because they don't know their height. Fail-open everywhere: any error advances
 * onboarding normally — a broken photo read must never strand a signup.
 */

import type OpenAI from "openai";
import { db } from "./db";
import { users, progressPhotos } from "../shared/schema";
import { eq } from "drizzle-orm";
import { assertSafeMediaUrl } from "./net-guard";
import { logChat } from "./handlers/chat-log";
import { calculateTargets } from "./targets";
import {
  buildPhysiqueAnalysisPrompt, parsePhysiqueAnalysis, parseBodyState,
  recommendGoalFromRead, formatPhysiqueFocusLine,
} from "./physique-analysis";

export const MEDICAL_QUESTION = `Any medical conditions I must know about?\n\n1️⃣ Diabetes\n2️⃣ High blood pressure\n3️⃣ Heart condition\n4️⃣ HIV on ARVs\n5️⃣ PCOS\n6️⃣ None of the above`;

// The ask itself — appended to the weight/height step's reply. Optional and warm:
// body photos are sensitive, so the skip path is offered in the same breath.
export function bodyPhotoAsk(heightKnown: boolean): string {
  const why = heightKnown
    ? `so the plan fits YOUR body, not a guess`
    : `it's extra important since we're starting without your height — the photos tell me what the numbers can't`;
  return `One more step — and it's optional. Send me *1–3 photos of yourself standing* (front, side, back — in whatever you'd train in). I read where you're starting from ${why}, and they become your before-photos so you can SEE the change later.\n\nNot comfortable? Reply *skip* — no problem at all, we go straight on.`;
}

const GOAL_LABEL: Record<string, string> = {
  fat_loss: "Lose fat", muscle_gain: "Build muscle", recomposition: "Lose fat AND build muscle (recomposition)",
};

// One debounce per user so a 3-photo burst gets ONE read and ONE reply (same pattern
// as media.ts _progressBurst). 12s after the last photo lands, the analysis fires.
const _onboardBurst = new Map<string, ReturnType<typeof setTimeout>>();

// scheduler starts cron timers and gpt constructs a client at import time — load them
// only when a photo actually arrives, so this module stays import-light (onboarding.ts
// pulls bodyPhotoAsk/MEDICAL_QUESTION from here, and unit tests import it too).
async function deps() {
  const [{ sendWhatsApp }, { recordGptCost }] = await Promise.all([import("./scheduler"), import("./gpt")]);
  return { sendWhatsApp, recordGptCost };
}

export async function handleOnboardingBodyPhotos(opts: {
  user: any; phone: string; urls: string[]; openai: OpenAI;
}): Promise<string> {
  const { user, phone, urls, openai } = opts;
  const twilioSid = process.env.TWILIO_ACCOUNT_SID || "";
  const twilioToken = process.env.TWILIO_AUTH_TOKEN || "";
  const authHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");

  let saved = 0;
  for (const url of urls.slice(0, 3)) {
    try {
      await assertSafeMediaUrl(url);
      const r = await fetch(url, { headers: { Authorization: authHeader } });
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 10 * 1024 * 1024) continue;
      const nextNum = (await db.select({ id: progressPhotos.id }).from(progressPhotos).where(eq(progressPhotos.userId, user.id))).length + 1;
      await db.insert(progressPhotos).values({
        userId: user.id, photoNumber: nextNum,
        photoBase64: Buffer.from(buf).toString("base64"),
        contentType: r.headers.get("content-type") || "image/jpeg",
      });
      saved++;
    } catch (e) { console.warn("[ONBOARD_PHYSIQUE] photo save failed:", (e as Error)?.message); }
  }
  if (saved === 0) {
    return `I couldn't download that photo — send it once more, or reply *skip* and we carry on.`;
  }
  await logChat(user.id, `[Onboarding body photo ×${saved}]`, "[saved]", "ONBOARD_PHYSIQUE_PHOTO").catch(() => {});

  const existing = _onboardBurst.get(user.id);
  if (existing) clearTimeout(existing);
  _onboardBurst.set(user.id, setTimeout(() => {
    _onboardBurst.delete(user.id);
    analyseAndAdvance(user, phone, openai).catch(async (e) => {
      console.error("[ONBOARD_PHYSIQUE] analysis failed (fail-open):", (e as Error)?.message || e);
      await db.update(users).set({ onboardingState: "ASK_MEDICAL" }).where(eq(users.phoneNumber, phone)).catch(() => {});
      const { sendWhatsApp } = await deps();
      await sendWhatsApp(phone, `Photos saved as your before-set ✅ (I couldn't do the full read right now — no problem, it doesn't hold us up.)\n\n${MEDICAL_QUESTION}`).catch(() => {});
    });
  }, 12_000));

  return `📸 Got it — saved. Send the other angles too if you have them (front, side, back). Give me a moment and I'll tell you what I see.`;
}

async function analyseAndAdvance(user: any, phone: string, openai: OpenAI): Promise<void> {
  const { sendWhatsApp, recordGptCost } = await deps();
  const all = await db.select().from(progressPhotos).where(eq(progressPhotos.userId, user.id)).limit(10);
  const set = all.slice(-3);
  if (set.length === 0) return;

  const chosenGoal = user.goalType || "fat_loss";
  // The read decides the GOAL — the highest-stakes call in the product — so it always
  // gets the strong vision model. Once per client, a fraction of a cent.
  const { system, user: userPrompt } = buildPhysiqueAnalysisPrompt({ gender: user.gender, goal: chosenGoal, name: user.name });
  const resp = await openai.chat.completions.create({
    model: "gpt-4o", max_tokens: 250,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [
        { type: "text", text: userPrompt },
        ...set.map(p => ({ type: "image_url" as const, image_url: { url: `data:${p.contentType};base64,${p.photoBase64}`, detail: "auto" as const } })),
      ] },
    ],
  });
  recordGptCost({ userId: user.id, model: "gpt-4o", feature: "onboard_physique", promptTokens: resp.usage?.prompt_tokens ?? 0, completionTokens: resp.usage?.completion_tokens ?? 0 });
  const raw = resp.choices[0]?.message?.content?.trim() || "";
  const analysis = parsePhysiqueAnalysis(raw, user.gender);
  const bodyState = parseBodyState(raw);

  // The lagging/dominant read doubles as the one-time baseline analysis, so the
  // media-path read won't repeat it when they send progress photos later.
  await db.update(users).set({
    laggingAreas: analysis.lagging.join(","), dominantAreas: analysis.dominant.join(","), physiqueAnalysedAt: new Date(),
  }).where(eq(users.id, user.id));

  const focus = formatPhysiqueFocusLine(analysis);
  const rec = recommendGoalFromRead(bodyState, chosenGoal);

  if (rec) {
    // Read disagrees with their pick: recommend, explain kindly, let THEM decide.
    const base = (user.profileNotes || "").replace(/\s*\bgoalrec:\w+\b/gi, "").trim();
    await db.update(users).set({
      profileNotes: base ? `${base} goalrec:${rec.goal}` : `goalrec:${rec.goal}`,
      onboardingState: "ASK_GOAL_CONFIRM",
    }).where(eq(users.phoneNumber, phone));
    const msg = `Before-photos locked in ✅${focus ? `\n\n${focus}` : ""}\n\nOne honest thing, coach to client: you picked *${GOAL_LABEL[chosenGoal] || chosenGoal}*, but ${rec.reason}\n\nMy recommendation: *${GOAL_LABEL[rec.goal] || rec.goal}*.\n\n1️⃣ Go with your coach's read (recommended)\n2️⃣ Keep my original choice\n\nEither way, we start today.`;
    await logChat(user.id, "[Physique Read]", msg, "ONBOARD_PHYSIQUE_REC");
    await sendWhatsApp(phone, msg);
    return;
  }

  // Read agrees with their pick — confirm it with what we saw, and move on.
  await db.update(users).set({ onboardingState: "ASK_MEDICAL" }).where(eq(users.phoneNumber, phone));
  const msg = `Before-photos locked in ✅${focus ? `\n\n${focus}` : ""}\n\nAnd your goal choice — *${GOAL_LABEL[chosenGoal] || chosenGoal}* — matches exactly what I see. Good instincts. That's the plan we build.\n\n${MEDICAL_QUESTION}`;
  await logChat(user.id, "[Physique Read]", msg, "ONBOARD_PHYSIQUE_OK");
  await sendWhatsApp(phone, msg);
}
