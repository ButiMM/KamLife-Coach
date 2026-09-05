/**
 * DAILY DIRECTION — the plain, holistic "what do I do today and this week" answer
 * (2026-07-09: a client asked the bot "give me direction, what do I do today and for
 * the rest of the week — an overall plan, not just workouts" and got a bare exercise
 * dump). This is the A→B→C→D orientation: today across ALL the pillars (train/rest,
 * food, steps, water) + the simple weekly through-line — grandmother-plain, never a
 * science lecture, never just a workout list. Deterministic so it can't hallucinate.
 */

/**
 * IS THIS A DIRECTION REQUEST? Lives here, beside the answer it routes to (#178).
 *
 * It sat in utils.ts, three hundred lines from buildDailyDirection, which is how "I need help
 * getting going again" could be a direction request in every sense a client means it and in none
 * that the recogniser could see. The question and the answer are one idea; splitting them across
 * files is what let them drift.
 *
 * Shared by handlers/misc-commands (which serves it) and routes (which stops the model from
 * swallowing it), so a direction ask can never be answered by a workout dump on a rest day.
 */
export function looksLikeDirectionRequest(m: string): boolean {
  const s = (m || "").replace(/^[.!?,;:'"\s]+|[.!?,;:'"\s]+$/g, "");
  return (/\b(give me (a )?direction|direction for (the|this|today|my)|what (do|should) i (do|be doing|need to do)( today| this week| for the week| now| next)|what.?s my (plan|week|day)|my (overall |whole )?plan\b|overall plan|plan for (the|this) (week|day|month)|where do i (start|begin))\b/i.test(s)
    // ASKING FOR HELP TO START IS ASKING WHAT TO DO (#178, Journey Lab divergence).
    //
    // "I need help getting going again" reached no owner at all — every branch above wants the
    // words "plan", "direction" or "what should I do", and a returning client does not phrase it
    // that way. So the coach answered someone who had just come back after two weeks with "Sorry
    // Kam, I didn't quite catch that", and Coach Health filed the same turn as a candidate.
    //
    // buildDailyDirection already reads their real targets and today's training state and says
    // what to do next, which is exactly what someone getting going again needs. No comeback
    // predicate, no motivational mouth, no second router — the request reaches the owner it
    // always should have. And that owner says nothing about ABSENCE, which is what makes it safe
    // for the present-but-sparse client saying the same words.
    //
    // NARROW ON PURPOSE: bare "help" keeps its own owner, and help with a NAMED domain still goes
    // where the guard below has always sent it.
    || /\b(?:need|want|could use)\s+(?:some\s+|a bit of\s+)?help\s+(?:to\s+)?(?:get(?:ting)?|start(?:ing)?|restart(?:ing)?)\b/i.test(s)
    || /\bhelp me\s+(?:to\s+)?(?:get|start|restart)\b/i.test(s))
    && !/\b(workout|exercise|meal plan|recipe|shopping|supplement|pay|cancel|refund|price|cost)\b/i.test(s);
}

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
