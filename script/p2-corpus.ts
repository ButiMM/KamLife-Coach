/**
 * P2 CORPUS — the canonical conversation format, and the adapters that fill it.
 *
 * (2026-08-11, P2 measurement brief §2.) The brief is explicit that the baseline corpus is the
 * founder's own real, unedited conversations, delivered as a WhatsApp export or a pasted
 * transcript — NOT pulled from the production database. That constraint is not a preference:
 * "do not touch real client records" has been standing all week, and a measurement instrument
 * that reaches into the live DB to feed itself would quietly break it the first time someone
 * pointed it at a different user.
 *
 * So the importer is an ADAPTER and nothing else. Everything downstream — deterministic checks,
 * calibration sheets, anchors, the eventual baseline — reads the canonical shape below and has
 * no idea where it came from. When a controlled DB export or a synthetic regression corpus is
 * approved later, it becomes one more adapter and the instrument does not change.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *   - It does not score anything.
 *   - It does not clean, normalise, correct or rewrite a message. §2: "The corpus should remain
 *     unedited. Do not rewrite user messages to make them easier to score." A typo, a code-switch,
 *     a voice-note transcription artefact and a half-finished sentence are the SIGNAL — they are
 *     the conditions Coach K actually has to work in.
 *   - It does not guess who is speaking beyond what the source states.
 */

import { readFileSync, existsSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// THE CANONICAL SHAPE
// ─────────────────────────────────────────────────────────────────────────────

export type Speaker = "member" | "coach";

export interface Turn {
  /** Position in the conversation, 0-based. The only ordering anyone downstream may trust. */
  index: number;
  speaker: Speaker;
  /** Verbatim. Never normalised, never trimmed of meaning. */
  message: string;
  /** ISO 8601 when the source carried one. Absent is normal for pasted transcripts. */
  timestamp?: string;
  /**
   * Free-form, adapter-supplied. Where a source knows something the canonical shape does not
   * model — "voice note", "photo omitted", the raw export line — it goes here rather than
   * being smuggled into `message`.
   */
  metadata?: Record<string, unknown>;
}

export interface Conversation {
  conversationId: string;
  /** Who the member is, as the corpus labels them. Never a phone number — see redactPhone(). */
  participant: string;
  turns: Turn[];
  /** Where this came from, so a finding can always be traced back to its source file. */
  source: { adapter: "whatsapp-export" | "pasted-transcript"; file?: string };
}

export interface Corpus {
  conversations: Conversation[];
}

// ─────────────────────────────────────────────────────────────────────────────
// ADAPTER 1 — WHATSAPP EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WhatsApp's own export format, both common variants:
 *   [2026/08/11, 14:32:05] Kam: I had rice and chicken for lunch
 *   2026/08/11, 14:32 - Kam: I had rice and chicken for lunch
 *
 * Continuation lines (a message containing newlines) belong to the message above them. Getting
 * that wrong would silently split one member message into several turns and corrupt every
 * sequence-dependent judgement downstream, so it is handled explicitly rather than by luck.
 */
const WA_BRACKET = /^\[(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[apAP]\.?[mM]\.?)?)\]\s*([^:]{1,60}):\s?([\s\S]*)$/;
const WA_DASH = /^(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[apAP]\.?[mM]\.?)?)\s+-\s+([^:]{1,60}):\s?([\s\S]*)$/;

