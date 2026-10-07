# Tester truth

What testers actually received, measured every day, with no model call (CTO, 7 Oct).

## How it is measured

- **Source:** every delivered reply in `turn_ledger` (the body that went out, after every floor).
- **Defects:** each reply runs through the same scanner as the founder's `audit` command (`server/audit/reply-defects.ts`): menu dumps, walls of text, invented foods, "train" after they trained, dead promises, generic advice, and the rest.
- **Handler:** each reply is attributed to the handler that produced it, using the `source` the turn already records (`decision.source`, the `tag`). "Handler → share of replies" is the measure of how much the new coach really answers.
- **The worst five:** the day's defective replies first, then the replies the client reacted badly to (D7's signals: a correction, a rejection, venting, "you forgot", an opt-out, silence after a question).

## Where it goes

| What | Who sees it | When |
|---|---|---|
| The day's numbers, the handlers, the five worst replies quoted (last 3 digits only), and who went quiet after a reply | The founder, on WhatsApp | Every day at 07:00 SAST, with the morning inbox |
| The aggregate report: defects by detector, handler → share of replies, over 7 days (no client words, no numbers) | `GET /api/admin/tester-truth?days=7` (admin key) | On demand |

Client words never go into this repository (POPIA). This file holds only the aggregate report.

## The latest report

_Not yet generated. Paste the output of `/api/admin/tester-truth?days=7` here, or have the watch refresh it once it has an admin key (see the PR that added this file)._
