-- #456: the profile backfill (#426) copied users.life_situation as "life/work: ..." into client_facts.
-- Two of its values are not the client's words: onboarding's "office" stand-in and the safety owner's
-- withheld states. The backfill no longer copies those; this removes the rows it already made. A state
-- the client stated (postpartum_breastfeeding) is kept.
DELETE FROM client_facts WHERE extracted_by = 'backfill:users' AND subject = 'life/work'
  AND statement IN ('life/work: office', 'life/work: pregnant', 'life/work: disordered_eating');
