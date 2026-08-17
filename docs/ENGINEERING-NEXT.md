# KamLife Engineering Next

## Current main state

The current production line has the decision boundary, returning-client state, provenance-aware step state, replayable turn decisions, and successful executor mutation recording merged into `main`.

## Next P0/P1 queue

### 1. Safety/context: GLP-1 medication awareness

The deterministic safety detector handles acute medical risk, pregnancy/postpartum, surgery/hospitalisation, cardiac/seizure conditions, medication changes/adverse reactions, and crisis. It does not currently treat GLP-1/weight-management medication context as a first-class state signal.

Design requirement: medication awareness is a safety/context layer, not a coaching feature. KamLife must not advise on dosing, titration, sourcing, substitution, or stopping medication. A future implementation should add deterministic detection + regression cases before wiring it into the live decision boundary.

### 2. Turn-ledger failure categories

`turn_ledger.failure_category` exists in the schema (`STATE | UNDERSTANDING | REASONING | ACTION | RESPONSE`) but the current ledger writer does not yet persist a live classification. Add this only after tracing the real top-level failure boundaries so the classifier describes the actual failure owner rather than guessing from error text.

### 3. Canonical re-entry ownership

The repository has an explicit persisted returning-client signal, but re-entry messaging still has historical handler ownership. Consolidate the user-facing re-entry response behind one canonical owner without changing the existing no-shame/no-backfill behavior.

### 4. Event spine

Strengthen chronological event reconstruction so raw input -> canonical events -> provenance/uncertainty -> longitudinal state -> decision is inspectable as one path. Do not replace the current handlers wholesale; use the existing event/ledger infrastructure as the seam.

## Guardrails for the builder

- Do not chase tracker feature parity with FitSorted.
- Do not increase prompt size as a substitute for deterministic decision ownership.
- Do not collect data unless it can change the next instruction.
- Do not infer behaviour from missing data without first establishing why it is missing.
- CONTINUE / CHANGE / INVESTIGATE / REFER remain the canonical coaching outcomes.
- The least intervention justified by evidence remains the product rule.
