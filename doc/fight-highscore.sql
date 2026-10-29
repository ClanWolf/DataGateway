-- Obsolete: highscore PCP are calculated live from the current PCP_AUX reference
-- and fight_teamsize. No per-fight PCP column or highscore migration is needed.
-- Only fight-teamsize.sql remains a deployment prerequisite.
-- If an earlier version added pcp_awarded, that column is now unused.
-- This file intentionally performs no database changes or historical backfill.

