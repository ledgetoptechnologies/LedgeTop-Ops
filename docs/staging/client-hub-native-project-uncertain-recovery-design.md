# Client Hub native project uncertain-send recovery

Status: isolated implementation candidate. Do not merge or deploy until the
schema, dispatcher proof, and joined D1 matrix are independently reviewed.

## Proven boundary

The full-chain Miniflare case in
`apps/operations/test/client-hub-native-project-management-d1.test.ts` proves
that an exact create can reach a terminal uncertain outbox after the PA POST
loses its response. If an unrelated grant update advances the same actor's
project-grant generation while the original empty scope remains allowed by a
live global grant, exact retry cannot use the original command proof.

Migration 0180 is intentionally not usable for this normal Client Hub flow. Its
live recovery authorization requires `integrations.manage`, requires the
current generation to equal the original generation, and is an administrative
recovery contract. Removing those conditions or granting the permission would
broaden authority and is rejected.

## Minimal additive proof

A forward migration should add a separate durable
`client_hub_native_project_recovery_authorizations` table. One row authorizes
one transition of one exact 0188 preparation and existing immutable command:

- deterministic `authorization_id` primary key and unique
  `(command_id, uncertain_event_version, current_generation)`;
- `command_id` referencing both the 0188 preparation and project outbox;
- preparation request SHA-256 and exact stored request JSON hash;
- source, source-instance, application, history epoch and destination origin;
- external project ID and original command request SHA-256;
- original actor ID, subject, email, admission/profile versions, grant
  generation and canonical scopes JSON;
- current actor ID, subject, email, admission/profile versions, grant
  generation and the same canonical scopes JSON;
- original terminal outbox attempts/outcome and uncertain event version;
- `authorized_at` and a maximum fifteen-minute `expires_at`. Authentication
  must still be fresh at issuance. Preparation expiry applies to the first
  transmission only; it does not erase recovery eligibility after a genuine
  uncertain transmission.

The insertion guard must prove in one database transaction:

1. The 0188 preparation exists, its transmission stamp is non-null, and every
   bound request/context/source/actor field still matches.
2. The reservation, request fingerprint, canonical intent, outbox command JSON,
   external ID, request hash, destination, and original command proof are exact.
3. The latest event is the selected terminal `uncertain` event; there is no
   success receipt, settlement, activation, later event, live lease, or other
   recovery authorization.
4. Admission and profile identity are unchanged and active. Only grant
   generation may advance.
5. Every original scope is currently allowed by `project.shared.sync`, with
   deny precedence for global, exact-project, business-area, and division
   grants. Empty scope still requires a current global allow. No browser scope,
   permission, generation, or recovery identifier is authoritative.
6. The authorization is minted by the server with a deterministic identifier
   derived from command ID, uncertain event version, and current generation.

Create a narrowly named live view containing only authorizations satisfying all
those predicates. It is cardinality-checked for one preparation, reservation,
fingerprint, intent, outbox, original proof, and selected latest event. Do not
alter the 0180 administrative view or its `integrations.manage` policy.

## Dispatcher integration

The dispatcher checks the narrowly named Client Hub live proof as an additive
alternative to `native_project_live_command_proofs`, both before and after the
lease. Producers and reservation creation continue to use only the established
view, so this proof cannot create a command or reservation.

The terminal-uncertain reopen triggers accept the new live proof as an
alternative to the 0180 proof while retaining the exact pending-event then
outbox-reopen sequence. No success receipt, settlement, or activation may
exist when it is minted.

The dispatcher atomically persists a command-bound post-send continuation with
the acknowledged event, validated acknowledgement, success receipt, and
outbox release. This continuation is not a dispatch proof. It authorizes only
settlement and activation for that exact receipt after the short-lived pre-send
proof expires or the grant generation advances. It therefore cannot enable a
new POST. Existing 0180 post-ACK authority remains unchanged.

## Required D1 matrix

- Planner blocked/conflict/uncertain without an exact queued reservation never
  stamps `transmission_started_at`; an expired preparation cannot dispatch.
- Exact queued command plus uncertain PA POST, followed by unrelated generation
  advance with equivalent current allow, reopens once and sends the same bytes.
- Global, exact-project, business-area, or division deny; inactive admission;
  subject/email/profile drift; changed request/context/source; changed scopes;
  or non-latest uncertainty blocks before reopening or transport.
- Concurrent recovery produces one authorization, one pending successor event,
  one lease, and no duplicate PA command.
- A recovered ACK settles and activates normally. ACK-only and settlement-only
  retries after equivalent generation advance perform no second POST and
  converge to activation; current revocation still denies initiation of any
  not-yet-authorized recovery.
- Exact replay after activation returns the existing activation and never
  mutates preparation, command, receipt, settlement, or activation identity.

## Separate product scope

This recovery design does not complete standalone-client creation. The current
PA create contract requires a non-null organization relation and the producer
requires `organizationRecordId`; client is optional. Proper standalone support
therefore requires an additive PA API-v2 create shape permitting
`organization: null, client: <exact standalone client proof>`, plus matching
canonicalization, transport validation, producer directory rules, settlement,
activation ownership, and Client Hub visibility tests. A synthetic organization
must not be invented.
