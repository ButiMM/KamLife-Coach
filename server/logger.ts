// ============================================================
// STRUCTURED LOGGER
// Wraps console with consistent timestamp + level + source format.
// In production, only WARN and ERROR are emitted unless DEBUG=true.
// ============================================================

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const DEBUG_ENABLED = process.env.DEBUG === "true";

function shouldEmit(level: LogLevel): boolean {
  if (!IS_PRODUCTION || DEBUG_ENABLED) return true;
  return level === "WARN" || level === "ERROR";
}

function formatMessage(level: LogLevel, source: string, message: string, context?: unknown): string {
  const ts = new Date().toISOString();
  const ctx = context !== undefined ? ` ${JSON.stringify(context)}` : "";
  return `${ts} [${level}] [${source}] ${message}${ctx}`;
}

export const logger = {
  debug(source: string, message: string, context?: unknown): void {
    if (shouldEmit("DEBUG")) {
      console.debug(formatMessage("DEBUG", source, message, context));
    }
  },

  info(source: string, message: string, context?: unknown): void {
    if (shouldEmit("INFO")) {
      console.log(formatMessage("INFO", source, message, context));
    }
  },

  warn(source: string, message: string, context?: unknown): void {
    if (shouldEmit("WARN")) {
      console.warn(formatMessage("WARN", source, message, context));
    }
  },

  error(source: string, message: string, context?: unknown): void {
    if (shouldEmit("ERROR")) {
      console.error(formatMessage("ERROR", source, message, context));
    }
  },
};
