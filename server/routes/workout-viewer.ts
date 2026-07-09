/**
 * WORKOUT VIEWER ROUTE — GET /w/:token
 *
 * Serves the frictionless swipe-through page of today's exercises. The token is a
 * signed reference to the client (see server/workout-viewer.ts); no login, no PII —
 * it only ever renders the client's own prescribed workout, server-rendered from the
 * same source of truth the WhatsApp message uses, so it can never drift from the plan.
 */
import type { Express } from "express";
import { db } from "../db";
import { users } from "../../shared/schema";
import { eq } from "drizzle-orm";
import { verifyWorkoutToken, buildViewerCards, renderWorkoutViewerHtml } from "../workout-viewer";

export function registerWorkoutViewerRoutes(app: Express): void {
  app.get("/w/:token", async (req: any, res: any) => {
    const userId = verifyWorkoutToken(String(req.params.token || ""));
    if (!userId) return res.status(404).send("<h1>Link expired or invalid</h1>");

    try {
      const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      const user = rows[0];
      if (!user) return res.status(404).send("<h1>Link expired or invalid</h1>");

      const data = buildViewerCards(user);
      if (!data) {
        return res
          .status(200)
          .send("<h1 style='font-family:sans-serif;padding:40px'>No gym exercises today — you're on steps and food. 💪</h1>");
      }

      const firstName = (user.name || "").split(" ")[0] || "";
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // private: the page is per-client; never let a shared cache serve it to another
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.status(200).send(renderWorkoutViewerHtml(data, firstName));
    } catch (e: any) {
      console.error("[WORKOUT_VIEWER] render failed:", e?.message || e);
      return res.status(500).send("<h1>Something went wrong — open your workout in WhatsApp.</h1>");
    }
  });
}
