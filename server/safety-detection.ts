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
  // Ordering matters (first match wins).
  //
  // GUIDING RULE for MEDICAL: escalate only when the bot should NOT be the one
  // answering — genuine emergencies, and situations that need medical clearance or
  // professional judgement (pregnancy, recent surgery, heart/seizure conditions,
  // medication changes, a diabetic hypo). Do NOT escalate the everyday chronic
  // conditions this product is BUILT to coach — diabetes, high blood pressure, PCOS,
  // being overweight. The target client is exactly the person whose doctor warned
  // them about diabetes; that is a coaching conversation, not a human handoff.
  // Escalating it floods the coach inbox and interrupts good coaching.
  //
  // Regexes intentionally omit the trailing \b so participles/plurals match
  // ("sprained", "pregnancy", "epileptic"). Leading \b still prevents mid-word hits.

  // Crisis/self-harm — urgent
  if (/\b(want to die|kill myself|end it all|cannot go on|can't go on|suicidal|self.?harm|cutting myself|hurting myself|not worth living|end my life|no reason to live|give up on life)\b/i.test(m))
    return { should: true, reason: "crisis", priority: "urgent" };
  // Acute medical emergencies — checked before "injury" so cardiac/respiratory
  // signals aren't mis-flagged as a muscle strain
  if (/\b(chest pain|chest tight|tight chest|can'?t breathe?|cannot breathe?|fainted|fainting|passed out|black(ed)? out|collapsed|seizure|convulsion|heart attack|having a stroke|had a stroke|coughing up blood)\b/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  // Diabetic / metabolic emergency — distinct from simply HAVING diabetes (which we coach)
  if (/\b(hypo|hypoglyc|blood sugar (is )?(very |really )?(low|high|crashed)|sugar crash|sugar (is )?too (low|high))\b/i.test(m))
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
  // Pregnancy / postpartum — exercise & nutrition need individualised, careful handling
  if (/\b(pregnant|pregnan|expecting a baby|trimester|breast.?feeding|post.?partum|just had a baby|gave birth|miscarriage)/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  // Recent surgery / hospitalisation — needs clearance before training
  if (/\b(surgery|operation|post.?op|hospitalised|hospitalized|in hospital|out of (the )?hospital|admitted to hospital|stitches)/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  // Heart / cardiac / seizure conditions — clearance before exertion
  if (/\b(heart condition|heart disease|heart problem|cardiac|angina|pacemaker|epilep)/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  // Medication CHANGES or adverse reactions — bot must never advise on meds
  if (/\b(stop|skip|chang|increas|decreas|double|halv)\w*\b.{0,24}\b(medication|meds|insulin|tablets?|pills?|treatment|chronic meds|arvs?|antiretroviral)\b/i.test(m)
      || /\b(can i|should i|is it (ok|safe|fine))\b.{0,30}\b(medication|meds|insulin|tablets?|pills?)\b/i.test(m)
      || /\b(allergic reaction|bad reaction|side.?effects?)\b.{0,24}\b(medication|meds|tablets?|pills?|insulin)\b/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  // Acute neurological symptoms during/after activity
  if (/\b(dizzy|dizziness|light.?headed|blurred vision|numbness|going numb)\b/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  // Frustration / complaint
  if (/\b(angry|furious|disgusted|worst|scam|rip.?off|waste of money|terrible|useless|report you)\b/i.test(m))
    return { should: true, reason: "frustrated", priority: "high" };
  // Human-touch request
  if (/\b(speak.*human|real person|talk.*someone|manager|complain|complaint)\b/i.test(m))
    return { should: true, reason: "human_requested", priority: "normal" };
  return { should: false, reason: "", priority: "normal" };
}

/**
 * IS THIS A SYNTHETIC TEST CLIENT? (Reality run, 2026-08-12.)
 *
 * The Reality harness drives six clients on fixed synthetic numbers (+2700000901…906), and
 * journey 4 says "I missed gym on Monday because my back was sore" — a real injury phrase, so
 * detectEscalation correctly fired `injury (urgent)` and a WhatsApp alert was sent to the
 * founder's actual phone. Correct product behaviour, wrong person: nobody is hurt, and a test
 * suite that pages a human every run trains them to ignore the page that matters.
 *
 * The escalation ROW is still written — the run should be inspectable afterwards. Only the
 * outbound alert is withheld. Keyed on the number rather than an env var so it holds no matter
 * how the harness is invoked, and confined to the +27 00000 xxx block, which contains no
 * dialable SA number (real mobiles carry an operator prefix, never 0, after the 27).
 */
export function isSyntheticTestClient(phoneNumber: string | null | undefined): boolean {
  return (phoneNumber || "").replace(/^whatsapp:/, "").replace(/\D/g, "").startsWith("2700000");
}
