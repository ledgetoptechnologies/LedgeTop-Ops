# Windows live staging download acceptance — October 23, 2026

The real .NET console harness passed employee gateway and client R2 download
acceptance against deployed staging Workers. This qualifies a developer vertical
slice, not an installable release, Explorer integration, or production rollout.

## Deployed configuration

- Ops Worker version: `8b2ddeab-77cd-4bf6-b64e-d8d5b876ce23`.
- Client Worker version: `92276e12-c10d-494f-9378-6553f3cfebf3`.
- Activation source: `3e2c85e287e0d5ecd15f405efece835ab81c573f`.
- Applied migrations: Ops 0222, 0223, 0224; Client 0235, 0236. Ops 0225 excluded.
- Independent deployment reads verified both versions at 100%. Settings and
  schedules were preserved; ten selected existing UI page/asset checks matched
  their baseline status, headers and body hashes. This does not establish every
  historical asset association.

The employee gateway served only its generated local-ext4 fixture, through the
approved staging tunnel route. There was no NAS mount or TrueNAS access. The
client fixture was conditionally uploaded to the staging R2 bucket, then observed
in the normal file index. Native recipient, folder publication, and limited
delivery authority used supported owner workflows; authority rows were not seeded.

Both fixtures were `map.bin`, 2,097,152 bytes, SHA-256:
`91d6f139837323de3829070b54945b770230a2fbfd270b370184b57305bfaf65`.

## Actual desktop results

| Mode | Run UUID | Pause retained | Separate-process resume | Existing destination | Revocation |
| --- | --- | ---: | --- | --- | --- |
| Employee | `d25b39df-a5d5-4aae-aa29-00518c7896e2` | 3,308 bytes | Size and SHA-256 passed | Sentinel unchanged | Discovery, durable reference and saved byte handle denied |
| Client | `67a86020-6a00-4784-8931-8acefd166241` | 3,202 bytes | Size and SHA-256 passed | Sentinel unchanged | Discovery, durable reference and saved byte handle denied |

Employee grant `52851424-d882-4f56-a4eb-369aa826534e` was revoked through the
owner command, generation 1→2. Native delivery authority
`af0ce73b-8ca0-412d-b3de-b84027e2ff0e` was separately revoked and acknowledged,
revision 1→2. Each harness resolved a current byte handle before revocation and
kept it only in memory. After the owner receipt, employee resolution and bytes
returned HTTP 403; client resolution and bytes returned the adapter's
HTTP 404-or-409 denial category. Existing verified local downloads remained intact.
The harness alone does not independently attest the owner receipt or rule out all
concurrent server changes; retain the separate owner evidence.

Eight successful create-new phase receipts reside under the two run UUIDs in
`%LOCALAPPDATA%/LedgeTop/Files/live-staging-acceptance/`. Each records assembly
hashes, result, fixture hash and time. Final phases completed at 16:43:34 UTC
(employee) and 16:44:05 UTC (client).

Core assembly SHA-256:
`fe5d321c64427bbe3b527ae4dcb6c83d9807b189c16e51f0ff8bfc36ecd35e80`.
Client interrupt used the queue-folder-fix harness:
`c20b8035b5944be8a272f2838c89b80c5af667e61fdf6e0c7e6d714a3ebfa739`.
All other successful phases used the additional fixed-stage diagnostics harness:
`dc38f494f31ac823063b9c74ceb56e7d0063a72e5b17a69f267ee17933aba749`.
Normal TLS validation, CRL checking and pinned official cloudflared were retained.

## Failed attempts and limits

The first employee attempt failed because the harness omitted creation of the
queue directory required by Core. The harness now creates an empty owned directory
only on a fresh run; later phases require existing state. A second fresh attempt
returned LoginRequiredException; independent session, roots and entry reads were
200, and the later fresh full run passed without changing auth. Its exact transient
cause remains unknown. Failed run directories are preserved separately.

The first employee revocation arm used closed redirected stdin and stopped before
any revoke command. A terminal-enabled invocation then armed successfully; only
after its event was the single owner revoke executed. No uncertain write was
retried. Neither failed invocation produced a success receipt.

Pause is a normal cancellation, not a forced crash. Range behavior is enforced by
the production downloader, but these receipts do not independently capture wire
headers. No signed installer, package install, update delivery, Explorer online-only
placeholder, offline pinning, employee writeback, production qualification, or EH
execution claim follows from these results. The unsigned pilot package predates
these harness-only changes. See the Windows release plan for the remaining gates.
