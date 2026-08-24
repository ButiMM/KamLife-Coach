/**
 * Current-date owner.
 *
 * Calendar questions are factual, not coaching prompts. This keeps the answer tied to the
 * existing South African clock boundary and makes the behavior independently testable.
 */
import { sastToday } from "../utils";

export function currentDateSAST(now = new Date()): string {
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
}

export function isCurrentDateQuestion(message: string): boolean {
  return /^\s*(?:what(?:'s| is)\s+(?:the\s+)?(?:date|day)\s+(?:is\s+it\s+)?today|what day is it(?: today)?|what(?:'s| is) today)\s*[?.!]*\s*$/i.test(String(message || ""));
}

export function currentDateAnswer(now = new Date()): string {
  void sastToday();
  return `Today is ${currentDateSAST(now)}.`;
}
