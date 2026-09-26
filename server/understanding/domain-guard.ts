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
 * FAIL CLOSED ON THE MODEL'S VERDICT (#321, 2026-09-24). This used to answer any unrecognised
 * verdict, and scope was otherwise prompt text. Scope was then only a line of prompt text, and Meta
 * bans general-purpose assistants on the WhatsApp Business API from 15 Jan 2026 — "write my CV"
 * answered by Coach K is a platform risk. Now:
 *   0. A deterministic OFF-DOMAIN ask (CV, crypto, essays, code) is declined before any command
 *      or model can answer it. ("What antibiotic should I take" belongs to medication-context.)
 *   1. The in-domain fast-path still answers coaching with no model call, and it is generous, so
 *      a real client is not left to the classifier's mercy.
 *   2. Only YES / PARTIALLY / SAFETY from the classifier count as in-domain. NO, or any word it
 *      was not asked for, declines with the warm redirect — never an answer. A classifier ERROR is
 *      not a verdict: the deterministic layer (0) is the scope, and the message goes on.
 * Killswitch: DOMAIN_GUARD=off.
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

/** "Can I speak to a real person?" is not off-topic (C7, gate asks-for-a-real-person): chat-log already escalates
 *  it to the founder's inbox (detectEscalation → human_requested), so the client is told that, honestly. */
const HUMAN_HANDOFF =
  "You're chatting with Coach K, an AI coach. I've passed this to a person on our team and they'll get back to you here. What's it about, so they have the full picture?";

/**
 * THE SAME REDIRECT, TO SOMEBODY ALREADY TALKING TO US (2026-08-20, phone P0).
 *
 * The line above introduces Coach K. That is right for a cold first contact and wrong for anyone
 * mid-conversation — the founder, six messages into correcting us about his own state, asked
 * "What's the day today??" and got the brochure. Introducing yourself to someone who is arguing
 * with you reads as the coach forgetting who they are talking to, which is worse than any wrong
 * answer, because it says the relationship was never there.
 *
 * A fallback may lose SPECIFICITY. It may not reset identity, relationship or context. So this
 * one stays in the conversation and hands the turn back, and it lives here beside the other so
 * there is one owner of what we say when we cannot answer — not a second tree somewhere else.
 */
const REDIRECT_IN_CONVERSATION =
  "That one's outside what I can help with — but I'm still here on the training, food and how you're going. What did you need?";

/**
 * OFF-DOMAIN ASKS, DECIDED WITHOUT A MODEL (#321). Every pattern is ASK-SHAPED — a request for the
 * thing, not a mention of it — so "I lost money on crypto and can't afford the gym" (a life event
 * a coach bridges) and "my doctor prescribed metformin, what should I eat?" stay in the lane.
 */
const OFF_DOMAIN_ASK_RE = new RegExp(
  [
    // CVs, essays, homework, creative writing, emails
    "\\b(?:write|update|fix|improve|redo|help (?:me )?(?:with|write))\\b[^.?!]{0,25}\\b(?:cv|curriculum vitae|cover letter|motivation letter)\\b",
    "\\bwrite (?:me |us )?(?:an? |my |the )?(?:essay|poem|song|story|speech|assignment|business plan|email|letter)\\b",
    "\\b(?:help me with|do|finish) my (?:homework|assignment|essay|thesis|dissertation)\\b",
    // money: investing and betting asks
    "\\b(?:invest|buy|sell|trade|trading|put)\\b[^.?!]{0,40}\\b(?:bitcoin|crypto\\w*|forex|shares|stocks|stock market|ethereum)\\b",
    // (never bare "stock" or "share": stock cubes, "share some tips")
    "\\b(?:bitcoin|crypto\\w*|forex|stock market)\\b[^.?!]{0,20}\\b(?:tips?|price|prediction|picks?|advice)\\b",
    "\\b(?:betting|lotto|powerball) (?:tips|numbers|picks)\\b",
    // code
    "\\b(?:write|fix|debug)\\b[^.?!]{0,30}\\b(?:code|script|python|javascript|java|sql|html|excel formula)\\b",
  ].join("|"),
  "i",
);

/**
 * A deterministic off-domain ask, or null. No model, no database: safe on every path. A medicine
 * ask is not decided here: detectMedicationContext owns it ("choosing" is an unsafe request) and
 * the reply verifier answers it with the clinical referral, whichever handler drafted the reply.
 */
export function offDomainRedirect(message: string, ongoing = false): string | null {
  if (killswitchOff()) return null;
  const t = (message || "").replace(/[\u2018\u2019]/g, "'");
  // "I had to update my CV so I skipped gym" is a life event, not an ask: coaching words win.
  if (OFF_DOMAIN_ASK_RE.test(t) && !isObviouslyInDomain(t)) return ongoing ? REDIRECT_IN_CONVERSATION : REDIRECT;
  return null;
}

