import type { Express } from "express";

/**
 * Shared dependencies injected into each route module.
 * Everything else (db, schema, orm) is imported directly by each module.
 */
export interface RouteDeps {
  requireAdminKey: (req: any, res: any, next: any) => void;
  handleMessage: (phone: string, message: string, mediaUrl?: string, mediaContentType?: string) => Promise<string>;
  logChat: (userId: string, messageIn: string, messageOut: string, intent: string) => Promise<void>;
  checkRateLimit: (phone: string) => boolean;
}
