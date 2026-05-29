// Safety / escalation detection — extracted so it can be unit-tested in
// isolation without booting routes.ts (db, twilio, etc.).
//
// Priority tiers (ordered top-to-bottom in detectEscalation; first match wins):
//   urgent  → crisis, injury           (coach paged + 1h SLA)
//   high    → billing, medical, frustrated (coach paged + 4h SLA)
//   normal  → human_requested          (inbox only, 12h SLA)

export type EscalationPriority = "urgent" | "high" | "normal" | "low";

export interface EscalationDecision {
  should: boolean;
  reason: string;
  priority: EscalationPriority;
}

export function escalationSLA(priority: string): Date {
  const hours: Record<string, number> = { urgent: 1, high: 4, normal: 12, low: 48 };
  return new Date(Date.now() + (hours[priority] || 12) * 3600_000);
}

export function detectEscalation(message: string): EscalationDecision {
  const m = message.toLowerCase();
  // Ordering matters: crisis → acute-medical emergencies → injury → billing →
  // chronic-medical → frustration → human-requested. Acute-medical sits above
  // injury so "chest pain" is flagged medical, not a muscle injury.
  //
  // Regexes intentionally omit the trailing \b so participles and plurals match
  // ("sprained", "diabetes", "pregnancy", "epileptic"). Leading \b still prevents
  // mid-word false positives.

  // Crisis/self-harm — urgent
  if (/\b(want to die|kill myself|end it all|cannot go on|can't go on|suicidal|self.?harm|cutting myself|hurting myself|not worth living|end my life|no reason to live|give up on life)\b/i.test(m))
    return { should: true, reason: "crisis", priority: "urgent" };
  // Acute medical emergencies — checked before "injury" so pain-adjacent cardiac/respiratory
  // signals don't get mis-flagged as a muscle strain
  if (/\b(chest pain|can't breathe|cannot breathe|fainted|collapsed)\b/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  // Acute/structural injury terms → urgent 1h SLA
  if (/\b(injur|torn|sprain|fracture|broken|hernia|slipped disc|serious pain|sharp pain|severe pain|radiating pain)/i.test(m))
    return { should: true, reason: "injury", priority: "urgent" };
  // High-risk joint/area + pain signal → urgent (excludes DOMS-only triggers like "legs are sore")
  if (/\b(back|spine|neck|shoulder|rotator|knee|ankle|wrist|elbow|hip|groin|disc|hamstring)\b/i.test(m) && /\b(hurt|pain|sore|aching)\b/i.test(m))
    return { should: true, reason: "injury", priority: "urgent" };
  // Billing / subscription
  if (/\b(refund|cancel.*subscription|stop.*billing|charge|payment.*issue|money back|unsubscribe)\b/i.test(m))
    return { should: true, reason: "billing", priority: "high" };
  // Chronic medical — conditions, medications, professional care
  if (/\b(doctor|hospital|surgery|medication|diabet|blood pressure|heart condition|pregnant|pregnan|asthma|epilep|dizzy)/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  // Frustration / complaint
  if (/\b(angry|furious|disgusted|worst|scam|rip.?off|waste of money|terrible|useless|report you)\b/i.test(m))
    return { should: true, reason: "frustrated", priority: "high" };
  // Human-touch request
  if (/\b(speak.*human|real person|talk.*someone|manager|complain|complaint)\b/i.test(m))
    return { should: true, reason: "human_requested", priority: "normal" };
  return { should: false, reason: "", priority: "normal" };
}
