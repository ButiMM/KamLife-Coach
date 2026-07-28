/**
 * LIFE CONTEXT — what a coach does when someone brings their life, not their macros.
 *
 * (2026-07-27 evening, founder: "It's too narrow, man. All I'm getting every single day —
 * people going through illnesses, people going through this and that. They want some sort of
 * comfort. We really need to do better on that.")
 *
 * The first pass covered three things: low mood, drinking instead of eating, disordered eating.
 * That was the clinical edge, and the clinical edge is the rare case. The COMMON case is a
 * person having a hard week — a funeral, a retrenchment, a sick child, a divorce, night shifts,
 * a diagnosis — who tells their coach because their coach is the one who asks how they are.
 * Answering that with a protein target is how you lose someone for good.
 *
 * Two rules hold this together, and they are what keep us on the right side of the law:
 *
 *   1. COMFORT IS NOT TREATMENT. We acknowledge, we lighten the load, we keep the door open.
 *      We never diagnose, never name a condition, never advise on medicine or treatment, never
 *      tell anyone what their symptoms mean. Anything medical belongs to their doctor and we say
 *      so plainly — that is the whole compliance posture: a lifestyle coach, nothing more.
 *   2. THE PRODUCT RESPONDS, NOT JUST THE WORDS. Real comfort from a coach is fewer demands,
 *      not a nicer sentence. Each context says what happens to the programme — pause it, drop
 *      the targets, keep only the smallest habit — because that is help a human can feel.
 *
 * Pure — no DB, no clock, no model. Unit-tested.
 */

export type LifeContext =
  // Clinical edge — refer, and mean it.
  | "crisis_adjacent"        // sustained hopelessness (below self-harm, which safety.ts owns)
  | "disordered_eating"
  | "alcohol_coping"
  // Hard life — comfort, lighten the load, no referral needed unless they ask.
  | "bereavement"
  | "own_illness"
  | "family_illness"         // includes caregiving
  | "job_or_money"
  | "relationship"
  | "burnout"
  | "loneliness"
  | "anxious"
  | "overwhelmed";

export interface ContextRead {
  context: LifeContext;
  /** Clinical edge → we name a helpline. Hard life → we don't, unless they ask. */
  refer: boolean;
  /** What happens to targets and the programme. This is the part they actually feel. */
  demand: "pause" | "lighten" | "keep";
}

