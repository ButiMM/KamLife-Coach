"""Counts Coach K's "mouths" (every outbound send path counts: sendWhatsApp, deliverTwilioMessage, sendCriticalAlert and raw Twilio messages.create): the places that can decide or send a reply outside the one coach.
The mouth ratchet fails any PR that increases a count. Counts only ever go down."""
import json, re, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
L = (root / "server/routes.ts").read_text().split("\n")
start = next(i for i, l in enumerate(L) if re.search(r"async function routeMessage|function routeMessage|routeMessage\s*=", l))
eng = next((i for i, l in enumerate(L) if i > start and "runMeaningEngineLive" in l), len(L))
counts = {
    "routeMessage_exits_before_engine": sum(1 for i in range(start, eng) if re.search(r"\breturn\b", L[i])),
    "outbound_send_sites": 0,
    "files_that_send": 0,
    "model_call_sites": 0,
    "test_lines": 0,
}
MODEL = re.compile(r"\.(?:chat\.completions|responses|audio\.transcriptions|audio\.speech|embeddings)\.create\(")
SEND = re.compile(r"\b(?:sendWhatsApp|deliverTwilioMessage|sendCriticalAlert)\(|\.messages\.create\(")
DEF = re.compile(r"function (?:sendWhatsApp|deliverTwilioMessage|sendCriticalAlert)\(")
for f in (root / "server").rglob("*.ts"):
    t = f.read_text(errors="ignore")
    n = len(SEND.findall(t)) - len(DEF.findall(t))
    counts["outbound_send_sites"] += n
    counts["files_that_send"] += 1 if n else 0
    counts["model_call_sites"] += len(MODEL.findall(t))
# Test-code ratchet (CTO, 30 Sep): tests grew 57,037 -> 60,457 lines while the product was meant to shrink.
# New tests must be paid for by deleting obsolete ones (old-pipeline harnesses for deleted code).
counts["test_lines"] = sum(len(f.read_text(errors="ignore").splitlines()) for f in (root / "script").rglob("*")
                           if f.is_file() and f.suffix in (".ts", ".sh", ".mjs", ".py", ".sql"))
if "--json" in sys.argv:
    print(json.dumps(counts)); sys.exit(0)
base = json.loads((root / "docs/mouths.json").read_text())
worse = {k: (base[k], v) for k, v in counts.items() if v > base.get(k, v)}
for k, v in counts.items():
    print(f"{k}: {v} (baseline {base.get(k)})")
if worse:
    import os
    if "mouth:approved" in os.environ.get("PR_LABELS", ""):
        print("\nCounts went up, but the CTO approved it (label mouth:approved):", worse)
        sys.exit(0)
    print("\nMOUTH RATCHET FAILED: these went up:", worse)
    print("Only the CTO can approve an increase, with the label mouth:approved (e.g. a deterministic safety override).")
    sys.exit(1)
print("\nMouth ratchet OK. If any count went down, update docs/mouths.json in this PR.")
