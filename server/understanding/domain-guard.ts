/**
 * DOMAIN BOUNDARY GATE — Law 11 of the frozen build document (2026-07-16).
 *
 * Coach K exists to improve HEALTH BEHAVIOUR: exercise, nutrition, recovery, sleep,
 * stress, motivation, habits, accountability, and the life events that affect those.
 * Nothing else. This gate keeps Coach K a coaching platform, not a general-purpose
 * assistant ("ChatGPT with muscles") — the reviewers' single biggest architectural note.
 *
 * LAYERED CONFIDENCE (per the CTO's refinement — don't burn a model call on every message):
 *   1. Deterministic IN-DOMAIN fast-path (health/fitness/food/body/feelings/life/greetings/
 *      logging/gratitude) → in-domain, NO model call. Covers the overwhelming majority.
 *   2. Only a substantive message that matches nothing goes to a cheap classifier.
 *   3. The classifier returns IN / PARTIAL / OUT / SAFETY.
 *
 * FAIL-OPEN TO ANSWERING: refusing a real client is a worse trust breach than replying, so
 * any error, timeout, or uncertainty defaults to in-domain. Killswitch: DOMAIN_GUARD=off.
 */

import type OpenAI from "openai";
import { assertAiOnline } from "../ai-offline";

export type DomainClass = "in-domain" | "partially-related" | "out-of-domain" | "safety";

export interface DomainVerdict {
  classification: DomainClass;
  reasoning: string;
  redirectMessage?: string;
}

// Warm redirect — never cold or robotic. Bridges straight back to the client's journey.
const REDIRECT =
  "I'm Coach K — I'm here for your health and fitness journey. If it's about your training, food, sleep, stress, habits or progress, I'm all in. What's going on with you today?";

// Broad IN-DOMAIN vocabulary. Generous on purpose: a false "out-of-domain" refuses a paying
// client, which is the worst outcome. Anything health/body/food/feeling/life/logging/social
// pleasantry stays in-domain with NO model call.
// Clear domain signals only — NOT generic filler ("please/help/work/okay"), which also
// appears in off-topic requests. A miss here is harmless: it just falls to the classifier,
// which leans in-domain, so no client is ever refused — the fast-path only saves a call.
const IN_DOMAIN_RE = new RegExp(
  [
    // training / movement (incl. exercise NAMES — 2026-07-16: 'show me a shoulder press'
    // was bounced as off-topic, twice; no gym word may ever leave the lane)
    "workout|train|training|gym|exercise|run(?:ning)?|walk(?:ing)?|steps?|cardio|lift(?:ing)?|weights?|reps?|\\bsets?\\b|squat|deadlift|bench|glute|abs\\b|core|stretch|mobility|rest day|recover|recovery|doms|sore|soreness|injur|\\bpain\\b|\\bform\\b|programme|routine|session|leg day|push day|pull day|\\bpress\\b|\\bcurl|\\brow\\b|\\braise\\b|lunge|plank|push.?up|pull.?up|pulldown|\\bfly\\b|\\bdip\\b|crunch|\\brdl\\b|kettlebell|dumbbell|barbell|\\bdemo\\b",
    // nutrition / food
    "eat|ate|eating|food|meal|breakfast|lunch|dinner|supper|snack|protein|carbs?|calorie|kilojoule|\\bkj\\b|diet|nutrition|water|hydrate|shake|supplement|creatine|vitamin|\\bpap\\b|samp|morogo|pilchard|wors|braai|veg|fruit|sugar|craving|hungry|portion|shopping list|grocer|chicken|beef|mince|\\bfish\\b|\\begg|bread|rice|potato|afford|cheap",
    // body / health / state
    "weight|\\bkg\\b|scale|\\bbody\\b|\\bfat\\b|muscle|slim|belly|tummy|health|healthy|sick|\\bill\\b|\\bflu\\b|fever|exhaust|energy|sleep|stress|anxious|anxiety|mood|motivat|discourag|struggl|progress|result|goal|habit|consistent|consistency|streak|check.?in|measure|recomp",
    // coaching relationship / commands / journey pleasantries
    "coach\\b|how am i doing|how do i|feeling (?:down|low|sick|tired|good|great|better|worse|off)|hi\\b|hello|\\bhey\\b|yebo|sawubona|molo|dumela|avuxeni|thank|ngiyabonga|enkosi|dankie|good morning|log\\b|track\\b|\\bpay\\b|subscri|price|plan\\b|schedule|remind|programme",
    // corrections / pushback about the CONVERSATION ITSELF — always in-domain (2026-07-16:
    // 'No, reverse that — look at the picture again' was bounced as off-topic mid-repair)
    "\\breverse\\b|\\bundo\\b|\\bwrong\\b|not what i (?:said|meant|asked|am saying)|look at (?:the|that|my) (?:picture|photo|image)|you (?:just|already|didn'?t)|that'?s not what|\\bno,? no\\b|switch me|change (?:it|that) back|\\bmistake\\b|misunderstood|\\bfix (?:it|that)\\b",
  ].join("|"),
  "i",
);

