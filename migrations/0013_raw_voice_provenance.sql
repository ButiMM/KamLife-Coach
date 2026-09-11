-- RAW VOICE PROVENANCE (2026-09-10).
--
-- A voice note passes three text stages before any handler sees it:
--
--     Scribe/Whisper  ->  cleanSATranscript  ->  condenseVoiceRamble (>150 words)  ->  handlers
--
-- Only the last was persisted, as `input_text` on the INNER ledger row, and even that is the
-- CONDENSED text rather than the client's words. The raw transcript existed only in a log line.
--
-- The consequence, stated as the question it makes unanswerable: when a voice turn goes wrong,
-- did we MIS-HEAR the client, or did we hear them correctly and then delete half of it in a
-- cleaning or condensing step? Those are different defects with different owners and different
-- fixes, and nothing durable could tell them apart.
--
-- Three separate columns, not one, because diffing the stages IS the diagnosis. Plus a small
-- provenance object saying which STT produced the raw text and which stages actually changed it —
-- a stage that ran and declined is not the same event as a stage that never ran.
--
-- Additive and idempotent: every statement is IF NOT EXISTS, nothing is dropped, no existing
-- column changes type or meaning, and every new column is nullable so rows written by the running
-- build before this lands stay valid. Safe to apply to a live database carrying traffic.

ALTER TABLE turn_ledger ADD COLUMN IF NOT EXISTS voice_transcript_raw TEXT;
ALTER TABLE turn_ledger ADD COLUMN IF NOT EXISTS voice_transcript_cleaned TEXT;
ALTER TABLE turn_ledger ADD COLUMN IF NOT EXISTS voice_text_for_brain TEXT;
ALTER TABLE turn_ledger ADD COLUMN IF NOT EXISTS voice_provenance JSONB;
