// Company payment details: edit a value here once to update its display and Copy button.
const BANK = "FNB / RMB";
const ACCOUNT_NAME = "KamLife (Pty) Ltd";
const ACCOUNT_NUMBER = "63222881525";
const ACCOUNT_TYPE = "Gold Business Account";
const BRANCH_CODE = "250655";
const MONTHLY_PRICE = 250;
const UPFRONT_PRICE = 700;
const UPFRONT_MONTHS = 3;
const COACH_PHONE = "27658829664";
const PROOF_MESSAGE = "Hi Coach, here's my proof of payment 🧡";
;
"use strict";
const BANK_ROWS = [["Bank",BANK],["Account name",ACCOUNT_NAME],["Account number",ACCOUNT_NUMBER],["Account type",ACCOUNT_TYPE],["Branch code",BRANCH_CODE]];
const bankCard = document.getElementById("bankDetails");
for (const [label,value] of BANK_ROWS) {
 const row=document.createElement("div"), text=document.createElement("div"), key=document.createElement("span"), val=document.createElement("span"), button=document.createElement("button");
 row.className="bank-row";key.className="bank-label";key.textContent=label;val.className="bank-value";val.textContent=value;text.append(key,val);
 button.className="copy-bank";button.type="button";button.textContent="Copy";button.setAttribute("aria-label",`Copy ${label.toLowerCase()}`);
 button.addEventListener("click",async()=>{
  try {if(!navigator.clipboard?.writeText)throw new Error("Clipboard unavailable");await navigator.clipboard.writeText(value);button.textContent="Copied";document.getElementById("bankCopyStatus").textContent=`${label} copied.`;row.querySelector(".bank-manual")?.remove();}
  catch {document.getElementById("bankCopyStatus").textContent="Clipboard blocked. Select and copy the text below.";let manual=row.querySelector(".bank-manual");if(!manual){manual=document.createElement("div");manual.className="bank-manual";const field=document.createElement("textarea"),note=document.createElement("p");field.value=value;field.readOnly=true;field.setAttribute("aria-label",`${label} to select and copy`);note.textContent="Press and hold to select this text, then copy.";manual.append(field,note);row.append(manual);}const field=manual.querySelector("textarea");field.focus();field.select();}
 });
 row.append(text,button);bankCard.append(row);
}
let fallbackTimer=null;
document.getElementById("proofLink").addEventListener("click",()=>{clearTimeout(fallbackTimer);fallbackTimer=setTimeout(()=>{document.getElementById("fallback").hidden=false;},1500);});
document.getElementById("copyMessage").addEventListener("click",async()=>{try{if(!navigator.clipboard?.writeText)throw new Error("Clipboard unavailable");await navigator.clipboard.writeText(PROOF_MESSAGE);document.getElementById("copyStatus").textContent="Copied. Paste it into your WhatsApp chat.";}catch{document.getElementById("copyStatus").textContent="Press and hold the message below, then copy it.";const box=document.createElement("textarea");box.className="message-copy";box.readOnly=true;box.setAttribute("aria-label","Your message to copy");box.value=PROOF_MESSAGE;document.getElementById("manualCopy").replaceChildren(box);box.focus();box.select();}});
