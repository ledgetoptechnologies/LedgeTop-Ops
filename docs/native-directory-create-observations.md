# Directory create acknowledgment completion

A successful Project Alpha directory create acknowledgment establishes the exact
Ops-to-PA mapping. Project creation also requires validated Directory inventory
showing that public ID with an active, revision-aligned binding. An ACK alone
does not substitute for that observation.

Migration `0211_native_directory_create_observations.sql` adds durable, read-only
completion jobs. The existing native Directory scheduler admits at most 12
previously acknowledged, unobserved create targets per turn, including creates
acknowledged before this migration. It verifies the current ACK, materialized
intent, unique mapping, and configured source identity/origin before dispatch.

Each job reads one type-specific inventory page of at most 200 resources. It
persists only validated PA inventory through the canonical receipt/observation
writer. The returned cursor is checkpointed for the next bounded scheduler turn;
target identifiers are never used to manufacture cursors. The queue participates
in the scheduler's existing source rotation, command budget, and fetch deadline.

The same D1 transaction fences the current lease, ACK, mapping, source identity,
cursor, and Directory authorization-generation high water; persists the canonical
page; and updates progress/completion. Generation comparisons use decimal string
length and lexical order, preserving integers beyond JavaScript's safe range.
A superseded response rolls back without inventing a source regression conflict.
Real canonical page conflicts remain durable and stop the job without adopting
the conflicting page's cursor.

Due, unleased jobs and jobs with expired leases whose exact configured identity
or acknowledged mapping has been superseded stop as conflicts rather than occupying the queue indefinitely.
Disabled or invalid connection configuration does not retire jobs.

Timeouts and transient HTTP failures retain progress. Explicit cursor rejection
or a changed generation restarts the scan. An absent or misaligned binding never
completes the job. The update binding-continuation workflow remains separate:
this completion job never sends a PA mutation, edits a business profile, grants
portal access, publishes services, or changes public links. It introduces no new
deployment flag; it runs under the existing native Directory drain policy and
enabled, deployment-owned API-v2 connections.

Client Hub reports native readiness before falling back to legacy link setup:
PA acknowledgment pending, inventory observation pending, binding unavailable,
or missing project authority. A verified observation enables native project
creation only when the existing staff and project permissions also allow it.
Reviewed legacy external links remain available when the native destination is
disabled.

`native-directory-create-observations.test.ts` exercises real create ACKs and
full migrations through 0211, normal scheduler readiness for clients and
organizations, pagination beyond 200, interruption, generation changes, stale
responses, source replacement, tombstones, lease races, transaction rollback,
conflicting request reuse, and actual generated queries at expression depth 100.
