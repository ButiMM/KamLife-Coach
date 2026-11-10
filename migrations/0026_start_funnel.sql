-- Anonymous daily counts for the /start bio-link page: which step people reach and where they came from.
-- No names, answers or health data; a non-fit outcome is stored only as 'OTHER'.
CREATE TABLE IF NOT EXISTS start_funnel_counts (
  day DATE NOT NULL,
  step TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  src TEXT NOT NULL DEFAULT 'LINK',
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, step, outcome, src)
);
