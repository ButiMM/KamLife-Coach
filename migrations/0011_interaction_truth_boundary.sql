-- CUT 1 — THE CUSTOMER-VISIBLE TRUTH BOUNDARY (2026-09-10).
--
-- turn_ledger has recorded what the HANDLERS decided since 2026-08-10. It has never recorded what
-- the client actually received. Between recordTurn and Twilio sit marker rendering, the outbound
-- truth floor, provenance, hygiene, the marker strip and the never-silent repairs — any of which
-- can replace the body — and none of them left a trace.
--
-- Proven on 7833ebb before this migration was written:
--   · ledger "…what do you need?[BUTTONS:Today's workout|Log food|My progress]"
--     wire   "…what do you need?\n\n▸ *Today's workout*\n▸ *Log food*\n▸ *My progress*"
--   · the same question asked twice: wire[1] was the outbound repair sentence, while BOTH ledger
--     rows showed the correct coaching reply. The failure was structurally invisible.
--
-- Additive and idempotent: every statement is IF NOT EXISTS, no column is dropped, no existing
-- column changes type or meaning, and every new column is nullable so rows written by the running
-- build before this lands stay valid. Safe to apply to a live database with traffic on it.

ALTER TABLE turn_ledger ADD COLUMN IF NOT EXISTS root_id TEXT;
ALTER TABLE turn_ledger ADD COLUMN IF NOT EXISTS input_text_canonical TEXT;
ALTER TABLE turn_ledger ADD COLUMN IF NOT EXISTS decision JSONB;
ALTER TABLE turn_ledger ADD COLUMN IF NOT EXISTS delivered_body TEXT;
ALTER TABLE turn_ledger ADD COLUMN IF NOT EXISTS outbound_verdict JSONB;
ALTER TABLE turn_ledger ADD COLUMN IF NOT EXISTS delivery_outcome TEXT;

-- Correlation index. The transport finalises a row by its id, but every read that asks "what
-- happened to this client message" starts from the root id, and a voice note produces two rows
-- under one root.
CREATE INDEX IF NOT EXISTS turn_ledger_root_idx ON turn_ledger (root_id);
