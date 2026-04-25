const SLEEP_RESPONSES_LOW = [
  (h: number) => `${h} hours is not enough. Sleep is when your body burns fat and repairs muscle. Under 7 hours and cortisol spikes — that blocks fat loss directly. Tonight: phone off 30 minutes before bed. Lights off by 9:30pm.`,
  (h: number) => `${h} hours of sleep is below what your body needs to recover. When you undersleep, the next day's training suffers and fat loss slows. One action: set a bedtime alarm for tonight.`,
  (h: number) => `${h} hours is affecting your results more than your diet. Poor sleep raises hunger hormones and tanks motivation. Fix tonight first: no screen 30 minutes before bed.`,
];

const SLEEP_RESPONSES_GOOD = [
  (h: number) => `${h} hours — solid. Your body does its best work between 7 and 9 hours. Recovery is happening. Keep this up and your results will reflect it.`,
  (h: number) => `${h} hours of quality sleep. That is where the fat loss and muscle repair actually happen. Good work — rest is training.`,
];

const SLEEP_RESPONSES_HIGH = [
  (h: number) => `${h} hours is more than enough for recovery. If you are regularly sleeping this much, check your stress levels or iron intake — oversleeping can signal burnout or anaemia. How is your energy when you wake up?`,
];

export function getSleepResponse(hours: number | null, isBadSleep: boolean): string {
  if (isBadSleep && hours === null) {
    return `Poor sleep affects fat loss more than a bad meal. Cortisol rises, hunger hormones spike, motivation drops. One fix tonight: no phone in the bedroom. Dark, cool, quiet. Your body will do the rest.`;
  }
  if (hours === null) {
    return `Log your sleep hours so I can track your recovery — just say something like "I slept 7 hours".`;
  }
  const idx = Math.floor(Date.now() / 86400000);
  if (hours < 5) {
    return `${hours} hours — that is not enough for recovery. Today's training will suffer and fat storage increases with this little sleep. Rest today if you can. Tonight: hard stop on screens by 9pm.`;
  }
  if (hours < 7) {
    return SLEEP_RESPONSES_LOW[idx % SLEEP_RESPONSES_LOW.length](hours);
  }
  if (hours <= 9) {
    return SLEEP_RESPONSES_GOOD[idx % SLEEP_RESPONSES_GOOD.length](hours);
  }
  return SLEEP_RESPONSES_HIGH[0](hours);
}
