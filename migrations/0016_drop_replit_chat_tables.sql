-- #334: Replit AI Integrations scaffolding. The only reader was server/replit_integrations
-- (the /api/conversations audio routes), which no client calls and which this PR deletes.
DROP TABLE IF EXISTS "messages";
--> statement-breakpoint
DROP TABLE IF EXISTS "conversations";
