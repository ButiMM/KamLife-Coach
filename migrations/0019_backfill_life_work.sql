-- #456: the profile backfill (#426) copied users.life_situation as "life/work: ..." into client_facts.
-- That column is written by code, never in the client's words: onboarding's "office" stand-in and the
-- safety owner's withheld states. The backfill no longer copies it; this removes the rows it already made.
DELETE FROM client_facts WHERE extracted_by = 'backfill:users' AND subject = 'life/work';
