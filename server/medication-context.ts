/** Deterministic medication context boundary. Context is allowed; medication advice is not. */

export interface MedicationContextDecision {
  present: boolean;
  medicationClass: "glp1" | "other" | null;
  unsafeRequest: boolean;
  reason: "dosing" | "titration" | "stopping" | "sourcing" | "adverse_reaction" | "choosing" | "timing" | null;
}

const GLP1_RE = /\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|liraglutide|dulaglutide|saxenda|victoza|rybelsus)\b/i;
// #709: and the chronic scripts our clients name instead of saying "my medication".
// #718: and the words for medicine our clients write in Afrikaans, isiZulu, isiXhosa and Setswana.
const NAMED = "metformin|glucophage|amlodipine|enalapril|hydrochlorothiazide|hctz|losartan|simvastatin|atorvastatin|arvs?|tld|dolutegravir|tenofovir|efavirenz|pille|medisyne|tablette|amaphilisi|imithi|ipilisi|dipilisi|melemo";
const MED_RE = /\b(medication|meds?|medicine|insulin|tablets?|pills?|prescription|treatment|antibiotics?|painkillers?|antidepressants?|metformin|glucophage|amlodipine|enalapril|hydrochlorothiazide|hctz|losartan|simvastatin|atorvastatin|arvs?|tld|dolutegravir|tenofovir|efavirenz|pille|medisyne|tablette|amaphilisi|imithi|ipilisi|dipilisi|melemo)\b/i; // the same names as NAMED
// A named medicine keeps the wide window. A bare "it"/"them" needs the timing words within three words, and never
// "before"/"after": "can I take it slow and walk after supper" is about walking (#716 ATTACK @ c81c01d).
const A_MEDICINE = `(?:my\\s+|the\\s+)?(?:medication|meds?|medicine|insulin|tablets?|pills?|${NAMED})`;
const THE_MEDICINE = `(?:it(?!\\s+easy)|them|${A_MEDICINE})`;

export function detectMedicationContext(message: string): MedicationContextDecision {
  const m = String(message || "").toLowerCase().replace(/\bmedicine\s+balls?\b/g, "med-ball"); // equipment, not a medicine (#679)
  const glp1 = GLP1_RE.test(m);
  const present = glp1 || MED_RE.test(m);
  if (!present) return { present: false, medicationClass: null, unsafeRequest: false, reason: null };

  if (/\b(what|which|how much|how many)\b[^.!?]{0,40}\b(dose|dosage|mg|units?|clicks?)\b/i.test(m)
      || /\bhow\s+much\s+(?:ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide)\b/i.test(m)) {
    return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: true, reason: "dosing" };
  }
  // The change verb must act ON the medicine (#380 attack): "increase protein because I'm on insulin"
  // changes protein. A clause joiner or "on"/"with"/"taking" between them breaks the bind.
  if (new RegExp(`\\b(titrate|titration|increase|decrease|raise|lower|double|halve|step up|step down)\\b(?:(?!\\b(?:because|since|as|while|when|and|but|so|if|cause|cos|coz|though|although|on|with|take|taking|after|before)\\b)[^.!?]){0,40}\\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|liraglutide|dulaglutide|saxenda|victoza|rybelsus|medication|meds?|medicine|insulin|tablets?|pills?|dose|dosage|${NAMED})\\b`, "i").test(m)) {
    return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: true, reason: "titration" };
  }
  if (new RegExp(`\\b(stop|start|skip|come off|go off|wean off|quit)\\b[^.!?]{0,30}\\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|liraglutide|dulaglutide|saxenda|victoza|rybelsus|medication|meds?|medicine|insulin|tablets?|pills?|${NAMED})\\b`, "i").test(m)) {
    return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: true, reason: "stopping" };
  }
  if (/\b(buy|buying|source|sourcing|get|find|where can i|where do i get|seller|supplier|black market|from a hairdresser)\b[^.!?]{0,50}\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|liraglutide|dulaglutide|saxenda|victoza|rybelsus)\b/i.test(m)
      || /\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide)\b[^.!?]{0,50}\b(buy|source|seller|supplier|black market)\b/i.test(m)) {
    return { present: true, medicationClass: "glp1", unsafeRequest: true, reason: "sourcing" };
  }
  if (/\b(side effects?|adverse reaction|bad reaction|allergic|vomiting|severe nausea|severe abdominal pain|dehydration)\b/i.test(m) && glp1) {
    return { present: true, medicationClass: "glp1", unsafeRequest: true, reason: "adverse_reaction" };
  }
  // WHEN TO TAKE IT (#709): "can I take my metformin at night instead of morning?" changes how a prescription is taken.
  if (new RegExp(`\\b(?:can|could|should|may)\\s+i\\s+(?:still\\s+)?take\\s+(?:${A_MEDICINE}\\b[^.!?]{0,40}\\b(?:at\\s+night|in\\s+the\\s+(?:morning|evening)|instead\\s+of|later|earlier|before|after)|(?:it(?!\\s+(?:easy|slow|one\\s+day))|them)\\s+(?:\\S+\\s+){0,3}?(?:at\\s+night|in\\s+the\\s+(?:morning|evening)|instead\\s+of|later|earlier))\\b|\\b(?:swap|move|switch|change|shift)\\s+(?:the\\s+time\\s+(?:of|i\\s+take)\\s+)?${THE_MEDICINE}\\b[^.!?]{0,30}\\b(?:night|morning|evening|later|earlier|time)\\b`, "i").test(m)) {
    return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: true, reason: "timing" };
  }
  // …in Afrikaans (#718): "kan ek dit saans drink?" after "ek drink my pille in die oggend".
  if (/\bkan\s+ek\s+(?:dit|hulle|my\s+\S+)\s+(?:saans|soggens|later|vroeër|vroeer|in\s+die\s+(?:aand|oggend))\s+(?:drink|neem|vat)\b/i.test(m)) {
    return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: true, reason: "timing" };
  }
  // CHOOSING A MEDICINE (#321): "what antibiotic should I take for a sore throat" asks the coach to
  // prescribe. Not an emergency, not coaching — the scope gate points it to a doctor or pharmacist.
  // …and auxiliary-first (#353): "Can I take an antibiotic for my sore throat?", "Should I use painkillers for this headache?".
  if (/\b(what|which)\s+(antibiotics?|medication|medicine|meds|pills?|tablets?|painkillers?|antidepressants?)\b[^.!?]{0,40}\b(should|can|must|do)\s+i\s+(take|use|get|buy)\b|\b(can|could|should|may|do)\s+i\s+(take|use|get|buy|have)\s+(?:an?\s+|some\s+)?(antibiotics?|medication|medicine|meds|pills?|tablets?|painkillers?|antidepressants?)\b[^.!?]{0,30}\bfor\b/i.test(m)) {
    return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: true, reason: "choosing" };
  }
  return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: false, reason: null };
}
