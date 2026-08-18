/**
 * ADAPTIVE TARGETS — the daily job that actually MOVES a client's numbers.
 *
 * (2026-07-27) The adaptive engine was written and tested but not wired, which is the exact
 * failure the founder called out: built, not integrated. This is the wiring. It runs each
 * morning BEFORE the morning check-in so the day's message already reflects today's real
 * targets.
 *
 * It reads the client's actual state (sick marker, 14-day weight trend, 7-day step average,
 * weeks stalled), asks the pure engine what today's targets should be, PERSISTS them, and
 * sends ONE plain line only when something changed. Silence is the default — a target that
 * moves every day is noise.
 */

import { db, users, eq, getActiveClients, sendWhatsApp, saveState, todaySAST, hasRunToday, loadProactiveState } from "../shared";
import { adaptTargets, adaptiveInputFrom } from "../../adaptive-targets";

export async function runAdaptiveTargets(): Promise<void> {
  const today = todaySAST();
  if (hasRunToday("adaptive_targets", today)) return;

  const clients = await getActiveClients();
  let moved = 0;
  for (const c of clients) {
    try {
      // ONE SNAPSHOT, SHARED (2026-08-18, Issue #49 step 2). Everything this job used to read for
      // itself — durable sickness, the 28-day weigh-in series and its usability verdict, 7-day
      // steps, the weekly intake aggregate, the stall count — now comes from loadProactiveState,
      // which the morning job reads too. It assembled its own before, and morning assembled a
      // different one, which is how the same client could be sick for one job and well for the
      // other in the same quarter hour.
      //
      // The baseline rule that migration 0005 established lives inside that snapshot now: the
      // engine reasons from `baseline` (the profile number, which nothing here writes) and the
      // client's visible target is the `current` overlay this job persists.
      const s = await loadProactiveState(c);
      const input = adaptiveInputFrom(s);
      if (!(input.baseCalories > 0 && input.baseProtein > 0)) continue; // no baseline yet

      // Still read directly: the two profileNotes tokens this job WRITES and owns — its own
      // once-a-week stall notice and the adapted_until marker. Bookkeeping, not client state.
      const notes = String(c.profileNotes || "");

      const out = adaptTargets(input);
      if (!out.changed) continue;

      // A STALL THE ENGINE DELIBERATELY DID NOT ACT ON. Both new outcomes leave every target
      // exactly where it was and say why — so they fall through the "nothing changed → stay
      // silent" guard below, which is correct for every other reason and wrong for these two.
      // Rate-limited to once a week: this job runs daily and a stalled, under-logging client
      // would otherwise be told the same thing every morning for three weeks, which is nagging,
      // not coaching.
      if (out.reason === "stalled_unlogged" || out.reason === "stalled_over_target") {
        const lastNotice = notes.match(/stall_notice:(\d{4}-\d{2}-\d{2})/)?.[1];
        if (lastNotice && (Date.now() - new Date(lastNotice).getTime()) / 86_400_000 < 7) continue;
        const kept = notes.replace(/\s*\bstall_notice:\d{4}-\d{2}-\d{2}\b/g, "").trim();
        await db.update(users)
          .set({ profileNotes: `${kept} stall_notice:${today}`.trim() })
          .where(eq(users.id, c.id));
        await sendWhatsApp(c.phoneNumber, out.note).catch(() => {});
        console.log(`[ADAPTIVE] ${c.id.slice(-6)} ${out.reason}: targets held at ${input.baseCalories} kcal (logged ${input.loggedDays7d ?? "?"}d, avg ${input.avgKcal7d ?? "?"} kcal)`);
        continue;
      }

      // Nothing actually different from what they already HOLD — compared against the stored
      // overlay, not the baseline the engine reasoned from. Those diverge now: an unchanged
      // decision recomputed from baseline can still equal what the client already has.
      if (out.calorieTarget === s.current.calories && out.proteinTarget === s.current.protein
          && out.stepsTarget === s.current.steps) continue;

      // MARK IT DELIBERATE, or the morning sanity audit reverts it before lunch (2026-07-30
      // live: this job wrote 2530, morning.ts saw 332 kcal off the profile figure, called it
      // corruption and wrote 2862 back with an announcement). Same durable profileNotes token
      // pattern as sick_until, and the same exemption a diet break already gets.
      const keptNotes = (notes || "").replace(/\s*\badapted_until:\d{4}-\d{2}-\d{2}\b/g, "").trim();
      const adaptedUntil = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
      await db.update(users).set({
        calorieTarget: out.calorieTarget,
        proteinTarget: out.proteinTarget,
        stepsTarget: out.stepsTarget,
        profileNotes: `${keptNotes} adapted_until:${adaptedUntil}`.trim(),
      }).where(eq(users.id, c.id));

      if (out.note) {
        await sendWhatsApp(c.phoneNumber, `🎯 *Targets adjusted for today.*\n\n${out.note}`).catch(() => {});
      }
      moved++;
      console.log(`[ADAPTIVE] ${c.id.slice(-6)} ${out.reason}: ${input.baseCalories}→${out.calorieTarget} kcal, steps ${input.baseSteps}→${out.stepsTarget}`);
    } catch (e) {
      console.warn(`[ADAPTIVE] failed for ${c.id?.slice(-6)}:`, (e as Error)?.message || e);
    }
  }
  saveState("adaptive_targets", today);
  if (moved > 0) console.log(`[ADAPTIVE] adjusted targets for ${moved} client(s)`);
}
