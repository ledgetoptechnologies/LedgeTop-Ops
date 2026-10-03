-- The canonical API-v2 Directory phases were added ahead of the existing
-- Client Hub phases. A deployment can therefore inherit an in-progress phase
-- such as `contacts` from the previous phase list and otherwise skip the new
-- canonical roots until the following complete cycle. This migration is the
-- one-time rollout marker: keep the existing cache readable, but invalidate
-- only the reconciliation checkpoint so the next bounded pass starts at the
-- first canonical phase.
UPDATE client_hub_directory_state
SET revision=revision+1,
    generation=generation+1,
    backfill_phase=NULL,
    backfill_cursor=NULL,
    next_run_at=NULL,
    lease_token=NULL,
    lease_until=NULL
WHERE id='directory';
