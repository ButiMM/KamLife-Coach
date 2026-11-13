"use strict";
// Client picks who they are, where they train and how many days: the matching standard programme shows.
const P = window.KAMLIFE_PROGRAMMES || {};
const state = { who: "", where: "", days: "" };
const COACH = "27658829664";
const LABEL = { w: "Woman", m: "Man", gym: "Gym", db: "Home · dumbbells", multi: "Home · multi-gym", none: "Home · no equipment" };
const KEY = { "w|gym": "w-gym", "m|gym": "m-gym", "w|db": "w-db", "m|db": "m-db", "w|multi": "multi", "m|multi": "multi", "w|none": "none", "m|none": "none" };
function parse(text) {
  const lines = text.split("\n"); const head = []; const days = []; let cur = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^✅ DAY/.test(line)) { cur = { title: line.replace(/^✅\s*/, ""), lines: [] }; days.push(cur); continue; }
    if (/^❌/.test(line)) { cur = null; continue; }
    if (cur) cur.lines.push(line); else head.push(line);
  }
  return { head, days };
}
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function render() {
  const out = document.getElementById("programme"); out.textContent = "";
  for (const g of document.querySelectorAll("[data-group]")) for (const b of g.querySelectorAll("button")) b.setAttribute("aria-pressed", String(state[g.dataset.group] === b.value));
  if (!state.who || !state.where || !state.days) { out.appendChild(el("p", "hint", "Choose all three and your programme shows here.")); return; }
  const text = P[KEY[state.who + "|" + state.where]]; if (!text) return;
  const n = Number(state.days); const { head, days } = parse(text);
  const rules = head.filter(l => /^(Sets|Reps|Rest|Cardio|When|Goal)/.test(l));
  const box = el("div", "rules"); for (const r of rules) box.appendChild(el("p", "", r)); out.appendChild(box);
  days.slice(0, n).forEach((d, i) => {
    const card = el("section", "day"); card.appendChild(el("h2", "", "Day " + (i + 1) + " · " + d.title.replace(/^DAY \d+\s*[–-]\s*/, "")));
    let item = null;
    for (const l of d.lines) {
      if (!l.trim()) continue;
      if (/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(l.trim())) { if (item) { const a = el("a", "watch", "▶ Watch how"); a.href = l.trim(); a.rel = "noopener noreferrer"; a.target = "_blank"; item.appendChild(a); } continue; }
      if (/^🚶/.test(l)) { card.appendChild(el("p", "walk", "🚶 30 min walk")); continue; }
      const m = l.match(/^(?:\d️⃣|[0-9]️?⃣)\s*(.*)$/u);
      if (m) {
        const parts = m[1].split("→"); item = el("div", "ex"); item.appendChild(el("strong", "", parts[0].trim()));
        if (parts[1]) item.appendChild(el("span", "sets", parts[1].trim())); card.appendChild(item); continue;
      }
      if (/^→/.test(l) && item) { item.appendChild(el("span", "sets", l.replace(/^→\s*/, ""))); continue; }
    }
    if (!card.querySelector(".walk")) card.appendChild(el("p", "walk", "🚶 30 min walk"));
    out.appendChild(card);
  });
  out.appendChild(el("p", "hint", "Rest or walk on the other days. Send me a ✅ on WhatsApp after every session."));
  // One tap puts the programme into the client's chat with the coach, so both of them can pin it.
  const lines = ["📌 My KamLife program", `${LABEL[state.who]} · ${LABEL[state.where]} · ${n} days a week`, ""];
  days.slice(0, n).forEach((d, i) => {
    lines.push(`✅ DAY ${i + 1} – ${d.title.replace(/^DAY \d+\s*[–-]\s*/, "")}`);
    let k = 0;
    for (const l of d.lines) { const m = l.match(/^(?:\d️⃣|[0-9]\uFE0F?\u20E3)\s*(.*)$/u); if (m) { k++; const parts = m[1].split("→"); lines.push(`${k}. ${parts[0].trim()}${parts[1] ? " → " + parts[1].trim() : ""}`); } else if (/^→/.test(l.trim()) && k) { lines[lines.length - 1] += " " + l.trim(); } }
    lines.push("🚶 30 min walk", "");
  });
  lines.push("Videos: https://www.kamlife.co.za/plan/");
  const a = el("a", "send", "Send my program to the coach ↗");
  a.href = `https://api.whatsapp.com/send?phone=${COACH}&text=${encodeURIComponent(lines.join("\n"))}`; a.rel = "noopener noreferrer";
  out.appendChild(a);
  out.appendChild(el("p", "hint", "It opens WhatsApp with your program written out. Send it, then long-press it and tap Pin, so it stays at the top of our chat."));
}
document.addEventListener("click", e => { const b = e.target.closest("[data-group] button"); if (!b) return; state[b.parentElement.dataset.group] = b.value; render(); });
render();
