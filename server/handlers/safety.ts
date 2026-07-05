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
  sentProactive, clientActions, adminEvents,
  gptCosts, userIntegrations, clientIntelligenceProfiles,
} from "../../shared/schema";
import { eq } from "drizzle-orm";
import { logChat } from "./chat-log";

// Send a Twilio message with exponential-backoff retries. On complete failure,
// records a row in adminEvents so the coach can find missed alerts on reload.
async function sendAlertWithRetry(opts: {
  label: string;
  from: string;
  to: string;
  body: string;
  phone: string;
  name: string;
  originalMessage: string;
}): Promise<void> {
  const { label, from, to, body, phone, name, originalMessage } = opts;
  const delays = [500, 1500, 4500];
  for (let i = 0; i < delays.length; i++) {
    try {
      const alertClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await alertClient.messages.create({ from, to, body });
      console.log(`[${label}] Coach alert sent to ${to} (attempt ${i + 1})`);
      return;
    } catch (e: any) {
      const isLast = i === delays.length - 1;
      console.error(`[${label}] Alert send failed (attempt ${i + 1}${isLast ? ", FINAL" : ""}):`, e?.message || e);
      if (!isLast) await new Promise(r => setTimeout(r, delays[i]));
    }
  }
  // All retries exhausted — write to adminEvents so the coach sees it on reload
  try {
    await db.insert(adminEvents).values({
      action: "crisis_alert_failed",
      targetPhone: phone,
      reason: `${label}: all 3 Twilio send attempts failed`,
      meta: { clientName: name, messageSnippet: originalMessage.slice(0, 200) },
    });
    console.error(`[${label}] ⚠️  Recorded crisis_alert_failed in adminEvents for ${phone}`);
  } catch (dbErr) {
    console.error(`[${label}] ⚠️  Also failed to write adminEvents:`, dbErr);
  }
}

