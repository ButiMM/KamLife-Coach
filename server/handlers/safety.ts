/**
 * Safety + data-management guards.
 * Run at the very top of handleMessage, before user lookup.
 * Return a string to short-circuit, or null to fall through.
 */

import twilio from "twilio";
import { db, pool } from "../db";
import {
  users, chatHistory, stepLogs, workoutLogs, weightLogs,
  weeklyCheckins, clothingCheckins, bodyMeasurements,
  mealLogs, progressPhotos, escalations, abAssignments, exerciseLogs,
  sentProactive, clientActions,
} from "../../shared/schema";
import { eq } from "drizzle-orm";
import { logChat } from "./chat-log";

// ── Crisis detection ──────────────────────────────────────────
const CRISIS_PHRASES = [
  "want to die", "kill myself", "end it all", "cannot go on", "can't go on",
  "suicidal", "self harm", "self-harm", "cutting myself", "hurting myself",
  "not worth living", "end my life", "no reason to live", "give up on life",
  "want to hurt myself", "harm myself", "take my life",
  "no point in living", "better off dead", "hang myself",
  "everyone would be better off without me",
];

// ── Terminal command guard ────────────────────────────────────
const TERMINAL_PATTERNS = [
  /\bgit\s+(pull|push|commit|clone|checkout|reset|rebase|merge|status|log|diff|add|stash)\b/i,
  /\bnpm\s+(run|install|start|build|test|update|uninstall)\b/i,
  /\bpkill\b|\bkill\s+-\d/i,
  /\brm\s+-rf\b/i,
  /\bsudo\b.*\b(apt|brew|yum|pip|npm)\b/i,
  /^[a-z0-9_.-]+\s*&&\s*[a-z0-9_.-]+/i,
  /\bcd\s+\/[a-z]/i,
  /\bchmod\b|\bchown\b/i,
];

