-- The canonical API-v2 Directory phases were added ahead of the existing
-- Client Hub phases. A deployment can therefore inherit an in-progress phase
-- such as `contacts` from the previous phase list and otherwise skip the new
-- canonical roots until the following complete cycle. This migration is the
-- one-time rollout marker. Fence reads until the replacement generation has
-- completed its final sweep; otherwise a newly written canonical root and a
-- prior-generation legacy mirror can be visible together between bounded
-- passes. No membership, grant, Delivery/public-link, or source row changes.
UPDATE client_hub_directory_state
SET ready=0,
    revision=revision+1,
    generation=generation+1,
    backfill_phase=NULL,
    backfill_cursor=NULL,
    next_run_at=NULL,
    lease_token=NULL,
    lease_until=NULL
WHERE id='directory';