// ── Crisis detection ──────────────────────────────────────────
const CRISIS_PHRASES = [
  "want to die", "kill myself", "end it all", "cannot go on", "can't go on",
  "suicidal", "self harm", "self-harm", "cutting myself", "hurting myself",
  "not worth living", "end my life", "no reason to live", "give up on life",
  "want to hurt myself", "harm myself", "take my life",
  "no point in living", "better off dead", "hang myself",
  "everyone would be better off without me",
  "don't want to be here", "do not want to be here", "dont want to be here",
  "wish i was dead", "wish i were dead", "nothing to live for", "tired of living",
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
      const fromNum = process.env.TWILIO_WHATSAPP_NUMBER?.startsWith("whatsapp:") ? process.env.TWILIO_WHATSAPP_NUMBER : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
      await sendAlertWithRetry({
        label: "CRISIS",
        from: fromNum!,
        to: `whatsapp:${coachAlertPhone}`,
        body: `⚠️ CRISIS ALERT\nClient: ${crisisName} (${phone})\nMessage: "${message.slice(0, 150)}"\n\nThey have been given SADAG 0800 567 567. Please check on this client.`,
        phone,
        name: crisisName,
        originalMessage: message,
      });
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
      const fromNum = process.env.TWILIO_WHATSAPP_NUMBER?.startsWith("whatsapp:") ? process.env.TWILIO_WHATSAPP_NUMBER : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
      await sendAlertWithRetry({
        label: "ACUTE_MEDICAL",
        from: fromNum!,
        to: `whatsapp:${coachAlertPhone}`,
        body: `🚨 MEDICAL ALERT\nClient: ${acuteName} (${phone})\nMessage: "${message.slice(0, 150)}"\n\nThey have been directed to call 10177. Please check on this client.`,
        phone,
        name: acuteName,
        originalMessage: message,
      });
    }
    return acuteReply;
  }

  // ---- TERMINAL / GIT COMMAND GUARD ----
  if (TERMINAL_PATTERNS.some(re => re.test(message))) {
    return `That looks like a terminal command — I'm your fitness coach, not a shell! Send me what you ate, your workout, or ask about your goals. 💪`;
  }

  // ---- PROMPT-INJECTION / JAILBREAK GUARD ----
  // Untrusted WhatsApp text reaches GPT, so neutralise the obvious attempts to reprogram
  // the coach, extract the system prompt, or force a clinical role BEFORE any model call.
  // Patterns are deliberately TIGHT and high-signal: benign self-correction ("ignore my
  // last message"), real questions ("what's my workout"), and normal nutrition talk must
  // fall through. Subtler attempts are caught by the in-character hardening in
  // coach-prompt.ts — two layers, same as the rest of the system.
  const injectionAttempt =
    /\b(ignore|disregard|forget|override)\b[^.?!]{0,32}\b(previous|prior|above|earlier|all|your|these|those|the|initial|original|system)\b[^.?!]{0,24}\b(instructions?|rules?|prompts?|guidelines?|constraints?|programming)\b/i.test(m)
    || /\byou are (now|no longer)\s+(a\s+|an\s+|the\s+)?(doctor|physician|nurse|dietician|dietitian|pharmacist|psychologist|therapist|lawyer|dan|unrestricted|uncensored|free from|not bound|not a coach|able to)\b/i.test(m)
    || /\b(developer|dev|god|admin|sudo|debug|dan|jailbreak|unrestricted|uncensored)\s+mode\b/i.test(m)
    || /\bsystem prompt\b/i.test(m)
    || /\b(reveal|repeat|print|show me|output|tell me|what.?s|what is)\b[^.?!]{0,24}\byour\b[^.?!]{0,16}\b(prompt|programming|source code)\b/i.test(m)
    || /\b(pretend|act as|behave as|roleplay as|role-play as|imagine you.?re|imagine that you.?re)\b[^.?!]{0,24}\b(a\s+|an\s+|the\s+)?(doctor|physician|nurse|dietician|dietitian|pharmacist|psychologist|therapist|lawyer|different ai|another ai|dan)\b/i.test(m)
    || /\b(ignore|bypass|disable|turn off|switch off|remove)\b[^.?!]{0,20}\b(safety|guard|guardrails?|filters?|restrictions?)\b/i.test(m);
  if (injectionAttempt) {
    const injUser = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    const injName = injUser[0]?.name?.split(" ")[0] || "";
    const injReply = `Ha${injName ? ", " + injName : ""} — nice try. 😄 I'm Coach K: I coach food and training, that's the whole job, and I can't be talked into being anything else.\n\nWhat do you actually need — a workout, a meal sorted, or your steps?`;
    try { await logChat(injUser[0]?.id || "unknown", message, injReply, "INJECTION_BLOCKED"); } catch (e) { console.warn("[non-fatal]", e); }
    return injReply;
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
        await tx.delete(exerciseLogs).where(eq(exerciseLogs.userId, uid));
        await tx.delete(clientIntelligenceProfiles).where(eq(clientIntelligenceProfiles.userId, uid));
        await tx.delete(userIntegrations).where(eq(userIntegrations.userId, uid));
        await tx.delete(sentProactive).where(eq(sentProactive.userId, uid));
        await tx.delete(clientActions).where(eq(clientActions.userId, uid));
        await tx.delete(abAssignments).where(eq(abAssignments.userId, uid));
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
    await db.transaction(async (tx) => {
      if (existing.length > 0) {
        const uid = existing[0].id;
        await tx.delete(gptCosts).where(eq(gptCosts.userId, uid));
        await tx.delete(clientIntelligenceProfiles).where(eq(clientIntelligenceProfiles.userId, uid));
        await tx.delete(userIntegrations).where(eq(userIntegrations.userId, uid));
        await tx.delete(chatHistory).where(eq(chatHistory.userId, uid));
        await tx.delete(stepLogs).where(eq(stepLogs.userId, uid));
        await tx.delete(workoutLogs).where(eq(workoutLogs.userId, uid));
        await tx.delete(weightLogs).where(eq(weightLogs.userId, uid));
        await tx.delete(mealLogs).where(eq(mealLogs.userId, uid));
        await tx.delete(weeklyCheckins).where(eq(weeklyCheckins.userId, uid));
        await tx.delete(clothingCheckins).where(eq(clothingCheckins.userId, uid));
        await tx.delete(bodyMeasurements).where(eq(bodyMeasurements.userId, uid));
        await tx.delete(exerciseLogs).where(eq(exerciseLogs.userId, uid));
        await tx.delete(progressPhotos).where(eq(progressPhotos.userId, uid));
        await tx.delete(escalations).where(eq(escalations.userId, uid));
        await tx.delete(sentProactive).where(eq(sentProactive.userId, uid));
        await tx.delete(clientActions).where(eq(clientActions.userId, uid));
        await tx.delete(abAssignments).where(eq(abAssignments.userId, uid));
        await tx.delete(users).where(eq(users.id, uid));
      }
      await tx.insert(users).values({
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
    });
    await pool.query("DELETE FROM memories WHERE phone = $1", [phone]).catch((e: any) =>
      console.error("[RESET] memories delete failed (non-fatal):", e?.message)
    );
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
    await db.transaction(async (tx) => {
      if (existing.length > 0) {
        const uid = existing[0].id;
        await tx.delete(gptCosts).where(eq(gptCosts.userId, uid));
        await tx.delete(clientIntelligenceProfiles).where(eq(clientIntelligenceProfiles.userId, uid));
        await tx.delete(userIntegrations).where(eq(userIntegrations.userId, uid));
        await tx.delete(chatHistory).where(eq(chatHistory.userId, uid));
        await tx.delete(stepLogs).where(eq(stepLogs.userId, uid));
        await tx.delete(workoutLogs).where(eq(workoutLogs.userId, uid));
        await tx.delete(weightLogs).where(eq(weightLogs.userId, uid));
        await tx.delete(mealLogs).where(eq(mealLogs.userId, uid));
        await tx.delete(weeklyCheckins).where(eq(weeklyCheckins.userId, uid));
        await tx.delete(clothingCheckins).where(eq(clothingCheckins.userId, uid));
        await tx.delete(bodyMeasurements).where(eq(bodyMeasurements.userId, uid));
        await tx.delete(exerciseLogs).where(eq(exerciseLogs.userId, uid));
        await tx.delete(progressPhotos).where(eq(progressPhotos.userId, uid));
        await tx.delete(escalations).where(eq(escalations.userId, uid));
        await tx.delete(sentProactive).where(eq(sentProactive.userId, uid));
        await tx.delete(clientActions).where(eq(clientActions.userId, uid));
        await tx.delete(abAssignments).where(eq(abAssignments.userId, uid));
        await tx.delete(users).where(eq(users.id, uid));
      }
      await tx.insert(users).values({
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
    });
    await pool.query("DELETE FROM memories WHERE phone = $1", [phone]).catch((e: any) =>
      console.error("[RESET] memories delete failed (non-fatal):", e?.message)
    );
    return "Fresh start. What's your name?";
  }

  return null;
}
