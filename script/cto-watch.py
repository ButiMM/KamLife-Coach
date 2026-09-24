"""CTO watch: runs every 20 minutes and on PR/comment events. Keeps the build loop moving
without the founder relaying anything. No AI, no secrets beyond GITHUB_TOKEN."""
import json, os, re, urllib.request, datetime as dt
T, R = os.environ["GH_TOKEN"], os.environ["REPO"]
NOW = dt.datetime.now(dt.timezone.utc)
ATTACK_WINDOW = dt.timedelta(minutes=45)
IDLE_AFTER = dt.timedelta(minutes=60)

def api(method, path, body=None):
    req = urllib.request.Request(f"https://api.github.com/repos/{R}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {T}", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"{}")

def ts(s): return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
def comment_once(n, marker, text, comments):
    if not any(marker in c["body"] for c in comments):
        api("POST", f"/issues/{n}/comments", {"body": f"{text}\n\n<!-- {marker} -->"})
        return True
    return False

rows = []
alerts = []
open_prs = [p for p in api("GET", "/pulls?state=open&per_page=50")
            if any(l["name"] == "attack:codex" for l in p["labels"])]
for p in open_prs:
    n, sha = p["number"], p["head"]["sha"]
    short = sha[:10]
    comments = api("GET", f"/issues/{n}/comments?per_page=100")
    if "What testers will notice" not in (p["body"] or ""):
        comment_once(n, f"cto-notice-{n}", "**CTO watch:** the description must open with \"What testers will notice:\" (CLAUDE.md standing orders).", comments)
    human = [c for c in comments if not c["user"]["login"].endswith("[bot]") or "codex" in c["user"]["login"]]
    human = [c for c in human if "<!-- cto-" not in c["body"]]
    attacks = [c for c in human if re.match(rf"^[*_\s]*ATTACK @ `?{sha[:7]}", c["body"])]
    answers = [c for c in human if re.match(r"^[*_\s]*ANSWER", c["body"])]
    commits = api("GET", f"/pulls/{n}/commits?per_page=100")
    head_time = ts(commits[-1]["commit"]["committer"]["date"]) if commits else ts(p["created_at"])
    if not attacks:
        state = "waiting for Codex attack"
        comment_once(n, f"cto-attack-{sha}", f"@codex attack this PR at head `{short}` per docs/ORDERS.md §6. Start your comment with `ATTACK @ {sha[:7]}`.", comments)
        if NOW - head_time > ATTACK_WINDOW:
            state = "attack window passed: builder may merge if tests pass; Codex attacks after merge"
            comment_once(n, f"cto-window-{sha}", f"**CTO watch:** no Codex attack at `{short}` within 45 minutes. Per CLAUDE.md, the builder may merge once tests pass; any later finding goes to the top of docs/QUEUE.md.", comments)
    elif answers and ts(answers[-1]["created_at"]) > ts(attacks[-1]["created_at"]):
        state = "attack answered: ready to merge when tests pass"
    else:
        state = "attack unanswered: builder must answer"
        age = int((NOW - ts(attacks[-1]["created_at"])).total_seconds() // 60)
        if age > 30:
            alerts.append(f"**Blocked:** #{n} has had a Codex attack unanswered for {age} min. Answer it before new work (CLAUDE.md priority order).")
        comment_once(n, f"cto-answer-{attacks[-1]['id']}", "**CTO watch:** Codex's attack above is unanswered. Reply with a comment starting `ANSWER`: the fix commit, or why it doesn't apply.", comments)
    try:
        runs = api("GET", f"/commits/{sha}/check-runs?per_page=100").get("check_runs", [])
    except Exception:
        runs = []
    failing = sorted({r["name"] for r in runs if r["conclusion"] in ("failure", "timed_out", "cancelled")})
    pending = sorted({r["name"] for r in runs if r["status"] != "completed"})
    checks = "failing: " + ", ".join(failing) if failing else ("running: " + ", ".join(pending) if pending else ("green" if runs else "none"))
    if failing:
        comment_once(n, f"cto-checks-{sha}", f"**CTO watch:** checks failing at `{short}`: {', '.join(failing)}. Fix these before new work (CLAUDE.md priority order).", comments)
    db = [c for c in human if re.match(rf"^[*_\s]*DBSUITE @ `?{sha[:7]}", c["body"])]
    ready = any(l["name"] == "ready" for l in p["labels"])
    if db:
        dbs = "PASS" if "PASS" in db[-1]["body"][:60] else ("UNAVAILABLE" if "UNAVAILABLE" in db[-1]["body"][:80] else "FAIL")
        if dbs == "UNAVAILABLE":
            alerts.append(f"**DB suite unavailable** on #{n}: Codex can't run it. CTO decides the fallback (docs/ORDERS.md).")
    elif ready:
        dbs = "owed by Codex"
        comment_once(n, f"cto-db-{sha}", f"@codex this PR is labelled `ready`. Run the database suite on head `{short}` per AGENTS.md step 6 and post `DBSUITE @ {sha[:7]}: PASS|FAIL|UNAVAILABLE`.", comments)
    else:
        dbs = "not ready"
    rows.append(f"| #{n} | {p['title'][:60]} | `{short}` | {state} | {checks} | {dbs} |")

queue = open("docs/QUEUE.md").read()
todo = [l[6:] for l in queue.splitlines() if l.startswith("- [ ] ")]
done = [l[6:] for l in queue.splitlines() if l.startswith("- [x] ")]
merged = [p for p in api("GET", "/pulls?state=closed&sort=updated&direction=desc&per_page=30") if p.get("merged_at")]
today = [p for p in merged if ts(p["merged_at"]).date() == NOW.date()]
last_merge = max((ts(p["merged_at"]) for p in merged), default=None)
post_merge_pending = []
for p in merged:
    if not any(l["name"] == "attack:codex" for l in p["labels"]) or NOW - ts(p["merged_at"]) > dt.timedelta(days=2):
        continue
    sha = p["head"]["sha"]
    pcs = api("GET", f"/issues/{p['number']}/comments?per_page=100")
    hit = [c for c in pcs if "<!-- cto-" not in c["body"] and re.match(rf"^[*_\s]*ATTACK @ `?{sha[:7]}", c["body"])]
    if not hit:
        post_merge_pending.append(p["number"])
        comment_once(p["number"], f"cto-postmerge-{sha}", f"@codex this PR merged at head `{sha[:10]}` without an attack on that exact version. Attack it now (post-merge) per docs/ORDERS.md §6. Start with `ATTACK @ {sha[:7]}`. Any finding goes to the top of docs/QUEUE.md.", pcs)
if post_merge_pending:
    alerts.append("**Post-merge attacks owed by Codex:** " + ", ".join(f"#{n}" for n in post_merge_pending))
if len(open_prs) >= 3 and not [p for p in today if p["title"].startswith(("[harm]", "[core]", "[visible]"))]:
    alerts.append(f"**Nothing reaching testers:** {len(open_prs)} build PRs open, none merged today. Close out open PRs before starting more.")
if todo and not open_prs and last_merge and NOW - last_merge > IDLE_AFTER:
    alerts.append(f"**Idle:** no open build PR and nothing merged for {int((NOW-last_merge).total_seconds()//60)} min, with {len(todo)} queue items left. Next: {todo[0]}")

import subprocess
try:
    mouths = json.loads(subprocess.run(["python3", "script/mouth-count.py", "--json"], capture_output=True, text=True).stdout)
    mouth_line = "**Mouths on main:** " + ", ".join(f"{k} {v}" for k, v in mouths.items())
except Exception:
    mouth_line = "**Mouths on main:** unavailable"
body = "\n".join([
    f"_Updated {NOW:%H:%M} UTC by the CTO watch. Runs every 15 minutes and on PR open/push/merge._", "",
    *(alerts or ["No alerts."]), "",
    mouth_line, "",
    f"**Queue:** {len(done)} done, {len(todo)} left. Next: {todo[0] if todo else 'queue empty'}", "",
    "| PR | Title | Head | Attack | GitHub checks | DB suite (Codex) |", "|---|---|---|---|---|---|", *(rows or ["| none | | | | | |"]), "",
    "**Merged today (UTC):**",
    *([f"- #{p['number']} {p['title'][:70]}" for p in today] or ["- none"]),
])
issues = api("GET", "/issues?state=open&labels=cto-watch&per_page=5")
if issues:
    api("PATCH", f"/issues/{issues[0]['number']}", {"body": body})
else:
    api("POST", "/issues", {"title": "CTO watch: live build status", "body": body, "labels": ["cto-watch"]})
print(body)
