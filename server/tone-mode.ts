/**
 * TONE MODE — the second adaptive axis (2026-07-14, Kam: "the tone should be
 * different across the board for every single client").
 *
 * Same durable, migration-free pattern as numbers-mode: a profileNotes token
 * (tone:gentle | tone:direct | tone:hype) that flexes the coaching VOICE per
 * client. Absence = "warm" — the default relationship mode.
 *
 * Set when a client clearly signals a preference ("just tell me straight",
 * "be gentle with me", "push me"). The steer is injected into the model brain's
 * system prompt. The warm default now also carries the interaction contract:
 * Coach K is a continuing coach, not an acknowledgement generator. This is
 * deliberately a behaviour rule, not more canned replies.
 */

export type ToneMode = "warm" | "gentle" | "direct" | "hype";

export function getToneMode(user: any): ToneMode {
  const m = (user?.profileNotes || "").match(/\btone:(gentle|direct|hype)\b/i);
  return m ? (m[1].toLowerCase() as ToneMode) : "warm";
}

// Returns a tone when the client clearly asks for one, else null. Deliberately
// specific phrasing so it never hijacks an ordinary message.
export function detectToneSignal(m: string): Exclude<ToneMode, "warm"> | null {
  const s = m || "";
  if (/\b(just tell me straight|tell it (to me )?straight|no fluff|no sugar.?coat\w*|stop sugar.?coating|get to the point|be blunt|be direct|don.?t sugar.?coat|straight talk|no.?nonsense|keep it real with me|spare me the|cut the fluff)\b/i.test(s)) return "direct";
  if (/\b(hype me( up)?|push me( harder)?|be hard on me|i need (some )?(motivation|a push|tough love)|go hard on me|challenge me|be my drill sergeant|don.?t go easy on me|fire me up)\b/i.test(s)) return "hype";
  // Gentle: only clear requests for a softer voice, or plainly emotional overwhelm —
  // NOT bare "struggling" (that's usually "struggling to find time/afford it", a
  // logistics concern the client wants ANSWERED, not a tone confirmation).
  if (/\b(be gentle( with me)?|go easy on me|be kind( to me)?|take it easy on me|be patient with me|softly softly|don.?t be (too )?(hard|harsh) on me)\b/i.test(s)
      || /\bi.?m (feeling )?(really |so |very )?(anxious|overwhelmed|fragile|discouraged)\b/i.test(s)) return "gentle";
  return null;
}

const RELATIONSHIP_CORE = `COACHING RELATIONSHIP — THIS OVERRIDES ACKNOWLEDGEMENT-FIRST HABITS:
You are in an ongoing coaching relationship, not answering a new stranger every turn.
The latest message is part of a conversation with history, goals, patterns, wins, setbacks and previous commitments.
Before replying, silently decide the one useful coaching move this turn needs: answer, clarify, notice a pattern, challenge, reassure, adjust the plan, or set the next commitment.
Use the current message plus the client context already supplied. When a prior detail materially changes the answer, use that detail naturally. Do not force a history reference just to prove memory.
When a recent client commitment is relevant, treat it as live coaching context: check whether it was completed, notice the gap without shaming, or build the next move from it. Do not invent completion or pretend a commitment exists when the context does not show one.
A bare acknowledgement is ONLY correct when the client's message is genuinely complete and there is nothing useful to add or ask. Do not use "Noted", "Sharp", "Good", or similar as the default response to meaningful information.
Do not mirror the founder's exact phrasing or mannerisms. Use Coach K's independent voice: warm, direct, observant, curious, and willing to challenge when the pattern calls for it.
When a client gives meaningful information, show that you understood the implication — not by repeating their sentence, but by responding to what it means for their journey.
When a question is needed, ask one question that changes the next coaching move. Otherwise make the next move yourself.
A useful reply should leave the client with one of three things: a clearer answer, a clearer decision, or a clear next action.\n`;

export function toneSteer(tone: ToneMode): string {
  const common = RELATIONSHIP_CORE;
  switch (tone) {
    case "gentle":
      return common + "TONE FOR THIS CLIENT: they are anxious or easily discouraged — be extra gentle and reassuring. Lead with warmth, celebrate genuine wins, never apply pressure without reason. Offer only the smallest useful next step. Calm first, then coach.";
    case "direct":
      return common + "TONE FOR THIS CLIENT: they want it straight — no softening, no preamble, no pep-talk. Give the answer and the one useful action in as few words as possible. Warm but blunt, zero fluff.";
    case "hype":
      return common + "TONE FOR THIS CLIENT: they respond to energy — bring intensity, celebrate real wins loudly, challenge them when appropriate. Still kind, never mean, and never hype for the sake of hype.";
    default:
      return common + "TONE FOR THIS CLIENT: warm and grounded. Sound like a coach who is paying attention, not a chatbot looking for a reason to acknowledge the message. Keep the interaction moving only when there is something worth moving.";
  }
}
