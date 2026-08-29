export function isHoldReply(text: string): boolean {
  return /not going to call a trend off those weigh-ins|not going to put a number on it|last weigh-in is too far back|don't have enough weigh-ins yet/i.test(text || "");
}