// Broad IN-DOMAIN vocabulary. Generous on purpose: a false "out-of-domain" refuses a paying
// client, which is the worst outcome. Anything health/body/food/feeling/life/logging/social
// pleasantry stays in-domain with NO model call.
// Clear domain signals only — NOT generic filler ("please/help/work/okay"), which also
// appears in off-topic requests. A miss here falls to the classifier, which leans in-domain —
// but since #321 the classifier FAILS CLOSED, so a miss during a model outage is a decline.
// Coaching vocabulary belongs here.
const IN_DOMAIN_RE = new RegExp(
  [
    // training / movement (incl. exercise NAMES — 2026-07-16: 'show me a shoulder press'
    // was bounced as off-topic, twice; no gym word may ever leave the lane)
    "workout|train|training|gym|exercise|run(?:ning)?|walk(?:ing)?|steps?|cardio|lift(?:ing)?|weights?|reps?|\\bsets?\\b|squat|deadlift|bench|glute|abs\\b|core|stretch|mobility|rest day|recover|recovery|doms|sore|soreness|injur|\\bpain\\b|\\bform\\b|programme|routine|session|leg day|push day|pull day|\\bpress\\b|\\bcurl|\\brow\\b|\\braise\\b|lunge|plank|push.?up|pull.?up|pulldown|\\bfly\\b|\\bdip\\b|crunch|\\brdl\\b|kettlebell|dumbbell|barbell|\\bdemo\\b",
    // nutrition / food
    "\\beat|\\bate\\b|\\beating|food|meal|breakfast|lunch|dinner|supper|snack|protein|carbs?|calorie|kilojoule|\\bkj\\b|diet|nutrition|water|hydrate|shake|supplement|creatine|vitamin|\\bpap\\b|samp|morogo|pilchard|wors|braai|veg|fruit|sugar|craving|hungry|portion|shopping list|grocer|chicken|beef|mince|\\bfish\\b|\\begg|bread|rice|potato|afford|cheap",
    // body / health / state
    "weight|\\bkg\\b|\\d\\s?kgs?\\b|\\blos(?:e|ing)\\b|\\bgain(?:ing)?\\b|\\btoned?\\b|fitness|\\bin shape\\b|diabet|blood pressure|cholesterol|pregnan|\\bknee|\\bback\\b|\\bhurts?\\b|\\baches?\\b|ankle|wrist|shoulder|\\bhips?\\b|\\bneck\\b|elbow|\\bfoot\\b|\\bfeet\\b|\\blegs?\\b|\\barms?\\b|chest|headache|migraine|swell|swollen|sprain|bruis|\\bfell\\b|\\bfall(?:en)?\\b|dizz|faint|nause|vomit|cramp|\\bperiod\\b|\\bblood\\b|heart|breath|asthma|medic|doctor|clinic|hospital|symptom|scale|\\bbody\\b|\\bfat\\b|muscle|slim|belly|tummy|health|healthy|sick|\\bill\\b|\\bflu\\b|fever|exhaust|energy|sleep|stress|anxious|anxiety|mood|motivat|discourag|struggl|progress|result|goal|habit|consistent|consistency|streak|check.?in|measure|recomp",
    // coaching relationship / commands / journey pleasantries
    "coach\\b|how am i doing|how do i|feeling (?:down|low|sick|tired|good|great|better|worse|off)|hi\\b|hello|\\bhey\\b|yebo|sawubona|molo|dumela|avuxeni|thank|ngiyabonga|enkosi|dankie|good morning|log\\b|track\\b|\\bpay\\b|subscri|price|plan\\b|schedule|remind|programme",
    // budget / life situation (affects food + training, so always in-domain — a broke client's
    // money worry must never be cold-redirected: 2026-07-21 'I'm broke and I live in a township')
    "broke|township|\\bkasi\\b|ekasi|no money|can'?t afford|cannot afford|month.?end|payday|tight (?:on )?(?:money|budget)|shisa ?nyama|taxi rank|spaza",
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
  // A very short reply — even one padded with emoji/punctuation ("Read‼️‼️", "yes!!", "come on man")
  // — is a reaction in an ongoing coaching chat, NEVER an off-topic request. Cold-redirecting it
  // ("I'm Coach K, here for your fitness journey") on a frustrated one-word reply is a trust
  // breach (2026-07-21 live miss). Count real words, ignoring emoji/punctuation.
  //
  // FOUR, NOT TWO (2026-07-30 live). The threshold was 2 while the comment above it offered
  // "come on man" — three words — as the thing it caught. It never did. The founder, mid-argument
  // with the coach about a contradictory workout, sent "What the hell??" and got the brochure:
  // "I'm Coach K — I'm here for your health and fitness journey." Three words, so it missed by one.
  //
  // Raising it cannot refuse anybody: this gate only decides whether to SKIP the classifier and
  // answer normally. A genuine short off-topic ask ("write me a poem") still meets STAY IN YOUR
  // LANE in the coach prompt and is declined warmly, in context — which is the better decline.
  const words = (t.toLowerCase().match(/[a-z']+/g) || []);
  if (words.length <= 4) return true;
  // A CONVERSATIONAL CONTINUATION is never off-topic in an active coaching chat. A message that
  // refers back to something already discussed (them/it/that/those/these) or is a follow-up aimed
  // at the coach ("do better", "tell me more", "like what", "what about", "how should I take
  // them") is part of the ongoing conversation, not a fresh request. Redirecting these with the
  // cold "I'm Coach K" brochure is the worst kind of miss (2026-07-21 live: "how should I take
  // them? tell me!" got the redirect mid-snack-conversation). Pronoun-reference in a short message
  // = a continuation; fail-open to answering, per the whole guard's posture.
  if (words.length <= 12 && /\b(them|those|these)\b/i.test(t)) return true;
  if (/^(do better|tell me( more)?|like what|such as|what about|and then|then what|give me (more|another|other)|more (options|ideas|examples|of them)|any (others?|more)|how (do|should|can) i (take|have|eat|use|do) (them|it|that|those|these))\b/i.test(t)) return true;
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

export async function classifyDomain(
  openai: OpenAI, message: string, opts?: { ongoing?: boolean },
): Promise<DomainVerdict> {
  // A REQUEST, not a report that mentions a manager ("my manager is stressing me out" is coached, not handed off).
  if ((await import("../safety-detection")).detectEscalation(message).reason === "human_requested" && (await import("../utils")).isAskingNotReporting(message)) {
    return { classification: "out-of-domain", reasoning: "human requested: escalated by chat-log", redirectMessage: HUMAN_HANDOFF };
  }
  const ask = offDomainRedirect(message, opts?.ongoing);
  if (ask) return { classification: "out-of-domain", reasoning: "deterministic off-domain ask", redirectMessage: ask };
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
    if (word.startsWith("SAFETY")) return { classification: "safety", reasoning: "classifier: SAFETY" };
    if (word.startsWith("PART")) return { classification: "partially-related", reasoning: "classifier: PARTIALLY" };
    if (word.startsWith("YES")) return { classification: "in-domain", reasoning: "classifier: YES" };
    // NO, or a word we did not ask for: not an answer we can act on, so we do not answer.
    return { classification: "out-of-domain", reasoning: `classifier: ${word || "empty"}`, redirectMessage: opts?.ongoing ? REDIRECT_IN_CONVERSATION : REDIRECT };
  } catch (e) {
    // AN OUTAGE IS NOT A VERDICT (Codex @ c4ca8df). No vocabulary covers every language a South
    // African client writes in: "Ke opelwa ke tlhogo ebile ke a tsekela, what should I do?" is a
    // headache and dizziness, and declining it because a classifier timed out tells a client their
    // symptoms are outside the coach's remit. So when the gate cannot run, scope is what the code
    // decides deterministically (the off-domain asks above, declined on every path); the model's
    // own NO, and any verdict it was not asked for, still decline.
    return { classification: "in-domain", reasoning: "classifier unavailable — deterministic scope only: " + ((e as any)?.message || "error") };
  }
}

/** Spoke to us within the last day — the redirect must not introduce Coach K to them again. */
export function recentlyActive(user: { lastActiveAt?: Date | string | null } | null | undefined): boolean {
  const at = user?.lastActiveAt ? new Date(user.lastActiveAt).getTime() : NaN;
  return Number.isFinite(at) && Date.now() - at < 24 * 3600_000;
}

/**
 * THE ONE WAY A SCOPE DECLINE LEAVES (#321). Logged like the engine's own redirect, and marked
 * conversational so no coaching instruction is stapled under "that's outside what I can help with".
 */
export async function declineOutOfScope(
  userId: string, message: string, reply: string, evidence: (f: { conversationalOnly: true }) => void,
): Promise<string> {
  const { logChat } = await import("../handlers/chat-log"); // lazy — keeps the pure fast-path db-free
  await logChat(userId, message, reply, "DOMAIN_REDIRECT").catch(() => {});
  evidence({ conversationalOnly: true });
  return reply;
}
