/**
 * DAILY DIRECTION — the plain, holistic "what do I do today and this week" answer
 * (2026-07-09: a client asked the bot "give me direction, what do I do today and for
 * the rest of the week — an overall plan, not just workouts" and got a bare exercise
 * dump). This is the A→B→C→D orientation: today across ALL the pillars (train/rest,
 * food, steps, water) + the simple weekly through-line — grandmother-plain, never a
 * science lecture, never just a workout list. Deterministic so it can't hallucinate.
 */

type DirectionWorkoutState = { type: "REST" | "NORMAL" | "MISSED" | "ALREADY_DONE"; todayName?: string; nextTrainingName?: string };

export function buildDailyDirection(
  user: { name?: string | null; calorieTarget?: number | null; proteinTarget?: number | null; stepsTarget?: number | null; trainingMode?: string | null; trainingDaysPerWeek?: number | null },
  workoutState: DirectionWorkoutState,
): string {
  const first = (user.name || "").split(" ")[0] || "";
  const hi = first ? `Here's your plan, ${first} 👇` : "Here's your plan 👇";
  const steps = (user.stepsTarget || 8000).toLocaleString();
  const cal = user.calorieTarget || null;
  const prot = user.proteinTarget || null;
  const mode = user.trainingMode || "home";
  const trainingDays = Math.min(6, Math.max(2, user.trainingDaysPerWeek || 3));

  // Today's training line — honour rest / already-done / walk-only, never insist on a gym day.
  let trainToday: string;
  if (mode === "walk_only" || mode === "walk") {
    trainToday = `👟 Walk your ${steps} steps — that's today's movement`;
  } else if (workoutState.type === "ALREADY_DONE") {
    trainToday = `✅ Training done — nice. Recover well.`;
  } else if (workoutState.type === "REST") {
    trainToday = `😌 Rest day — no gym today, your body rebuilds${workoutState.nextTrainingName ? `. Next session: ${workoutState.nextTrainingName}` : ""}`;
  } else {
    trainToday = `💪 Training day — reply *workout* and your session's ready`;
  }

  // Food line — keep the number but plain, protein first.
  const foodLine = cal
    ? `🍳 Eat around ${cal.toLocaleString()}${prot ? ` — protein first, aim ${prot}g` : ""}`
    : `🍳 Log every meal — a photo or one line, I do the maths`;

  const stepsLine = (mode === "walk_only" || mode === "walk") ? "" : `\n👟 ${steps} steps`;

  // Buttons match the day: no "Today's workout" tap on a rest day (2026-07-11 — the
  // reply shipped button-less and read robotic; every reply must end in taps).
  const buttons = (mode === "walk_only" || mode === "walk" || workoutState.type === "REST" || workoutState.type === "ALREADY_DONE")
    ? "[BUTTONS:Log food|My progress|Tomorrow's session]"
    : "[BUTTONS:Today's workout|Log food|My progress]";

  return `${hi}

*Today:*
${trainToday}
${foodLine}${stepsLine}
💧 Water through the day

*This week:*
Train ${trainingDays} days, log your food every day, hit your steps, drink your water. Do those and the results come — nothing fancy. That's the whole plan.${buttons}`;
}
