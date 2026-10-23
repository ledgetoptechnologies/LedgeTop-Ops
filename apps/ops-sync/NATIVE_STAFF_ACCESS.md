# Native staff Access group reconciliation

This source lane does not perform a cohort transfer or enable production access.
Migration 0225 creates a default-off singleton. Only a separately reviewed native
identity/cohort cutover may enable it; neither PA events nor this cron can enable
the control, bootstrap an administrator, or grant management authority.

The existing Ops Sync application cron derives membership from an exact join of
active native admissions, native profiles and active compatibility staff rows.
Email and bound Access subject must match. PA users, entitlements and roles never
enter this membership set. The historical compatibility helper remains separate;
the native reconciler passes an explicit, captured desired set to the provider.

Lifecycle events increment the generation in the same local D1 transaction as
the admission, compatibility status and immutable receipt. Local offboarding
therefore denies stale identities independently of Cloudflare availability. The
cron does not undo local denial when the provider fails.

Each attempt claims a 120-second D1 lease. Provider calls/retries and completion
recheck the exact lease and generation. A successful PUT also requires a managed
group readback. Only email include rules are managed; mixed or unknown include
shapes reject. Existing excludes, requirements and default-group state are
preserved and checked on readback. Provider errors are stored as static pending
codes, without response bodies or credentials.

An empty desired native cohort is held as `native-cohort-empty` before any
provider request. A ready installation must retain a native control-plane member.
There is no assumed `include: []` deny-all behavior, invented placeholder email,
or automatic rewrite of exclusion rules.

D1 leases do **not** make remote group writes atomic. A timed-out or expired
holder's PUT may finish after a newer attempt. Its acknowledgement cannot update
the newer local lease/result, but its remote body can still cause temporary
membership drift. Every cron checks current desired membership even when its
generation was previously applied, so a subsequent successful run repairs that
drift. This is convergence, not immediate or linearizable Cloudflare revocation.
Local identity/status checks remain the immediate security boundary.

`applied_generation` records an earlier successful observation. A non-null
`last_error` still means pending/degraded, even when generations match. Missing
0225 schema and the default-off control perform no provider calls. Lost responses,
provider denials, changing generations and expired leases are covered with actual
local D1 statements and provider doubles; they do not qualify a real Cloudflare
rollout or replace stale-cookie/Viewer/Windows authorization acceptance.
