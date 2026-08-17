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

export interface MedicationContextDecision {
  present: boolean;
  medicationClass: "glp1" | "other" | null;
  unsafeRequest: boolean;
  reason: "dosing" | "titration" | "stopping" | "sourcing" | "adverse_reaction" | null;
}

export function escalationSLA(priority: string): Date {
  const hours: Record<string, number> = { urgent: 1, high: 4, normal: 12, low: 48 };
  return new Date(Date.now() + (hours[priority] || 12) * 3600_000);
}

export function detectMedicationContext(message: string): MedicationContextDecision {
  const m = String(message || "").toLowerCase();
  const glp1 = /\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|liraglutide|dulaglutide|saxenda|victoza|rybelsus)\b/i.test(m);
  const otherMedication = /\b(medication|meds?|medicine|insulin|tablets?|pills?|prescription|treatment)\b/i.test(m);
  const present = glp1 || otherMedication;
  if (!present) return { present: false, medicationClass: null, unsafeRequest: false, reason: null };

  if (/\b(what|which|how much|how many)\b[^.!?]{0,40}\b(dose|dosage|mg|units?|clicks?)\b/i.test(m)
      || /\bhow\s+much\s+(?:ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide)\b/i.test(m)) {
    return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: true, reason: "dosing" };
  }
  if (/\b(titrate|titration|increase|decrease|raise|lower|double|halve|step up|step down)\b[^.!?]{0,40}\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|liraglutide|dulaglutide|saxenda|victoza|rybelsus|medication|meds?|dose|dosage)\b/i.test(m)) {
    return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: true, reason: "titration" };
  }
  if (/\b(stop|start|skip|come off|go off|wean off|quit)\b[^.!?]{0,30}\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|liraglutide|dulaglutide|saxenda|victoza|rybelsus|medication|meds?|medicine|insulin|tablets?|pills?)\b/i.test(m)) {
    return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: true, reason: "stopping" };
  }
  if (/\b(buy|buying|source|sourcing|get|find|where can i|where do i get|seller|supplier|black market|from a hairdresser)\b[^.!?]{0,50}\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|liraglutide|dulaglutide|saxenda|victoza|rybelsus)\b/i.test(m)
      || /\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide)\b[^.!?]{0,50}\b(buy|source|seller|supplier|black market)\b/i.test(m)) {
    return { present: true, medicationClass: "glp1", unsafeRequest: true, reason: "sourcing" };
  }
  if (/\b(side effects?|adverse reaction|bad reaction|allergic|vomiting|severe nausea|severe abdominal pain|dehydration)\b/i.test(m)
      && glp1) {
    return { present: true, medicationClass: "glp1", unsafeRequest: true, reason: "adverse_reaction" };
  }

  return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: false, reason: null };
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
  if (/\b(chest pain|chest tight|tight chest|can'?t breathe?|cannot breathe?|fainted|fainting|passed out|black(ed)? out|collapsed|seizure|convulsion|heart attack|having a stroke|had a stroke|coughing up blood)\b/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  if (/\b(hypo|hypoglyc|blood sugar (is )?(very |really )?(low|high|crashed)|sugar crash|sugar (is )?too (low|high))\b/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  if (/\b(injur|torn|sprain|fracture|broken|hernia|slipped disc|serious pain|sharp pain|severe pain)/i.test(m))
    return { should: true, reason: "injury", priority: "urgent" };
  if (/\b(back|spine|neck|shoulder|rotator|knee|ankle|wrist|elbow|hip|groin|disc|hamstring)\b/i.test(m) && /\b(hurt|pain|sore|aching)\b/i.test(m))
    return { should: true, reason: "injury", priority: "urgent" };
  if (/\b(refund|cancel.*subscription|stop.*billing|charge|payment.*issue|money back|unsubscribe)\b/i.test(m))
    return { should: true, reason: "billing", priority: "high" };
  if (/\b(pregnant|pregnan|expecting a baby|trimester|breast.?feeding|post.?partum|just had a baby|gave birth|miscarriage)/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  if (/\b(surgery|operation|post.?op|hospitalised|hospitalized|in hospital|out of (the )?hospital|admitted to hospital|stitches)/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  if (/\b(heart condition|heart disease|heart problem|cardiac|angina|pacemaker|epilep)/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  if (/\b(stop|skip|chang|increas|decreas|double|halv)\w*\b.{0,24}\b(medication|meds|insulin|tablets?|pills?|treatment|chronic meds|arvs?|antiretroviral)\b/i.test(m)
      || /\b(can i|should i|is it (ok|safe|fine))\b.{0,30}\b(medication|meds|insulin|tablets?|pills?)\b/i.test(m)
      || /\b(allergic reaction|bad reaction|side.?effects?)\b.{0,24}\b(medication|meds|tablets?|pills?|insulin)\b/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  if (/\b(dizzy|dizziness|light.?headed|blurred vision|numbness|going numb)\b/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  if (/\b(angry|furious|disgusted|worst|scam|rip.?off|waste of money|terrible|useless|report you)\b/i.test(m))
    return { should: true, reason: "frustrated", priority: "high" };
  if (/\b(speak.*human|real person|talk.*someone|manager|complain|complaint)\b/i.test(m))
    return { should: true, reason: "human_requested", priority: "normal" };
  return { should: false, reason: "", priority: "normal" };
}

export function isSyntheticTestClient(phoneNumber: string | null | undefined): boolean {
  return (phoneNumber || "").replace(/^whatsapp:/, "").replace(/\D/g, "").startsWith("2700000");
}
