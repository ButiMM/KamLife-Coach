# Status log

One line per merged PR: `HH:MM SAST · agent · PR # · what changed · gate before → after · +lines / −lines`.
"gate n/a" until the replay gate (#270, PR #298) records its first live baseline (blocked on the OpenAI key, 401).

23 Sep 13:22 · Claude Code · #277 · Cancelling stops PayFast billing; a charge after cancelling no longer reactivates the client; ITN signature order fixed · gate n/a · +840 / −33
23 Sep 22:59 · Claude Code · #283 · Pregnancy and disordered eating routed before any reply; numbers withheld on both doors; founder alerted · gate n/a · +563 / −25
24 Sep 10:40 · Claude Code · #304 · One sex- and age-aware calorie floor read by every target writer; no man below 1,500 kcal · gate n/a · +309 / −20
24 Sep 10:57 · Claude Code · #285 · Opt-out in the client's own words, honoured on every send path including payments and broadcasts · gate n/a · +591 / −100
24 Sep 12:09 · Claude Code · #307 · "Delete my data" deletes the client row and everything that cascades; billing cancelled first; true copy · gate n/a · +323 / −44
24 Sep 12:09 · Claude Code · #290 · No log-a-meal nags to a present client, no invented absences, weigh-in ask at most weekly, "finished dinner" logs, trial removed · gate n/a · +653 / −484
24 Sep 13:47 · Claude Code · #367 · AI spend cap fails safe: account-wide daily hard ceiling; unreadable spend means "over"; the meaning engine checks the cap · gate n/a · +325 / −47
24 Sep 13:47 · Claude Code · #352 · Dead code deleted: Replit scaffolding and its two tables, 15 unscheduled jobs, 28 UI components, 13 scripts · gate n/a · +78 / −6,737
24 Sep 13:55 · Claude Code · #374 · npm audit 12 → 0 vulnerabilities, lockfile only · gate n/a · +275 / −737
24 Sep 13:56 · Claude Code · #372 · Delivery-status webhook refuses every request without a Twilio token · gate n/a · +73 / −9
24 Sep 14:04 · Claude Code · #298 · Customer replay gate on main: 39 cases, 8 journeys, live model and judge, reply time and cost · gate none → main baseline 3/33 hard failing, journeys 7 / 7.2 / 6.2 / 4.0 / 6.5 / 8 / 5.5 / 7.9 · +1,107 / −0
