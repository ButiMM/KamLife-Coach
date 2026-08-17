/** Deterministic medication context boundary. Context is allowed; medication advice is not. */

export interface MedicationContextDecision {
  present: boolean;
  medicationClass: "glp1" | "other" | null;
  unsafeRequest: boolean;
  reason: "dosing" | "titration" | "stopping" | "sourcing" | "adverse_reaction" | null;
}

const GLP1_RE = /\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|liraglutide|dulaglutide|saxenda|victoza|rybelsus)\b/i;
const MED_RE = /\b(medication|meds?|medicine|insulin|tablets?|pills?|prescription|treatment)\b/i;

export function detectMedicationContext(message: string): MedicationContextDecision {
  const m = String(message || "").toLowerCase();
  const glp1 = GLP1_RE.test(m);
  const present = glp1 || MED_RE.test(m);
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
  if (/\b(side effects?|adverse reaction|bad reaction|allergic|vomiting|severe nausea|severe abdominal pain|dehydration)\b/i.test(m) && glp1) {
    return { present: true, medicationClass: "glp1", unsafeRequest: true, reason: "adverse_reaction" };
  }
  return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: false, reason: null };
}
