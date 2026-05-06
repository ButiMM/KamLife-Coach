import {
  sendWhatsApp, getActiveClients, isPaused,
} from "../shared";

export function getSACulturalEvent(month: number, day: number): ((name: string) => string) | null {
  if (month === 1 && day === 1) return (n) =>
    `Happy New Year, ${n}. Everyone starts January motivated. Most are done by the 15th. You will not be most people. Today — one training session and one good meal. That is how the year starts. Not with a resolution. With an action.`;
  if (month === 6 && day === 16) return (n) =>
    `Youth Day, ${n}. Today honours those who stood up when it was hard. Your fitness journey is not political — but the principle is the same. Do the hard thing today. Send me your workout when you're done.`;
  if (month === 8 && day === 9) return (n) =>
    `Women's Day, ${n}. To every woman on this programme — the strength you are building in the gym is the same strength that carries everything else. Today's session is for you. Do it for you. Reply "today" for your workout.`;
  if (month === 9 && day === 24) return (n) =>
    `Heritage Day, ${n}. National Braai Day. Here is your braai coaching: boerewors — 36g protein per coil, high fat. Chicken — always remove skin. Corn on the braai — fine as a carb. Potato salad — skip the mayo or go small. Beer — 150 calories each, zero protein. Enjoy the braai and log your food tonight.`;
  if (month === 12 && day === 1) return (n) =>
    `${n}, December starts today. This is the month most programmes fall apart. Two rules for the whole month: protein at every meal and at least one training session per week. Everything else is negotiable. Festive season is not an excuse. It is a test.`;
  if (month === 12 && day === 16) return (n) =>
    `Day of Reconciliation, ${n}. Festive season is in full swing. Your body does not take public holidays. Keep the protein up and do not let December undo what you built all year. You are too far in to stop now.`;
  return null;
}

export async function runCulturalCalendar(): Promise<void> {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const eventFn = getSACulturalEvent(month, day);
  if (!eventFn) return;
  console.log(`[SCHEDULER] JOB: Cultural event — ${month}/${day}`);
  const clients = await getActiveClients();
  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      await sendWhatsApp(client.phoneNumber, eventFn(client.name || "there"));
    } catch (err) { console.error(`[SCHEDULER] Cultural event error — ${client.phoneNumber}:`, err); }
  }
}

export async function runWomensMonth(): Promise<void> {
  console.log("[SCHEDULER] JOB: Women's Month Monday message");
  const clients = await getActiveClients();
  const femaleIndicators = (client: { primaryFocusArea?: string | null; profileNotes?: string | null }) =>
    client.primaryFocusArea === "glutes_legs" ||
    ["she", "her", "woman", "female"].some(w => (client.profileNotes || "").toLowerCase().includes(w));

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      const workouts = client.totalWorkoutsCompleted || 0;
      if (femaleIndicators(client)) {
        await sendWhatsApp(client.phoneNumber, `${name}, Women's Month. The strength you are building is not just physical — it is the discipline that carries into every part of your life. ${workouts > 0 ? `${workouts} sessions completed and counting.` : "Your programme is ready."} Train today — for you, no one else.`);
      } else {
        await sendWhatsApp(client.phoneNumber, `${name}, August — Women's Month in SA. The women in your life are watching what you build. Be the example. Train this week, eat well, stay consistent. That is the best thing you can do.`);
      }
    } catch (err) { console.error(`[SCHEDULER] Women's Month error — ${client.phoneNumber}:`, err); }
  }
}

export async function runNewYearReset(): Promise<void> {
  console.log("[SCHEDULER] JOB: New Year reset");
  const clients = await getActiveClients();
  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      const workouts = client.totalWorkoutsCompleted || 0;
      const days = Math.floor((Date.now() - new Date(client.programmeStartDate || Date.now()).getTime()) / 86_400_000);
      await sendWhatsApp(client.phoneNumber, `${name}, January 2nd. The gym is full of people who will be gone by February. You have ${workouts > 0 ? `${workouts} sessions and ${days} days` : "your programme"} already built. You are not starting. You are continuing. That is the difference. Log your first food of 2025 today.`);
    } catch (err) { console.error(`[SCHEDULER] New Year reset error — ${client.phoneNumber}:`, err); }
  }
}