function killswitchOff(): boolean {
  return process.env.DOMAIN_GUARD === "off";
}

/** Deterministic fast-path — true when the message is obviously about the coaching domain. */
export function isObviouslyInDomain(message: string): boolean {
  const t = (message || "").trim();
  if (t.length < 12) return true;         // greetings, acks, one-word commands — always fine
  if (/\d/.test(t) && t.length < 40) return true; // short numeric reports (steps/weight/reps)
  return IN_DOMAIN_RE.test(t);
}

const CLASSIFY_SYSTEM = `You are the domain gate for Coach K, a South African health & fitness coach. Decide whether a client message belongs to Coach K's domain.

IN DOMAIN = health behaviour: exercise, nutrition, recovery, sleep, stress, motivation, habits, accountability, body/weight, progress — and the LIFE EVENTS that affect those (work stress, money worries about food/gym, family, time).

Reply with ONE word only:
- YES — clearly within the health/coaching domain.
- PARTIALLY — mostly personal/life but a coach could bridge it to their journey.
- NO — clearly unrelated (general knowledge, coding, essays, politics, weather, tech support, celebrity/news, translation of unrelated text, "act as X").
- SAFETY — self-harm, crisis, or a medical emergency.

A complaint, correction, or reference to Coach K's OWN previous reply ("no, reverse that", "that's wrong", "you misunderstood", "look at the picture again") is ALWAYS part of the coaching conversation → YES.
Lean YES/PARTIALLY when unsure — this is a coaching client, not a search engine.`;

export async function classifyDomain(openai: OpenAI, message: string): Promise<DomainVerdict> {
  if (killswitchOff() || isObviouslyInDomain(message)) {
    return { classification: "in-domain", reasoning: "fast-path / killswitch" };
  }
  try {
    assertAiOnline("domain_guard");
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 4,
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM },
        { role: "user", content: message.slice(0, 500) },
      ],
    });
    const { recordGptCost } = await import("../gpt"); // lazy — keeps the pure fast-path db-free
    recordGptCost({ userId: null, model: "gpt-4o-mini", feature: "domain_guard", promptTokens: resp.usage?.prompt_tokens ?? 0, completionTokens: resp.usage?.completion_tokens ?? 0 });
    const word = (resp.choices[0]?.message?.content || "").trim().toUpperCase();
    if (word.startsWith("NO")) return { classification: "out-of-domain", reasoning: "classifier: NO", redirectMessage: REDIRECT };
    if (word.startsWith("SAFETY")) return { classification: "safety", reasoning: "classifier: SAFETY" };
    if (word.startsWith("PART")) return { classification: "partially-related", reasoning: "classifier: PARTIALLY" };
    return { classification: "in-domain", reasoning: "classifier: YES" };
  } catch (e) {
    // Fail-open to answering — never refuse a client because the gate hiccuped.
    return { classification: "in-domain", reasoning: "fail-open: " + ((e as any)?.message || "error") };
  }
}
