# Production ledger read-only preflight — October 12

Observed around 20:09 UTC on October 12, 2026 through the configured Cloudflare account API credential. This is a migration-name inventory, not production readiness, schema equivalence, permission to apply migrations, or the owner's PA update checkpoint.

Only SELECT statements against migration ledgers/sqlite_master and PRAGMA table_info were issued. No production configuration, ledger, grant, client record or public link changed. No customer data was queried.

## Exact targets and candidate

- Operations: canonical `ltds-ops`, database `6ebf7514-d306-4615-ae56-ad869c874dbd`.
- Client: canonical `client-data`, database `7f40a7b7-c3ec-470e-a626-e798867f71f8`.
- Candidate migration directories: combined release assembly based on `6c1b93e18eb33b84e70fe50309cf9fccc253eccc`; subsequent local commits changed only documentation and one browser test, not migrations.
- PA production migration ledgers were not inspected by this preflight. They are separate MySQL instances and require their own exact-revision read-only inventory before the owner update instructions are final.

## Results

| Target | Standard ledger | Candidate SQL files | Candidate names absent from standard ledger |
| --- | --- | --- | --- |
| Operations | 124 rows; last `0124_project_alpha_project_adoption_review_evidence.sql` | 200 | All 76 files numbered 0125 through 0200 |
| Client | 134 rows; last `0213_incoming_rclone_promotion.sql` | 149 | 17 files numbered 0214 through 0230 |

Counts are not simple schema-version subtraction: the Client standard ledger also contains two historical names absent from this candidate directory:

- `0112_thumbnail_renderer_coordination.sql`
- `0113_thumbnail_backfill_controls.sql`

Operations additionally has a separate `production_native_authority_migrations` ledger with one entry:

- `9000_production-authority-project-v2-001_provision.sql`

The custom authority entry is not a normal numbered migration file. Preserve and reconcile it independently; do not drop/reapply it or treat it as evidence that the 0125–0200 normal chain has already been applied. Existing production authority must not be reset by a bulk rollout.

## Required release checks

1. Retain exact current source/configuration revisions and a verified backup/rollback plan before applying anything. Current production Worker identity must be checked separately; migration rows do not identify running code.
2. Compare the final release's ordered migration filenames and contents with the actual recorded ledgers. Migration names alone cannot prove the original SQL contents or physical trigger/table definitions match.
3. Explain the two historical Client-only filenames from repository/deployment history and verify their existing schema effects are compatible with the candidate. Do not delete their ledger entries to make counts match.
4. Include the separate Operations authority ledger and effective authority in preservation checks. Do not conflate it with standard `d1_migrations` or staging temporary-grant ledgers.
5. Exercise the full pending Client 0214–0230 and Ops 0125–0200 upgrade from a faithful non-production copy/model of these actual base states, including historical schema effects and custom authority preservation. Existing staging-at-head tests are not by themselves proof of this production upgrade path.
6. Derive Client/Ops ordering from the final paired release's admission/compatibility contract. A raw unbounded `migrations apply --remote` command is not an approved cutover plan.
7. Re-read both production ledgers immediately before the eventual checkpoint; this snapshot may become stale. Keep all client-access and portal-cutover flags off pending the separate owner checkpoint and safe validation.

No production update is requested by this document.
