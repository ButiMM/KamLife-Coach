import { strict as assert } from "node:assert";
import { morningClosingLine, composeMorning } from "../server/morning-message";

function run(): void {
  const oldTrajectoryContext = { activelyEngaged: false, completedSessions28: 4 };

  const runLine = morningClosingLine("ON_A_RUN", oldTrajectoryContext);
  assert.equal(runLine, "", "28-day ON_A_RUN recognition must not become a client-facing score");

  const struggling = morningClosingLine("STRUGGLING", oldTrajectoryContext);
  assert.equal(struggling, "", "STRUGGLING must not create a second closing/action owner");

  const engagedStruggling = morningClosingLine("STRUGGLING", { activelyEngaged: true, completedSessions28: 1 });
  assert.equal(engagedStruggling, "", "engaged clients must not receive lapse framing");

  const lapsedRecovering = morningClosingLine("RECOVERING", oldTrajectoryContext);
  assert.match(lapsedRecovering, /have you back/i, "lapsed clients keep warm re-entry recognition");
  assert.doesNotMatch(lapsedRecovering, /sessions in the last 4 weeks|reply Hi/i, "warm recognition must not become a second behavioral instruction");

  const message = composeMorning({
    firstName: "KAM",
    targetFixLine: "",
    identityLine: "",
    streakLine: "",
    workoutLine: "",
    yesterdayLine: "",
    todayLines: ["*Today:*", "👟 6000 steps", "💪 Training day. Reply 1 for your workout."],
    closingLine: "",
    decisionLine: "*Make your next meal a proper protein meal.*",
    breakfastAsk: "🍳 What's for breakfast?",
    adaptLine: "",
    sickYesterday: false,
  });
  assert.match(message, /6000 steps/, "today status should survive");
  assert.doesNotMatch(message, /Reply 1/i, "today status must not create a second behavioural instruction");
  assert.match(message, /\*Make your next meal a proper protein meal\.\*/, "canonical decision must remain");
  assert.doesNotMatch(message, /sessions in the last 4 weeks/i, "28-day trajectory language must not reach the client");

  console.log("coach-loop-foundation: all checks passed");
}

run();
