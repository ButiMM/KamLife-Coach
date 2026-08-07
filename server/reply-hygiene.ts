/**
 * REPLY HYGIENE — pure text cleanups that make the coach sound HUMAN, not robotic.
 *
 * (2026-07-22, Kam: "it's generic, it's robotic." The live screenshot: "Let me check your
 * meals again... One moment!" — a promise the bot literally cannot keep, because there is no
 * follow-up message. It answers NOW or it defers; it never stalls.) Enforced in code, not
 * left to a prompt line the model ignores. Pure — unit-tested in script/unit-tests.ts.
 */

// Unambiguous STALLS / dead promises: the bot has no channel to "come back" on, so these are
// always lies. High-precision so genuine phrasing survives ("let me break it down" is fine;
// "hold on to your progress" is fine — neither matches).
const DEAD_PROMISE_RE =
  /\b(one moment|just a (?:sec|second|moment)|give me (?:a (?:sec|second|moment|minute)|one (?:sec|second|moment))|bear with me|hang on a (?:sec|second|moment)|(?:i'?ll|let me|i will) (?:get|come) back to you|i'?ll look into (?:that|this|it)|let me look into (?:that|this|it) and (?:get|come) back|let me check[^.!?]*\band (?:get|come) back|checking (?:that|this|it) now|i'?ll be right back|i'?ll (?:check|find out|confirm)[^.!?]*and (?:let you know|get back|come back))\b/i;

/**
 * Drop every sentence matching `re`, KEEPING the whitespace between the sentences that stay.
 *
 * (2026-07-29 live — the single worst readability defect in the product.) Every filter here used
 * to `split(/(?<=[.!?])\s+/)` and rejoin with a space, which silently flattened every line break
 * in every AI reply. The model was writing a properly formatted numbered list; the client got one
 * unbroken paragraph — "1. *Rest:* … 2. *Nutrition:* … 3. *Hydration:* …" run together — which is
 * exactly the wall of text the founder and a real client both described as "too much".
 *
 * It also destroyed the "\n\n---\n\n" marker that splits a reply into separate WhatsApp bubbles,
 * so that mechanism had never once worked on an AI reply and the literal "---" was left inline.
 *
 * Splitting with a CAPTURING group keeps the original separators, so a filter can remove a
 * sentence without reformatting everything around it.
 */
/**
 * [sentence, separator, sentence, separator, …] — separators preserved so a caller can drop or
 * REPLACE one sentence without reformatting the reply around it. Exported because the provenance
 * gate rewrites individual sentences and must split them exactly the way this file does; a second
 * splitter would eventually disagree with this one about where a sentence ends.
 */
export function splitSentences(text: string): string[] {
  return (text || "").trim().split(/(?<=[.!?])(\s+)/);
}

function dropSentences(text: string, re: RegExp): string {
  const t = (text || "").trim();
  if (!t) return "";
  const parts = splitSentences(t); // [sentence, sep, sentence, sep, …]
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i];
    if (!sentence || re.test(sentence)) continue;
    out += sentence + (parts[i + 1] ?? "");
  }
  return out
    .replace(/[ \t]{2,}/g, " ")   // collapse runs of SPACES only — never newlines
    .replace(/\n{3,}/g, "\n\n")   // tidy gaps a removed sentence may have left
    .trim();
}

// Remove any SENTENCE that is a stall, keeping the rest of the reply intact. If the whole
// reply was a stall, returns "" — the caller's empty-reply handler then gives a real answer.
export function stripDeadPromises(text: string): string {
  return dropSentences(text, DEAD_PROMISE_RE);
}

// True if the reply contains a dead promise anywhere (for tests / guards).
export function hasDeadPromise(text: string): boolean {
  return DEAD_PROMISE_RE.test(text || "");
}

