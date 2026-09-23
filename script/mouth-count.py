"""Counts Coach K's "mouths": the places that can decide or send a reply outside the one coach.
The mouth ratchet fails any PR that increases a count. Counts only ever go down."""
import json, re, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
L = (root / "server/routes.ts").read_text().split("\n")
start = next(i for i, l in enumerate(L) if re.search(r"async function routeMessage|function routeMessage|routeMessage\s*=", l))
eng = next((i for i, l in enumerate(L) if i > start and "runMeaningEngineLive" in l), len(L))
counts = {
    "routeMessage_exits_before_engine": sum(1 for i in range(start, eng) if re.search(r"\breturn\b", L[i])),
    "sendWhatsApp_call_sites": 0,
    "files_that_send": 0,
}
for f in (root / "server").rglob("*.ts"):
    t = f.read_text(errors="ignore")
    n = len(re.findall(r"\bsendWhatsApp\(", t)) - len(re.findall(r"function sendWhatsApp\(", t))
    counts["sendWhatsApp_call_sites"] += n
    counts["files_that_send"] += 1 if n else 0
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