export async function runSafetyGuards(
  phone: string,
  message: string,
  m: string,
): Promise<string | null> {

  // ---- CRISIS ----
  if (CRISIS_PHRASES.some(phrase => m.includes(phrase))) {
    const crisisUser = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    const crisisName = crisisUser[0]?.name || "friend";
    const crisisReply = `${crisisName}, I hear you and I am concerned. Please contact SADAG right now — 0800 567 567, free, 24 hours, confidential. Lifeline SA: 0861 322 322. You matter far more than any fitness goal. Reach out to them — they are trained for exactly this moment.`;
    try { await logChat(crisisUser[0]?.id || "unknown", message, crisisReply, "CRISIS"); } catch (e) { console.warn("[non-fatal]", e); }
    const coachAlertPhone = process.env.COACH_ALERT_PHONE;
    if (!coachAlertPhone) {
      console.error(`[CRISIS] ⚠️  COACH_ALERT_PHONE not configured — coach NOT notified! Client: ${crisisName} (${phone}). Message: "${message.slice(0, 150)}"`);
    } else if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      try {
        const alertClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const fromNum = process.env.TWILIO_WHATSAPP_NUMBER?.startsWith("whatsapp:") ? process.env.TWILIO_WHATSAPP_NUMBER : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
        await alertClient.messages.create({
          from: fromNum,
          to: `whatsapp:${coachAlertPhone}`,
          body: `⚠️ CRISIS ALERT\nClient: ${crisisName} (${phone})\nMessage: "${message.slice(0, 150)}"\n\nThey have been given SADAG 0800 567 567. Please check on this client.`,
        });
        console.log(`[CRISIS] Coach alert sent to ${coachAlertPhone}`);
      } catch (e) {
        console.error(`[CRISIS] ⚠️  COACH ALERT SEND FAILED — coach NOT notified! Client: ${crisisName} (${phone}). Error:`, e);
      }
    }
    return crisisReply;
  }

  // ---- ACUTE MEDICAL EMERGENCY ----
  // "stroke" is checked separately from the other emergencies: alone it matched
  // swimming strokes and "stroke of luck/genius", firing a false ambulance alert +
  // coach crisis ping. The benign exclusion applies ONLY to the stroke keyword, so a
  // message like "stroke of luck but now chest pain" still fires on chest pain. A real
  // stroke is never phrased "stroke of luck", so this cannot suppress a genuine one.
  const nonStrokeEmergency = /\b(chest pain|chest hurts?|chest is (tight|sore|aching|burning)|pain in my chest|chest tightness|heart attack|seizure|convulsion|i (fainted|collapsed)|difficulty breathing|can.?t breathe|cannot breathe|shortness of breath|collapsed|heart racing badly|heart pounding)\b/i.test(m);
  const benignStroke = /\bstroke of (?:luck|genius)\b|\b(?:breast|back|free|butterfly|side|swim(?:ming)?|paddle|broad|key)\s*-?\s*strokes?\b|\bbreaststroke\b|\bbackstroke\b/i.test(m);
  const strokeEmergency = /\bstrokes?\b/i.test(m) && !benignStroke;
  if (nonStrokeEmergency || strokeEmergency) {
    const acuteUser = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    const acuteName = acuteUser[0]?.name || "friend";
    const acuteReply = `This sounds like it could be a medical emergency. Stop what you're doing and call *10177* (SA ambulance) or go to your nearest emergency room immediately. Do not wait. Health first — everything else can wait.`;
    try { await logChat(acuteUser[0]?.id || "unknown", message, acuteReply, "ACUTE_MEDICAL"); } catch (e) { console.warn("[non-fatal]", e); }
    const coachAlertPhone = process.env.COACH_ALERT_PHONE;
    if (!coachAlertPhone) {
      console.error(`[ACUTE_MEDICAL] ⚠️  COACH_ALERT_PHONE not configured — coach NOT notified! Client: ${acuteName} (${phone}). Message: "${message.slice(0, 150)}"`);
    } else if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      try {
        const alertClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const fromNum = process.env.TWILIO_WHATSAPP_NUMBER?.startsWith("whatsapp:") ? process.env.TWILIO_WHATSAPP_NUMBER : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
        await alertClient.messages.create({
          from: fromNum,
          to: `whatsapp:${coachAlertPhone}`,
          body: `🚨 MEDICAL ALERT\nClient: ${acuteName} (${phone})\nMessage: "${message.slice(0, 150)}"\n\nThey have been directed to call 10177. Please check on this client.`,
        });
        console.log(`[ACUTE_MEDICAL] Coach alert sent to ${coachAlertPhone}`);
      } catch (e) {
        console.error(`[ACUTE_MEDICAL] ⚠️  COACH ALERT SEND FAILED — coach NOT notified! Client: ${acuteName} (${phone}). Error:`, e);
      }
    }
    return acuteReply;
  }

  // ---- TERMINAL / GIT COMMAND GUARD ----
  if (TERMINAL_PATTERNS.some(re => re.test(message))) {
    return `That looks like a terminal command — I'm your fitness coach, not a shell! Send me what you ate, your workout, or ask about your goals. 💪`;
  }

  // ---- DELETE MY DATA (POPIA) ----
  if (/delete my data|forget me|remove my account|popia delete|delete me|erase my data/i.test(m)) {
    const existing = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    if (existing.length === 0) return "No account found for this number.";
    const name = existing[0].name || "there";
    await db.update(users).set({ awaitingInputType: "delete_confirm" }).where(eq(users.phoneNumber, phone));
    return `${name}, this will permanently delete all your data — workouts, steps, food logs, measurements, weight history, and your profile. This cannot be undone.\n\nReply *DELETE* (in capitals) to confirm, or anything else to cancel.`;
  }

  if (m === "delete") {
    const existing = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
    if (existing.length > 0 && existing[0].awaitingInputType === "delete_confirm") {
      const uid = existing[0].id;
      console.log(`[POPIA DELETE] User ${uid} (${phone}) requested data deletion at ${new Date().toISOString()}`);
      await db.transaction(async (tx) => {
        await tx.delete(chatHistory).where(eq(chatHistory.userId, uid));
        await tx.delete(stepLogs).where(eq(stepLogs.userId, uid));
        await tx.delete(workoutLogs).where(eq(workoutLogs.userId, uid));
        await tx.delete(weightLogs).where(eq(weightLogs.userId, uid));
        await tx.delete(weeklyCheckins).where(eq(weeklyCheckins.userId, uid));
        await tx.delete(clothingCheckins).where(eq(clothingCheckins.userId, uid));
        await tx.delete(bodyMeasurements).where(eq(bodyMeasurements.userId, uid));
        await tx.delete(mealLogs).where(eq(mealLogs.userId, uid));
        await tx.delete(progressPhotos).where(eq(progressPhotos.userId, uid));
        await tx.delete(escalations).where(eq(escalations.userId, uid));
        await tx.update(users).set({
          phoneNumber: `[deleted-${uid}]`,
          name: null,
          onboardingState: null,
          popiConsent: false,
          awaitingInputType: null,
          currentWeight: null,
          heightCm: null,
          age: null,
          gender: null,
          medicalConditions: null,
          injuries: null,
          otherMedicalNotes: null,
          profileNotes: null,
          lastActiveAt: null,
          cancelledAt: new Date(),
        }).where(eq(users.id, uid));
      });
      try {
        await pool.query("DELETE FROM memories WHERE phone = $1", [phone]);
        console.log(`[POPIA DELETE] Vector memories cleared for ${phone}`);
      } catch (memErr: any) {
        console.warn(`[POPIA DELETE] Vector memory deletion failed (non-fatal): ${memErr.message}`);
      }
      console.log(`[POPIA DELETE] Completed — all data deleted for ${uid}`);
      return "Done. All your data has been permanently deleted in compliance with POPIA. If you want to start fresh, just send any message.";
    }
  }

  // ---- HARD RESET (debug / re-onboard) ----
  // Two-step: bare "reset" asks for confirmation; "yes reset" actually wipes.
  if (m === "yes reset" || m === "yes, reset" || m === "confirm reset") {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    if (existing.length > 0) {
      const uid = existing[0].id;
      await db.delete(chatHistory).where(eq(chatHistory.userId, uid));
      await db.delete(stepLogs).where(eq(stepLogs.userId, uid));
      await db.delete(workoutLogs).where(eq(workoutLogs.userId, uid));
      await db.delete(weightLogs).where(eq(weightLogs.userId, uid));
      await db.delete(mealLogs).where(eq(mealLogs.userId, uid));
      await db.delete(weeklyCheckins).where(eq(weeklyCheckins.userId, uid));
      await db.delete(clothingCheckins).where(eq(clothingCheckins.userId, uid));
      await db.delete(bodyMeasurements).where(eq(bodyMeasurements.userId, uid));
      await db.delete(exerciseLogs).where(eq(exerciseLogs.userId, uid));
      await db.delete(progressPhotos).where(eq(progressPhotos.userId, uid));
      await db.delete(escalations).where(eq(escalations.userId, uid));
      await db.delete(sentProactive).where(eq(sentProactive.userId, uid));
      await db.delete(clientActions).where(eq(clientActions.userId, uid));
      await db.delete(abAssignments).where(eq(abAssignments.userId, uid));
      await db.delete(users).where(eq(users.id, uid));
    }
    await db.insert(users).values({
      phoneNumber: phone,
      subscriptionStatus: "inactive",
      onboardingState: "WELCOME",
      programmePhase: 1,
      programmeWeek: 1,
      programmeDayInWeek: 1,
      trainingMode: "home",
      stepsTarget: 8500,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
    return "Fresh start. What's your name?";
  }

  if (m === "reset") {
    const existing = await db.select({ id: users.id, onboardingState: users.onboardingState, totalWorkoutsCompleted: users.totalWorkoutsCompleted })
      .from(users).where(eq(users.phoneNumber, phone)).limit(1);
    const hasData = existing.length > 0 && (
      existing[0].onboardingState === "COMPLETE" ||
      (existing[0].totalWorkoutsCompleted ?? 0) > 0
    );
    if (hasData) {
      const sessions = existing[0].totalWorkoutsCompleted || 0;
      const sessionNote = sessions > 0 ? ` You have *${sessions} session${sessions === 1 ? "" : "s"}* logged.` : "";
      return `⚠️ This will permanently delete all your data — workouts, food logs, weight history, everything.${sessionNote}\n\nReply *yes reset* to confirm, or anything else to go back.`;
    }
    // No meaningful data yet — wipe immediately
    if (existing.length > 0) {
      const uid = existing[0].id;
      await db.delete(chatHistory).where(eq(chatHistory.userId, uid));
      await db.delete(stepLogs).where(eq(stepLogs.userId, uid));
      await db.delete(workoutLogs).where(eq(workoutLogs.userId, uid));
      await db.delete(weightLogs).where(eq(weightLogs.userId, uid));
      await db.delete(mealLogs).where(eq(mealLogs.userId, uid));
      await db.delete(weeklyCheckins).where(eq(weeklyCheckins.userId, uid));
      await db.delete(clothingCheckins).where(eq(clothingCheckins.userId, uid));
      await db.delete(bodyMeasurements).where(eq(bodyMeasurements.userId, uid));
      await db.delete(exerciseLogs).where(eq(exerciseLogs.userId, uid));
      await db.delete(progressPhotos).where(eq(progressPhotos.userId, uid));
      await db.delete(escalations).where(eq(escalations.userId, uid));
      await db.delete(sentProactive).where(eq(sentProactive.userId, uid));
      await db.delete(clientActions).where(eq(clientActions.userId, uid));
      await db.delete(abAssignments).where(eq(abAssignments.userId, uid));
      await db.delete(users).where(eq(users.id, uid));
    }
    await db.insert(users).values({
      phoneNumber: phone,
      subscriptionStatus: "inactive",
      onboardingState: "WELCOME",
      programmePhase: 1,
      programmeWeek: 1,
      programmeDayInWeek: 1,
      trainingMode: "home",
      stepsTarget: 8500,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
    return "Fresh start. What's your name?";
  }

  return null;
}
