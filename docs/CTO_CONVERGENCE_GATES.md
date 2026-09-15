# KamLife — CTO Convergence Gates

**Baseline:** `main@dc3c308c7fcdaf0bc62f207622c4ed738765f3d6`

This file is an implementation gate, not a new architecture.

## Non-negotiable invariants

1. One turn → one owner → one decision → one terminal response.
2. Ownership cannot be accidental.
3. Deterministic commands remain deterministic.
4. Coaching turns cannot fall backward into competing coaching authorities.
5. One source of truth per fact; no mega-state.
6. Real customer conversations are the acceptance standard.
7. Defects use U/S/D/W/R/C/P/I.
8. Every confirmed real failure becomes regression protection.
9. No rebuilds: no Pulse 2, Memory 3, new brain, or replacement architecture without proof of incapability.
10. No new authority without explicit justification.

## Implementation gate

Before changing behaviour, the builder must identify:

- the exact customer-visible failure;
- the current SHA/path where it occurs;
- the first divergence in the turn;
- the existing owner or boundary responsible for that divergence;
- the smallest existing-boundary change that can correct it;
- the acceptance test proving the correction.

A design proposal is not evidence. A code smell is not a failure trace. A green unit test is not proof of customer behaviour.

## Explicitly prohibited without new evidence

- `KamLifeState` or any mega-state replacement;
- universal Meaning Engine ownership;
- global fail-closed behaviour;
- a new central brain/router/orchestrator;
- bulk handler rewrites;
- prompt-system restructuring;
- deleting legacy modules merely because they are old;
- new authority layers that duplicate an existing owner.

## Prompt rule

The 20,000-character `COACH_K_SYSTEM` hot-path slice is intentional. Do not remove or restructure it as part of convergence. Prompt work is limited to verifying path coverage and documenting which doctrine reaches which model path.

## Runtime-observability rule

If the existing turn ledger/logging cannot identify the non-model component responsible for a final response, add the smallest instrumentation required to establish that fact. Instrumentation is permitted; new observability architecture is not.

## Implementation rule

When the evidence identifies a specific seam, patch the seam. Do not generalise a local failure into a repository-wide rewrite.
