-- THERE IS NO TRIAL (#275). trialed_numbers held a salted hash of every number ever granted a free
-- trial, kept through account deletion so the one-trial-per-number rule survived it. The rule and
-- its only reader and writer are deleted, so the hashes serve no decision and are not kept.
DROP TABLE IF EXISTS "trialed_numbers";
