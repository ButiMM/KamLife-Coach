/**
 * Consumer-facing re-entry boundary.
 *
 * Keep routing consumers dependent on the canonical resolver rather than rebuilding
 * silence/return regexes locally. This adapter intentionally contains no reply text
 * and no persistence side effects.
 */
import { resolveReentry, type ReentryResolution } from "./reentry";

export function resolveReentryForUser(input: {
  user: { lastActiveAt?: unknown };
  message: string;
  nowMs?: number;
}): ReentryResolution {
  return resolveReentry({
    lastActiveAt: input.user.lastActiveAt,
    message: input.message,
    nowMs: input.nowMs,
  });
}

export function shouldHandleComebackForUser(input: {
  user: { lastActiveAt?: unknown };
  message: string;
  nowMs?: number;
}): boolean {
  return resolveReentryForUser(input).shouldHandleComeback;
}