// CONTENT-FREE CORPORATE FILLER — the customer-service padding that makes it read like a bot,
// not like Kam (2026-07-22 live: "I appreciate your patience... I want to make sure we get
// this right for you."). These phrases carry ZERO coaching value; a real coach just answers.
// High-precision: genuine acknowledgement ("that's a tough week", "I hear you") is NOT here.
const FILLER_RE =
  /\b((?:i (?:really )?appreciate|thank you for|thanks for|i value) your patience|i appreciate you (?:being patient|bearing with me|reaching out|for (?:being )?patient)|thank you for reaching out|thanks for reaching out|i want to (?:make sure|ensure)[^.!?]*(?:get this right|for you|right for you)|i(?:'| a)m here to help(?: you)?(?: with (?:this|that|anything))?|rest assured|i understand your frustration|i (?:completely )?understand how you (?:feel|are feeling)|i.?m sorry for the (?:confusion|inconvenience))\b/i;

// Remove content-free filler SENTENCES, keeping the substance. Sibling to stripDeadPromises.
export function stripFiller(text: string): string {
  return dropSentences(text, FILLER_RE);
}

// ── THE NUMBERED LISTICLE ────────────────────────────────────────────────────────────────────
// The audit over 1988 real replies: 63 answered with a numbered list instead of coaching and 48
// were a wall of text — 111 of 166 defects, two thirds of everything wrong with this product.
//
// The Constitution ALREADY forbids it, in those words: "NEVER numbered markdown headings like
// '1. *Breakfast:*' — they render broken." The model ignored it sixty-three times, which is the
// whole reason this file exists: "Enforced in code, not left to a prompt line the model ignores."
//
// So the rule gets hands. An inline run of "1. … 2. … 3. …" becomes the bulleted short lines the
// Constitution asks for. This does not shorten the reply or change a word of its content — it
// makes what the coach already said readable on a phone, which is the complaint underneath every
// "it's too much" this product has received.
//
// Conservative on purpose: three or more markers before anything is touched, each must be a low
// single digit followed by a capital or a bold marker, and a decimal ("1.5kg") can never match.
const ENUM_MARKER = /(^|[^\d\n])([1-9])\.\s+(?=[A-Z*])/g;

export function reshapeNumberedList(text: string): string {
  const t = text || "";
  const markers = t.match(ENUM_MARKER);
  if (!markers || markers.length < 3) return t;
  return t
    .replace(ENUM_MARKER, (_m, before: string) => `${before.trimEnd()}\n• `)
    .replace(/\n• \s*/g, "\n• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── PLATITUDES ───────────────────────────────────────────────────────────────────────────────
// Advice so general it could go to a stranger: "listen to your body", "stay hydrated", "take it
// one day at a time", "you've got this". Any ONE of these can be honest — a hydration question
// deserves a hydration answer. TWO in one reply means nothing in it came from this client's data,
// which is exactly what "it's generic, it's a bot" has meant every time it has been said here.
//
// Constitution Law 3 already requires the opposite: "Remember the person, not the message —
// reference who they are and where they are." The model agreed and then wrote "keep drinking
// water" to a man with twenty years of training behind him. Same story as the numbered list:
// the law was real, the enforcement was not.
//
// ONE OWNER (2026-07-29). The audit scanner needs this list to COUNT platitudes and hygiene
// needs it to REMOVE them. Two copies of one idea is the defect this whole day has been about,
// so it is defined here and imported there.
export const PLATITUDES: RegExp[] = [
  /\blisten to your body\b/i,
  /\b(?:stay hydrated|drink (?:plenty of|more|lots of) water|keep drinking water|hydration is key)\b/i,
  /\btake it (?:one (?:day|step) at a time|slow|easy)\b/i,
  /\byou'?re not alone\b/i,
  /\byou'?(?:ve| have) got this\b/i,
  /\bbe (?:kind|gentle) (?:to|with) yourself\b/i,
  /\b(?:gentle movement|light stretching|gentle stretches)\b/i,
  /\bdon'?t (?:rush|push too hard|overdo it)\b/i,
  /\bget (?:enough|plenty of) (?:rest|sleep)\b/i,
  /\blet me know how you feel\b/i,
];

/** How many pieces of stranger-advice are in this reply. Two or more is the defect threshold. */
export function platitudeCount(text: string): number {
  return PLATITUDES.filter(re => re.test(text || "")).length;
}

/**
 * Remove platitude SENTENCES — but only once a reply has two or more, so a single honest
 * "drink plenty of water" survives in an answer that is genuinely about water.
 *
 * This makes a generic reply shorter and less bot-like. It does NOT make it personal: only the
 * engine using the client's real snapshot can do that. Removing what is empty is worth doing on
 * its own, and pretending it is the whole fix would be the same overreach as every prompt line
 * that told the model to be specific and was ignored.
 */
/**
 * A PLATITUDE IS A CLAUSE, NOT A SENTENCE (2026-07-30, found by running a real defective reply
 * through the pipeline instead of trusting it).
 *
 * This used to drop the whole sentence. That was survivable while it reached one caller and
 * mostly prose. The moment hygiene ran on every reply it started eating coaching: a real bullet,
 * "*Finish Strong:* Complete your workout, but listen to your body", lost the instruction along
 * with the platitude — the client was told to refuel and never told to train.
 *
 * So the platitude phrase is cut out and what the coach actually said is kept. Only when nothing
 * of substance is left does the line go entirely.
 */
const SUBSTANCE_MIN_CHARS = 18;

export function stripPlatitudes(text: string): string {
  if (platitudeCount(text) < 2) return text || "";
  const re = new RegExp(PLATITUDES.map(r => r.source).join("|"), "gi");
  const parts = splitSentences((text || "").trim());
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i];
    const sep = parts[i + 1] ?? "";
    if (!sentence) continue;
    re.lastIndex = 0;
    if (!re.test(sentence)) { out += sentence + sep; continue; }
    // Cut the phrase, then tidy the connective it was hanging off ("…, but ", "…, and ").
    const residue = sentence
      .replace(new RegExp(re.source, "gi"), "")
      .replace(/[ \t]*[,;]?[ \t]*\b(?:but|and|so|then|also|plus)\b[ \t]*(?=[.!?]|$)/gi, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+([.!?,])/g, "$1")
      .replace(/^[\s,;:—-]+/, "")
      .replace(/[\s,;:]+([.!?])/, "$1")
      .trim();
    // Strip leading bullet/bold scaffolding before judging whether anything survived.
    // Order matters: take the bullet marker FIRST but never the asterisk, or the bold label's
    // opening "*" is consumed and the label survives into the substance count.
    const meat = residue
      .replace(/^\s*[•\-]\s*/, "")
      .replace(/^\*[^*]{0,40}\*:?\s*/, "")
      .replace(/^[•\-*\s]+/, "")
      .trim();
    // Nothing left worth sending: too short, or a dangling fragment. A residue that opens with a
    // preposition ("through the session") is what remains when the platitude WAS the instruction —
    // it is not coaching, it is wreckage, and it reads worse than saying nothing.
    const isFragment = /^(?:through|with|for|in|at|on|by|from|during|to|of|and|but|so)\b/i.test(meat);
    if (isFragment || meat.replace(/[^A-Za-z]/g, "").length < SUBSTANCE_MIN_CHARS) continue;
    out += residue + sep;
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// ── THE WALL OF TEXT ─────────────────────────────────────────────────────────────────────────
// (2026-07-30.) The single most common live defect: 6 of the last 16. A reply that is four or
// five sentences long with no line break in it is a paragraph, and nobody reads a paragraph on a
// phone. The content is often right — this is not a thinking failure, it is a typography one.
//
// A real coach on WhatsApp sends short blocks. So a long unbroken run gets broken at a sentence
// boundary, roughly every two sentences. Nothing is added, removed or reworded; only where the
// newlines fall changes. Deliberately conservative: short replies and anything that already has
// line breaks or bullets are left exactly as they are.
const WALL_MIN_CHARS = 220;

export function breakWallOfText(text: string): string {
  const t = (text || "").trim();
  if (t.length < WALL_MIN_CHARS || t.includes("\n")) return t;
  const parts = splitSentences(t);
  const sentences: string[] = [];
  for (let i = 0; i < parts.length; i += 2) if (parts[i]) sentences.push(parts[i]);
  if (sentences.length < 3) return t;
  const blocks: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) blocks.push(sentences.slice(i, i + 2).join(" "));
  return blocks.join("\n\n");
}

// The full humanize pass — strip stalls AND corporate filler in one go. This is what
// sanitizeCoachReply calls, so every AI reply gets to the point like a real coach.
export function humanizeReply(text: string): string {
  return dropOrphanFragment(breakWallOfText(normaliseBullets(stripPlatitudes(reshapeNumberedList(stripFiller(stripDeadPromises(text)))))));
}

/**
 * THE ORPHANED FRAGMENT (2026-08-05, live: "…You're doing great on tracking! specific. 👌").
 *
 * "specific." is not a sentence. It is the tail of one — the head of it was either cut by a
 * token limit or removed by one of the passes above, and what survived reads as gibberish
 * stapled to a good reply. Chasing which pass produced it is whack-a-mole; every one of them
 * can leave a tail, and so can the model.
 *
 * So this is a DOOR rule, not a producer rule: if the last sentence is one or two words, starts
 * lowercase, and something complete came before it, it is debris and it goes.
 *
 * Deliberately narrow. It requires a preceding sentence, so a whole reply of "Noted 👌" or
 * "Solid 👌" — which is a complete and very good reply — is never touched. Trailing emoji ride
 * along with whatever they were attached to rather than being orphaned themselves.
 */
export function dropOrphanFragment(text: string): string {
  const t = (text || "").trim();
  if (!t) return t;
  const lines = t.split("\n");
  const last = lines[lines.length - 1].trim();
  // Split the final line into sentences; only its TAIL can be an orphan.
  const parts = last.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length < 2) return t;
  // A trailing emoji splits into its OWN part ("specific." then "👌"), so the orphan is not
  // always last. Walk back past any emoji-only tail to find the real final sentence, and carry
  // those emoji forward — they belong to the reply, not to the debris.
  let end = parts.length - 1;
  const trailingEmoji: string[] = [];
  while (end >= 0 && !/[\p{L}\p{N}]/u.test(parts[end])) { trailingEmoji.unshift(parts[end]); end--; }
  if (end < 1) return t;                       // nothing complete before it → leave it alone
  const tail = parts[end];
  const words = tail.replace(/[^\p{L}\p{N}\s']/gu, " ").trim().split(/\s+/).filter(Boolean);
  const startsLower = /^[a-z]/.test(tail);
  if (words.length > 0 && words.length <= 2 && startsLower) {
    const kept = parts.slice(0, end).join(" ").trim();
    const emoji = [tail.replace(/[\p{L}\p{N}\s.'!?,]/gu, "").trim(), ...trailingEmoji].filter(Boolean).join(" ").trim();
    lines[lines.length - 1] = emoji ? `${kept} ${emoji}`.trim() : kept;
    return lines.join("\n").trim();
  }
  return t;
}

/**
 * A bullet always starts a line. Removing a platitude can take the line break before the NEXT
 * bullet with it, which left "…recovering from the illness. • *Ease Back In:*" running inline —
 * the same unreadability the reshape exists to prevent, reintroduced by a later step.
 */
function normaliseBullets(text: string): string {
  return (text || "").replace(/([^\n])[ \t]*• /g, "$1\n• ").replace(/\n{3,}/g, "\n\n").trim();
}

// ── THE VOICE-NOTE DENIAL ────────────────────────────────────────────────────────────────────
// (2026-07-29 live, and the worst thing this product has produced.) A client sent a voice note.
// It transcribed PERFECTLY. The reply printed that transcript — "🎤 I heard: …" — and directly
// underneath said:
//
//     "Eish, Kam, I'm really sorry about that. I didn't catch the voice note.
//      Could you please repeat what you need here in text?"
//
// It caught the voice note. The proof was in the same message. It denied its own working
// feature and asked a frustrated person to do the work again, in the format they were avoiding.
//
// The cause is structural: the voice path transcribes, then re-enters handleMessage with the
// TEXT only, so nothing downstream knows a voice note existed. A client complaining that their
// voice note was ignored therefore looks, to the model, like a report that the voice note
// failed — and it apologises for a failure that did not happen.
//
// This is the one place where the lie is provably a lie, because we are holding the transcript.
// Both halves must go: the denial, AND the request to type it out — we already have the words.
const VOICE_DENIAL_RE =
  /\b(?:i\s*(?:did\s*n.?t|could\s*n.?t|can'?t|cannot|was\s*n.?t able to)\s*(?:quite\s+|really\s+)?(?:catch|get|hear|receive|make out|pick up|access|process|listen to)\b[^.!?]*\b(?:voice|audio|note|recording|message)|(?:voice note|audio|recording)[^.!?]{0,30}\b(?:did\s*n.?t|has\s*n.?t|was\s*n.?t)\s+(?:come through|arrive|download|register))\b/i;

/** Asking them to say it again — in any form — when the transcript is already in our hands. */
const ASK_TO_REPEAT_RE =
  /\b(?:(?:could|can|would) you (?:please )?(?:repeat|resend|send)\b[^.!?]*|(?:please )?(?:repeat|resend|send|say) (?:it|that|what you need)\b[^.!?]*|type (?:it|that|your message)\b[^.!?]*)(?:again|here|in text|as text|by text)\b/i;

/**
 * Remove any SENTENCE that denies receiving the voice note, or asks them to send it again.
 * Returns "" when the whole reply was denial — the caller then supplies a real answer, exactly
 * like stripDeadPromises. Pure; the caller decides the fallback.
 */
export function stripVoiceDenial(text: string): string {
  return dropSentences(text, new RegExp(`${VOICE_DENIAL_RE.source}|${ASK_TO_REPEAT_RE.source}`, "i"));
}

/** True if the reply denies a voice note we demonstrably received (for guards and the auditor). */
export function deniesVoiceNote(text: string): boolean {
  return VOICE_DENIAL_RE.test(text || "") || ASK_TO_REPEAT_RE.test(text || "");
}

// ── THE DOOR (2026-08-04) ────────────────────────────────────────────────────
// The inbound side was 29 handlers each with an opinion. The outbound side has
// appenders — a tag appender, a menu appender — and nobody owned the last
// hundred milliseconds before a message leaves. Provenance checks whether it is
// TRUE. Hygiene checks whether it is SHAPED like a person. Neither asks: is this
// internal? have we already said exactly this?

/** Instrumentation markers (`_· 🧠 new engine ·_`) belong in the log row, never in a body. */
export function stripInternalMarkers(text: string): string {
  return (text || "")
    .replace(/^[ \t]*_?·[^\n]*·_?[ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// OUTBOUND DEDUPE. Live, in the founder's chat: two different messages produced the
// identical reply back to back — the second was pure noise and read as a broken machine.
// Whatever upstream bug produces a repeat, saying the same words twice in ten minutes is
// never the right outcome, so the door refuses it. Compares on normalised text so a
// changed timestamp or stray space still counts as the same thing said again.
const _lastSent = new Map<string, { body: string; at: number }>();
export const DEDUPE_WINDOW_MS = 10 * 60_000;

export function normaliseForDedupe(text: string): string {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** True → this exact reply already went to this client moments ago. Do not send it again. */
export function isDuplicateOutbound(userKey: string, body: string, at = Date.now()): boolean {
  const key = userKey || "?";
  const norm = normaliseForDedupe(body);
  if (!norm) return false;
  const prev = _lastSent.get(key);
  const dup = !!prev && prev.body === norm && at - prev.at < DEDUPE_WINDOW_MS;
  if (!dup) {
    _lastSent.set(key, { body: norm, at });
    if (_lastSent.size > 5000) _lastSent.clear();
  }
  return dup;
}

/** Test/ops hook. */
export function _resetOutboundDedupe(): void { _lastSent.clear(); }

// ONE SENTENCE, SPOKEN. A voice reply that reads the whole coaching message aloud costs
// twice — once in TTS, once in the client's patience — and you cannot scroll back through
// audio. The voice says the headline; the text underneath carries the detail.
export function firstSentence(text: string): string {
  const t = (text || "").trim();
  const cut = t.search(/[.!?](\s|$)/);
  const one = cut > 0 ? t.slice(0, cut + 1) : t.split("\n")[0];
  return one.trim().slice(0, 240);
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE NEVER-SILENT LINE (2026-08-04, Slice 4)
 *
 * ONE fallback for the whole product. This is the third and last mouth the architecture
 * allows — the engine, the crisis pre-layer, and this.
 *
 * It exists for the moment the engine did not write a sentence: the model timed out, the
 * key is wrong, OpenAI is down, or the turn fell to a deterministic handler. Before Slice 4
 * that moment was covered by thirty handlers each holding their own voice, which is how a
 * client who walked 5,000 steps got four sentences, an invented "~237 kcal burned", a
 * 7-day average, a streak note and a Coke comparison — none of which they asked for, all of
 * which were written by machinery pretending to be a coach.
 *
 * The rules it obeys are the voice rules, because a fallback that breaks them just moves
 * the disease: ONE sentence, their number exactly as they gave it, their words, no running
 * total, no target, no next move it has not earned the right to give.
 *
 * It is deliberately plain. A fallback should sound like a coach who is busy, not like a
 * coach who is absent — and never like a till slip.
 * ──────────────────────────────────────────────────────────────────────────── */

export type LoggedKind = "steps" | "water" | "weight" | "meal" | "workout" | "sleep";

/**
 * @param label the client's OWN words for the thing, when there are any ("pap and chicken").
 *        Never a database name, never a portion in brackets — that is voice rule 18.
 * @param amount the figure THEY gave, already formatted. Never recomputed, never rounded.
 */
export function neverSilentLine(kind: LoggedKind, opts: { label?: string; amount?: string; carryingShame?: boolean } = {}): string {
  const label = (opts.label || "").trim().slice(0, 60);
  const amount = (opts.amount || "").trim();
  // CHEAT, NO SHAME (voice rule 9) — and deterministic on purpose. Someone who writes "I feel
  // like I ruined everything" needs the second half of this sentence whether or not the model
  // answered that turn, and the model is exactly what is missing when this function runs. The
  // words already existed in food-context as a guilt note and never reached the log path.
  if (kind === "meal" && opts.carryingShame) {
    return label
      ? `Got it — ${label}. One meal doesn't break a week. 👌`
      : `Got it. One meal doesn't break a week. 👌`;
  }
  switch (kind) {
    case "steps":   return amount ? `${amount} steps — nice one. 👌` : `Steps logged. 👌`;
    case "water":   return amount ? `${amount} of water — good. 👌` : `Water logged. 👌`;
    case "weight":  return amount ? `${amount} — noted. 👌` : `Weight noted. 👌`;
    case "meal":    return label ? `Got it — ${label}. 👌` : `Got it. 👌`;
    case "workout": return `Session logged — well done. 💪`;
    case "sleep":   return amount ? `${amount} of sleep — noted. 👌` : `Sleep noted. 👌`;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * TELL THEM, DON'T ASK THEM (2026-08-06).
 *
 * Seven replies in a row ended in a question: "What's your plan for meals today?" "What do you
 * have at home?" "What do you prefer?" "What do you think?" "What do you think?" "What do you
 * want to tackle first?" The founder's answer: "People don't wanna think. People wanna be told
 * what to do, how to do it, when to do it."
 *
 * The prompt has forbidden this since July — «never end it with "What do you think?", never
 * hand back a menu, never ask them to choose». It was ignored anyway, which is the lesson of
 * the whole rebuild: a rule that lives only in the prompt is a suggestion. The rules that hold
 * on his phone today are the ones a test enforces.
 *
 * So this enforces it. A trailing question is REPLACED by the computed next move — never
 * merely deleted, because a reply that stops dead is worse than one that asks. When there is
 * genuinely no move to give, an open question is left alone: a coach who needs one fact to
 * answer properly should ask for that fact.
 *
 * Only the LAST sentence is touched. A question in the middle of a reply is usually the coach
 * making a point ("Know what actually stalls this?"), and rewriting that would break the voice
 * this whole sweep exists to protect.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The closing questions that hand the work back to the client. */
const HANDBACK_QUESTION = /\b(what do you think|what.?s your plan|what are you (?:planning|having|going to have)|what do you (?:want|prefer|fancy|have at home|feel like)|how does that (?:sound|look)|does that (?:work|sound good)|shall we|would you like|which (?:one )?(?:do you|would you)|what (?:should|shall) we|sound good|let me know what|tell me what you)\b[^.!?]*\?\s*$/i;

/**
 * Replace a hand-back question at the end of a reply with the instruction the coach computed.
 *
 * @param nextMove the output of theNextMove() — "" when there is genuinely nothing to instruct,
 *        in which case the question survives untouched.
 */
export function tellDontAsk(text: string, nextMove: string): string {
  const t = (text || "").trim();
  if (!t || !nextMove.trim()) return text;
  if (!HANDBACK_QUESTION.test(t)) return text;

  const parts = splitSentences(t); // [sentence, sep, sentence, sep, …]
  // Walk back to the last sentence carrying actual words, and drop it if it is the hand-back.
  for (let i = parts.length - 1; i >= 0; i -= 2) {
    const idx = parts[i] !== undefined && parts[i].trim() ? i : i - 1;
    if (idx < 0 || !parts[idx] || !parts[idx].trim()) continue;
    if (!HANDBACK_QUESTION.test(parts[idx].trim() + (parts[idx + 1] || ""))) break;
    const kept = parts.slice(0, idx).join("").trim();
    const move = nextMove.trim().replace(/\.\s*$/, "");
    return kept ? `${kept}\n\n${move}.` : `${move}.`;
  }
  return text;
}

/**
 * Does this reply tell them anything to DO? Used by the test suite rather than at runtime —
 * a reply that neither instructs nor answers a question is the calculator behaviour.
 */
export function endsWithHandback(text: string): boolean {
  return HANDBACK_QUESTION.test((text || "").trim());
}