const P: Array<{ re: RegExp; context: LifeContext; refer: boolean; demand: ContextRead["demand"] }> = [
  // ── Clinical edge — ordered first, most serious wins ───────────────────────────────
  {
    context: "disordered_eating", refer: true, demand: "pause",
    re: /\b(?:make\s+myself\s+(?:sick|throw\s+up|vomit)|purge|purging|binge(?:ing|d)?\s+(?:and|then)\s+(?:purg|starv)|starv(?:e|ing)\s+myself|laxatives?\s+to\s+lose|not\s+eaten\s+(?:in|for)\s+(?:\d+\s+|a\s+few\s+)?days?)\b/i,
  },
  {
    context: "alcohol_coping", refer: true, demand: "pause",
    re: /\b(?:only|just|all)\s+(?:thing\s+)?(?:i'?ve\s+|i\s+)?(?:had|ate|eaten|having|drink|drinking|drunk)\b[^.!?]{0,30}\b(?:alcohol|beer|beers|wine|vodka|brandy|whisky|gin|booze)\b|\b(?:drinking|drink)\s+(?:instead\s+of\s+eating|to\s+cope|to\s+forget|to\s+numb|every\s+(?:day|night)|alone)\b|\bcan'?t\s+stop\s+drinking\b/i,
  },
  {
    context: "crisis_adjacent", refer: true, demand: "pause",
    re: /\b(?:i(?:'?m| am)|been|feeling)\s+(?:really\s+|so\s+|honestly\s+|very\s+|quite\s+|just\s+)?(?:depressed|hopeless|worthless|numb|empty)\b|\bcan'?t\s+(?:get\s+out\s+of\s+bed|face\s+the\s+day|cope|go\s+on|do\s+this\s+any\s?more)\b|\bno\s+(?:point|reason)\s+(?:in\s+)?(?:any\s?more|to\s+anything)\b|\bnothing\s+matters\b|\bbreaking\s+down\b|\bfalling\s+apart\b/i,
  },

  // ── Hard life — the common case ───────────────────────────────────────────────────
  {
    context: "bereavement", refer: false, demand: "pause",
    re: /\b(?:passed\s+away|passed\s+on|funeral|buried|burial|memorial|lost\s+my\s+(?:mother|mom|mum|father|dad|brother|sister|child|son|daughter|husband|wife|partner|gogo|granny|grandmother|grandfather|friend|aunt|uncle|cousin)|died|death\s+in\s+the\s+family|mourning|grieving|tombstone\s+unveiling)\b/i,
  },
  {
    context: "own_illness", refer: false, demand: "pause",
    re: /\b(?:in\s+hospital|hospitalised|hospitalized|admitted\s+to\s+hospital|had\s+(?:an?\s+)?(?:operation|surgery|procedure)|recovering\s+from\s+(?:surgery|an\s+operation)|been\s+diagnosed|just\s+diagnosed|test\s+results|on\s+treatment|chemo|dialysis|bed\s?rest|doctor\s+booked\s+me\s+off|signed\s+off\s+(?:sick|by\s+the\s+doctor))\b/i,
  },
  {
    context: "family_illness", refer: false, demand: "lighten",
    re: /\b(?:my\s+(?:mother|mom|mum|father|dad|child|son|daughter|husband|wife|partner|gogo|granny|brother|sister)\s+(?:is\s+)?(?:sick|ill|in\s+hospital|not\s+well|dying|diagnosed))\b|\b(?:looking\s+after|caring\s+for|taking\s+care\s+of)\s+(?:my\s+)?(?:sick|ill|elderly|dying)\b|\bcaregiver\b|\bmy\s+kid\s+is\s+(?:sick|ill|in\s+hospital)\b/i,
  },
  {
    context: "job_or_money", refer: false, demand: "lighten",
    re: /\b(?:lost\s+my\s+job|retrenched|retrenchment|laid\s+off|got\s+fired|no\s+income|can'?t\s+afford\s+food|no\s+money\s+for\s+food|broke\s+until\s+(?:pay\s?day|month\s?end)|financial(?:ly)?\s+(?:stress|strain|struggling)|debt\s+is\s+(?:killing|drowning)|load\s?shedding\s+(?:killed|ruined)\s+my)\b/i,
  },
  {
    context: "relationship", refer: false, demand: "lighten",
    re: /\b(?:getting\s+divorced|divorce|separated\s+from\s+my|broke\s+up|breakup|break-?up|my\s+(?:marriage|relationship)\s+is\s+(?:over|ending|falling\s+apart)|he\s+left\s+me|she\s+left\s+me|custody)\b/i,
  },
  {
    context: "burnout", refer: false, demand: "lighten",
    re: /\b(?:burnt?\s?out|burning\s+out|running\s+on\s+empty|no\s+energy\s+left|exhausted\s+all\s+the\s+time|double\s+shifts?|night\s+shifts?\s+are\s+killing|working\s+(?:non-?stop|seven\s+days)|haven'?t\s+slept\s+(?:properly\s+)?in\s+(?:weeks|days))\b/i,
  },
  {
    context: "anxious", refer: false, demand: "lighten",
    re: /\b(?:anxiety|anxious|panic\s+attacks?|can'?t\s+stop\s+worrying|constantly\s+worried|on\s+edge\s+all\s+the\s+time)\b/i,
  },
  {
    context: "loneliness", refer: false, demand: "lighten",
    re: /\b(?:so\s+lonely|feel\s+alone|no\s+one\s+to\s+talk\s+to|nobody\s+(?:cares|checks\s+on\s+me)|doing\s+this\s+(?:all\s+)?(?:alone|on\s+my\s+own)\s+and\s+it'?s\s+hard|isolated)\b/i,
  },
  {
    context: "overwhelmed", refer: false, demand: "lighten",
    re: /\b(?:too\s+much\s+going\s+on|everything\s+is\s+(?:falling\s+apart|too\s+much)|drowning|can'?t\s+keep\s+up\s+with\s+life|life\s+is\s+(?:hectic|chaos|a\s+mess)\s+right\s+now|so\s+much\s+on\s+my\s+plate)\b/i,
  },
];

// Ordinary coaching talk that must NEVER be diverted — "depressed about my weight" is a
// coaching moment, "I'm depressed" is not; "sick of pap" is a food preference.
const ORDINARY = /\b(?:depressed|down|sad|anxious)\s+(?:about|by|with)\s+(?:my|the|these)\s+(?:weight|scale|progress|numbers|belly|results|body\s+fat)\b|\bsick\s+(?:and\s+tired\s+)?of\s+(?:pap|chicken|rice|eating|the\s+same)\b|\bkilling\s+(?:my\s+)?(?:legs|arms|quads|calves)\b|\bdying\s+after\s+(?:that|the)\s+(?:session|workout|set)\b/i;

/** Read a message for life context. Null = ordinary coaching; handle it normally. */
export function readLifeContext(message: string): ContextRead | null {
  const s = (message || "").trim();
  if (!s) return null;
  if (ORDINARY.test(s)) return null;
  for (const p of P) {
    if (p.re.test(s)) return { context: p.context, refer: p.refer, demand: p.demand };
  }
  return null;
}

const SADAG = `*SADAG* — 0800 567 567, free, 24 hours. Or SMS 31393 and they'll call you back.`;

/**
 * What the coach says. Warm, short, human, and never a diagnosis.
 *
 * COMPLIANCE, deliberately: no reply below names a condition, interprets a symptom, mentions
 * medicine, or suggests a treatment. Anything medical is handed to their doctor in one line.
 * We are a lifestyle coach and every one of these sentences has to be defensible as that.
 */
export function lifeContextReply(read: ContextRead, firstName = ""): string {
  const fn = firstName ? `${firstName}, ` : "";
  const door = `Nothing is expected of you here. When you're ready — one meal, one walk — tell me and I'll pick it up from there. No catching up, no lost progress.`;

  switch (read.context) {
    case "disordered_eating":
      return `${fn}I'm glad you told me.\n\nThat's beyond what a coach should be handling, and putting targets on top of it would do you harm. It needs someone properly trained.\n\n${SADAG}\n\nI'm pausing your numbers — no calorie targets, no weigh-ins from me. Your body isn't the problem to solve right now.`;

    case "alcohol_coping":
      return `${fn}thank you for saying that out loud — most people don't.\n\nI'll be straight: that's not something I can coach you out of, and pretending I could would waste your time. There are people who genuinely handle it.\n\n${SADAG}\n\nI'm still here for the ordinary stuff. ${door}`;

    case "crisis_adjacent":
      return `${fn}that's a heavy thing to be carrying, and I'm not going to hand you a protein target and pretend it helps.\n\nI'm good for the food, the training and the showing up. What you're describing sits outside that, and the people who do handle it are one free call away:\n\n${SADAG}\n\n${door}`;

    case "bereavement":
      return `${fn}I'm so sorry. 💛\n\nThere's nothing about food or training that matters this week, and I'm not going to pretend otherwise.\n\nI've paused everything — no targets, no check-ins, no streak to lose. Be with your people.\n\nWhen you're ready, say *back* and we start gently. Not before.`;

    case "own_illness":
      return `${fn}sorry to hear that — that's a lot to deal with. 💛\n\nYour doctor guides anything to do with your health and treatment; I won't get in the way of that. What I'll do is take the fitness pressure off completely.\n\nEverything's paused — no targets, no sessions, no streak to lose. Rest is the work right now.\n\nWhen your doctor's happy for you to start moving again, say *back* and we'll build up slowly.`;

    case "family_illness":
      return `${fn}that's hard, and looking after someone takes everything you've got. 💛\n\nI've dropped your targets right down — no sessions expected, no streak to protect.\n\nOne thing only, and it's for you not the programme: try to eat something proper each day. People caring for someone else forget to. Send me one line when you do and I'll keep an eye out for you.`;

    case "job_or_money":
      return `${fn}that's real stress and it doesn't belong in a fitness app's blind spot. 💛\n\nI've eased your targets off — nothing to fail at while you sort this out.\n\nIf money's tight, tell me your budget and I'll build the cheapest food plan that still does the job — eggs, pilchards, amasi, pap, cabbage. Eating well on very little is something I'm genuinely good at.`;

    case "relationship":
      return `${fn}I'm sorry — that's exhausting in a way people underestimate. 💛\n\nTargets are eased off. No streak to lose, nothing to catch up.\n\nWhen you feel like moving, a walk does more for your head than a hard session right now. Say the word and I'll keep it light.`;

    case "burnout":
      return `${fn}that's your body telling you something, and pushing harder isn't the answer. 💛\n\nI've dropped your sessions right back — lighter, shorter, and nothing lost by doing so.\n\nProtect two things only this week: eat properly, and sleep when you can. The training will still be here.`;

    case "anxious":
      return `${fn}thanks for telling me. 💛\n\nI'm a coach, not a therapist — I won't pretend to be one. But I'll keep this simple so it's one less thing on your mind: targets eased, no streak to lose.\n\nWalking genuinely helps more than most people expect. If you want someone properly trained to talk to, ${SADAG}`;

    case "loneliness":
      return `${fn}I'm glad you said something. 💛\n\nFor what it's worth, you're not doing this on your own — I'm here every day, and I do notice when you go quiet.\n\nTargets eased off this week. Message me whenever, about anything. It doesn't have to be food.`;

    case "overwhelmed":
      return `${fn}right — let's take things off your plate, not add to it. 💛\n\nEverything's eased off. Forget the targets this week.\n\nOne thing only: eat something proper once a day and tell me. That's the whole job until life calms down.`;
  }
}

/** Does this context stop targets/numbers being pushed at them? */
export function pausesTargets(read: ContextRead): boolean {
  return read.demand === "pause";
}

/** Should routine nudges go quiet? Any life context earns quiet — nobody wants a water tip today. */
export function quietDays(read: ContextRead): number {
  return read.demand === "pause" ? 7 : 3;
}