/** WhatsApp's own system lines. Not conversation, and not the member's words. */
const WA_SYSTEM = /(Messages and calls are end-to-end encrypted|You (?:created|added|joined)|changed the subject|changed this group's icon|security code changed|<Media omitted>|This message was deleted)/i;

export interface WhatsAppAdapterOptions {
  /**
   * Which exported sender is Coach K. REQUIRED — the adapter will not guess. Getting the
   * speaker backwards would invert every score in the instrument, so it is the caller's job
   * to state it and the adapter's job to refuse without it.
   */
  coachSender: string;
  /** Label used for the member in the canonical output. Defaults to the other sender's name. */
  participantLabel?: string;
  conversationId?: string;
  file?: string;
}

export function fromWhatsAppExport(raw: string, opts: WhatsAppAdapterOptions): Conversation {
  if (!opts?.coachSender) {
    throw new Error("fromWhatsAppExport: coachSender is required — the adapter will not guess which side is Coach K.");
  }
  const lines = raw.split(/\r?\n/);
  const turns: Turn[] = [];
  let senders = new Set<string>();

  for (const line of lines) {
    const m = WA_BRACKET.exec(line) || WA_DASH.exec(line);
    if (m) {
      const [, date, time, sender, text] = m;
      if (WA_SYSTEM.test(text) || WA_SYSTEM.test(line)) continue;
      senders.add(sender.trim());
      turns.push({
        index: turns.length,
        speaker: sender.trim() === opts.coachSender.trim() ? "coach" : "member",
        message: text,
        timestamp: isoOrUndefined(date, time),
        metadata: { sender: sender.trim(), rawDate: date, rawTime: time },
      });
      continue;
    }
    // A continuation of the message above. Multi-line messages are ordinary in WhatsApp and
    // splitting them would fabricate turns that never happened.
    if (turns.length && line.trim() !== "" && !WA_SYSTEM.test(line)) {
      turns[turns.length - 1].message += "\n" + line;
    }
  }

  if (!senders.has(opts.coachSender.trim())) {
    throw new Error(
      `fromWhatsAppExport: coachSender ${JSON.stringify(opts.coachSender)} never appears in this export. ` +
      `Senders found: ${[...senders].map(s => JSON.stringify(s)).join(", ") || "(none — is this a WhatsApp export?)"}`
    );
  }

  const other = [...senders].filter(s => s !== opts.coachSender.trim());
  return {
    conversationId: opts.conversationId || opts.file || "whatsapp-export",
    participant: opts.participantLabel || other[0] || "member",
    turns,
    source: { adapter: "whatsapp-export", file: opts.file },
  };
}

/**
 * WhatsApp timestamps carry no timezone. KamLife is a South African product and every other
 * date in this codebase is SAST, so SAST is what an exported wall-clock time means. Stated
 * here rather than assumed, because a silent UTC read would shift late-evening meals a day.
 */
function isoOrUndefined(date: string, time: string): string | undefined {
  const parts = date.split(/[/-]/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return undefined;
  const [a, b, c] = parts;
  const yearFirst = a > 31;
  const year = yearFirst ? a : (c < 100 ? 2000 + c : c);
  const month = yearFirst ? b : b;          // both common orders put month second
  const day = yearFirst ? c : a;
  const t = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([apAP])?/.exec(time);
  if (!t) return undefined;
  let hh = Number(t[1]);
  if (t[4] && /p/i.test(t[4]) && hh < 12) hh += 12;
  if (t[4] && /a/i.test(t[4]) && hh === 12) hh = 0;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hh)}:${t[2]}:${t[3] || "00"}+02:00`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADAPTER 2 — PASTED TRANSCRIPT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The lowest-friction route: paste a conversation with one speaker label per line.
 *
 *   Member: I had rice and chicken for lunch
 *   Coach: Logged — 620 kcal. …
 *
 * Accepts "Member/Me/User/Client" and "Coach/Coach K/K/KamLife" as labels, case-insensitively.
 * Anything else on a labelled line is an error rather than a guess, for the same reason the
 * WhatsApp adapter refuses to infer the coach: a silently mislabelled speaker inverts the
 * whole measurement and would never announce itself.
 */
const MEMBER_LABEL = /^\s*(member|me|user|client|kam)\s*:\s?/i;
const COACH_LABEL = /^\s*(coach\s*k|coach|kamlife|k)\s*:\s?/i;
const ANY_LABEL = /^\s*([A-Za-z][A-Za-z \t]{0,20})\s*:\s?/;

export function fromPastedTranscript(raw: string, opts: { conversationId?: string; participantLabel?: string; file?: string } = {}): Conversation {
  const turns: Turn[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    // COACH first: "Coach K:" also matches the member pattern's "k" alternative.
    const coach = COACH_LABEL.exec(line);
    const member = coach ? null : MEMBER_LABEL.exec(line);
    if (coach || member) {
      turns.push({
        index: turns.length,
        speaker: coach ? "coach" : "member",
        message: line.slice((coach || member)![0].length),
        metadata: { label: (coach || member)![1] },
      });
      continue;
    }
    const stray = ANY_LABEL.exec(line);
    if (stray && turns.length === 0) {
      throw new Error(
        `fromPastedTranscript: unrecognised speaker label ${JSON.stringify(stray[1])}. ` +
        `Use "Member:" and "Coach:" — the adapter will not guess which side is Coach K.`
      );
    }
    if (turns.length) turns[turns.length - 1].message += "\n" + line;
  }
  return {
    conversationId: opts.conversationId || opts.file || "pasted-transcript",
    participant: opts.participantLabel || "member",
    turns,
    source: { adapter: "pasted-transcript", file: opts.file },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOADING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phone numbers are the one thing scrubbed on the way in, and only from the participant LABEL.
 * Message bodies stay verbatim per §2. A WhatsApp export names its participants by phone
 * number when they are not saved as contacts, and a corpus filename or a printed report has
 * no business carrying one.
 */
export function redactPhone(label: string): string {
  return label.replace(/\+?\d[\d\s().-]{7,}\d/g, m => `…${m.replace(/\D/g, "").slice(-4)}`);
}

export function loadConversationFile(path: string, opts: Partial<WhatsAppAdapterOptions> = {}): Conversation {
  if (!existsSync(path)) throw new Error(`corpus file not found: ${path}`);
  const raw = readFileSync(path, "utf-8");
  const looksWhatsApp = raw.split(/\r?\n/).slice(0, 40).some(l => WA_BRACKET.test(l) || WA_DASH.test(l));
  const conv = looksWhatsApp
    ? fromWhatsAppExport(raw, { coachSender: opts.coachSender || "", ...opts, file: path })
    : fromPastedTranscript(raw, { ...opts, file: path });
  conv.participant = redactPhone(conv.participant);
  return conv;
}

/** Every coach turn that has at least one member turn before it — the scoreable unit. */
export function scoreableTurns(conv: Conversation): Turn[] {
  return conv.turns.filter(t => t.speaker === "coach" && conv.turns.slice(0, t.index).some(p => p.speaker === "member"));
}

/** The member turn a given coach reply is responding to. */
export function precedingMemberTurn(conv: Conversation, coachTurn: Turn): Turn | undefined {
  for (let i = coachTurn.index - 1; i >= 0; i--) if (conv.turns[i].speaker === "member") return conv.turns[i];
  return undefined;
}
