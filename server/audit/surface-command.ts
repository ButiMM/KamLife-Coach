/**
 * COACH COMMAND "surface" — which parts of this product does anyone actually use?
 *
 * (2026-07-28.) The market is niche; the product is not. This counts real traffic per intent and
 * splits it into CORE (what the product is for), PERIPHERY (used, but not the point) and DEAD
 * (under one use a fortnight). Dead surface is where bugs sit waiting: every one of 2026-07-27's
 * defects came from a feature nobody had asked for.
 *
 * It recommends DEMOTION, never deletion — keep the code, stop promoting it.
 */

import { desc, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { chatHistory } from "../../shared/schema";
import { analyseSurface } from "../surface";

export async function surfaceCommand(): Promise<string> {
  const rows = await db
    .select({ intent: chatHistory.intent, n: sql<number>`COUNT(*)::int` })
    .from(chatHistory)
    .where(isNotNull(chatHistory.intent))
    .groupBy(chatHistory.intent);

  const [span] = await db
    .select({ first: sql<string>`MIN(${chatHistory.createdAt})`, last: sql<string>`MAX(${chatHistory.createdAt})` })
    .from(chatHistory);

  const totalDays = span?.first && span?.last
    ? Math.max(1, Math.round((new Date(span.last).getTime() - new Date(span.first).getTime()) / 86_400_000))
    : 1;

  const uses = rows.map(r => ({ intent: r.intent || "(none)", count: Number(r.n) || 0 }));
  if (uses.length === 0) return "No traffic on record yet — nothing to measure.";

  const s = analyseSurface(uses, totalDays);
  const top = s.rows.slice(0, 8)
    .map(r => `${r.count}× ${r.intent} (${r.share}%) — ${r.klass}`)
    .join("\n");

  const dead = s.dead.length
    ? `\n\n🪦 *Under one use a fortnight (${s.dead.length}):*\n`
      + s.dead.slice(0, 12).map(r => `${r.intent} — ${r.count} ever`).join("\n")
      + `\n\n_Stop PROMOTING these — keep them working when asked. Every promoted feature is a surface where a bug can meet a client._`
    : "";

  return `🧭 *Surface*\n\n`
    + `Measured over *${totalDays} days*, *${s.totalReplies}* replies, *${s.distinctIntents}* distinct features.\n\n`
    + `🎯 Core (food, training, progress, safety): *${s.coreShare}%* of traffic\n`
    + `🔹 Periphery: *${s.peripheryShare}%*\n\n`
    + `*Busiest:*\n${top}${dead}`;
}
