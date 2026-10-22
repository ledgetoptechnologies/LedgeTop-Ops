# Retained UI asset planner (offline only)

The backend production adapter deliberately refuses UI deployments. This draft adds an offline union validator without changing that prohibition, Cloudflare settings or upload code. It requires an explicitly reviewed inventory digest and local payload bytes tied to a recognized Worker, active version and opaque asset association.

The validator checks every retained file against that supplied inventory, refuses symlinks/hardlinks/path ambiguities and immutable URL overwrites, retains historical assets, permits only the entry HTML to advance, and returns an exact rollback manifest. It performs no writes or provider calls. The result explicitly states that deployment is disabled and that the planner itself cannot prove historical inventory completeness.

Missing prerequisite: an authoritative inventory covering every historical asset still supported by live clients, plus its payload bytes and reviewed provenance. Neither crawling nor the current build output proves that inventory. Until that prerequisite is supplied and reviewed, actual UI upload stays disabled; this draft does not produce one from assumptions.

Validation: `node --test scripts/production-ui-assets.test.mjs` (7 passed). Includes incomplete/tampered payloads, wrong physical version, unapproved digest, case/path collision, hardlinks, immutable overwrite, deterministic rollback, and existing UI-mode denial.

Reference: https://developers.cloudflare.com/workers/static-assets/direct-upload/ describes a manifest of path/hash/size and Worker-version asset association. It does not establish that a newly generated local manifest contains all assets required by previous open sessions.
