/**
 * CONDITION WELCOME — what we say when a client mentions a diagnosis or medication.
 *
 * (2026-07-28, founder: "their doctors told them to join a gym… do we turn people like that
 * away? People just want help.") No — they are the core client, not an edge case. Someone whose
 * doctor said "lose some weight and get moving" is describing lifestyle coaching; that IS the
 * product. Turning them away would be absurd commercially and unkind personally.
 *
 * The line that keeps us safe is not WHO we serve, it is WHAT we touch:
 *   WE DO   — food they can afford, portions, movement they can sustain, accountability.
 *   WE DON'T — the condition, the medicine, the readings, the diagnosis. That is their doctor's,
 *              and we say so plainly and once, without making them feel like a liability.
 *
 * The previous copy claimed Coach K would "suggest food choices that are generally safe for your
 * condition". That is a clinical promise and it is gone.
 *
 * Pure — no DB, no model. Unit-tested.
 */

/**
 * The reply: welcome first, boundary second, back to coaching third. It never names their
 * condition back at them, never comments on medicine, and never claims anything is "safe for"
 * a diagnosis — but it also never makes them feel turned away.
 */
export function conditionWelcome(firstName = ""): string {
  const open = firstName ? `${firstName}, thanks` : "Thanks";
  return `${open} for telling me — it helps, and you're in the right place.\n\nMost people come to me because a doctor said *lose some weight, eat better, get moving* and then left them to work out how. That "how" is my whole job: real food you can afford, portions that make sense, walking you can keep up, and me checking in on you.\n\n*Where I stop:* I'm a lifestyle coach, not a medical service. I won't advise on your medicine, your readings or your diagnosis — that stays with your doctor, and do tell them you're doing this.\n\nSo — what do you want to start with: the food, or getting moving?`;
}
