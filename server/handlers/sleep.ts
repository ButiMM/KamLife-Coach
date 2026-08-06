/**
 * SLEEP REPLIES — two sentences, and the second one is the fix.
 *
 * (2026-08-06 path sweep.) These were three-sentence physiology lessons: cortisol spiking,
 * hunger hormones, fat storage. Someone who says "I slept 5 hours" is telling you they are
 * tired, not asking for the mechanism. Acknowledge the number they gave, then ONE thing to
 * do tonight — the same shape as every other log reply in the product.
 */

const SLEEP_RESPONSES_LOW = [
  (h: number) => `${h} hours isn't enough to recover properly. Tonight: phone down 30 minutes before bed.`,
  (h: number) => `${h} hours — your training will feel it tomorrow. Set a bedtime alarm for tonight.`,
  (h: number) => `${h} hours is costing you more than a bad meal would. No screens 30 minutes before bed tonight.`,
];

const SLEEP_RESPONSES_GOOD = [
  (h: number) => `${h} hours — solid. 👌 That's where the recovery actually happens.`,
  (h: number) => `${h} hours, nice. 👌 Rest is training — keep it there.`,
];

const SLEEP_RESPONSES_HIGH = [
  (h: number) => `${h} hours is plenty — if it's every night, that can mean stress or low iron. How's your energy when you wake up?`,
];

export function getSleepResponse(hours: number | null, isBadSleep: boolean): string {
  if (isBadSleep && hours === null) {
    return `Poor sleep sets you back further than a bad meal does. One fix tonight: no phone in the bedroom.`;
  }
  if (hours === null) {
    return `Tell me the hours and I'll track your recovery — something like "I slept 7 hours".`;
  }
  const idx = Math.floor(Date.now() / 86400000);
  if (hours < 5) {
    return `${hours} hours — that's too little to train hard on. Take it easy today and put a hard stop on screens by 9pm.`;
  }
  if (hours < 7) {
    return SLEEP_RESPONSES_LOW[idx % SLEEP_RESPONSES_LOW.length](hours);
  }
  if (hours <= 9) {
    return SLEEP_RESPONSES_GOOD[idx % SLEEP_RESPONSES_GOOD.length](hours);
  }
  return SLEEP_RESPONSES_HIGH[0](hours);
}
