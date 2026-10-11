# Project Alpha staging settlement readback — October 11, 2026

This is a read-only audit of the synthetic project `ops/project-acceptance-20261011-replay-1` (PA public ID `de08001599ddb98f98a936921d737684`). It checks the durable PA API-v2 GET responses captured by the canonical settlement adapter, not PA's current live state.

## Evidence and checks

The staging Ops D1 audit used bounded `SELECT` queries for the shared-project head, immutable PA project mapping, project outbox, validated success receipts, canonical settlement receipts, activation receipts, local revision history, and organization directory mapping. Every Cloudflare D1 query reported `changed_db=false`. The configured Cloudflare token was used transiently; no token, raw customer JSON, or secret was printed or saved.

There is one Ops head and one mapping, with two acknowledged commands (create and update), two success receipts, two settlement GET receipts, two activation receipts, and two linked history revisions. The historical settlement reads were captured at **2026-10-11 13:15:17.732 UTC** (PA revision 1) and **2026-10-11 13:16:23.781 UTC** (PA revision 2).

For **both** settlements, the SHA-256 of the stored raw UTF-8 GET response JSON equals its recorded `read_response_sha256`. The nine-field response envelope and eleven-field `data` object have the expected shape. Source instance, application, history epoch, GET request ID, PA public ID, revision, PA projection SHA-256, success receipt, command, settlement, activation, and revision-history links agree. Each command's name, description, estimated start, and estimated end agree with its corresponding captured PA read. The PA organization public ID agrees with the exact Ops organization directory mapping, and both the PA read and Ops head have no client association.

The current Ops version-2 head agrees with the captured revision-2 PA read on name, description, lifecycle/status, archived state, overdue warning, completion and archive timestamps, planned start and end, PA revision, PA public ID, and canonical projection SHA-256. Its stored revision JSON is byte-for-byte the settlement read JSON. The PA projection hash and raw GET-response hash serve different purposes; each matches its own recorded evidence.

## Limit

This proves that the stored, validated canonical GET responses were faithfully linked and projected **at settlement and activation**. It does **not** prove that PA still has the same state after the revision-2 read at 13:16:23.781 UTC. A fresh `GET /api/v2/projects/de08001599ddb98f98a936921d737684` with the dedicated staging API-v2 read key and exact source/application/epoch headers remains pending because that key is not configured locally. No fresh PA request, PA write, provider mutation, or deployment was performed for this audit.
