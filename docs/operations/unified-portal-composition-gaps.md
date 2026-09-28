# Unified portal composition gaps

Status: bounded design and launch-gap register. This document does not authorize
implementation, deployment, configuration changes, schema changes, new grants,
or public-link changes.

## Local implementation checkpoint

The success-only composition is now implemented in the review candidate for
legacy and native Client dashboards. The existing Client bootstrap still runs
its own session, workspace and resource checks; descriptive Operations services
do not choose a workspace or enable actions. A blocked Client bootstrap keeps
only the neutral service summary. Its explicit recovery action clears the
remembered Client workspace and fully navigates to `/portal`, forcing a fresh
Operations probe before any further Client bootstrap.

Implementer typecheck and build passed. Independent root parser/bootstrap tests
passed 15/15; the desktop/mobile Edge matrix passed 26/26 in 26.5 seconds,
including actual mobile-menu interaction, native workspace separation and
recovery denied by a fresh Operations probe. Independent source QA cleared the
initial invalid-workspace reload dead end. These are local synthetic fixtures,
not credentialed staging acceptance, new recipient enrollment, service-resource
mapping, or production rollout. The remaining launch gaps below still apply.

## Reviewed bootstrap boundary

The unified `/portal` root currently probes the Operations service-home endpoint
before loading the existing Client portal. Preserve that fail-closed ordering.

- An exact, strictly validated Operations `200` may proceed to a separate Client
  session/bootstrap check.
- Operations `401`, `403`, `503`, malformed success data, network failure, or
  timeout must remain terminal for the root request. They must not initiate any
  Client session, workspace, project, delivery, request, feedback, billing, or
  notification read.
- Operations `404` remains the sole legacy fallback. Its current behavior must
  remain unchanged: the existing Client portal performs its own session and
  resource authorization checks.
- An Operations `200` is descriptive metadata authorization only. It does not
  authorize Client resources, content, Project Alpha data, files, requests,
  feedback, financial data, or notification history.

This ordering intentionally differs from two freely independent probes. It
prevents an Operations denial or unavailable response from becoming a side
channel into legacy Client reads.

## Smallest success-only composition

After a verified Operations `200`, the root may start the existing Client
bootstrap as a second, independent authorization step.

1. Retain the validated Operations response as an immutable descriptive service
   snapshot for the current root load.
2. Start `/api/client/session` without a workspace header, then use the existing
   Client bootstrap flow to discover authorized workspaces and validate any
   workspace hint.
3. Render Client navigation and actions only if that bootstrap succeeds. Client
   capabilities and scoped readiness responses remain the only authority for
   projects, deliveries, requests, feedback, team management, billing, and
   notifications.
4. If Client bootstrap returns `401`, `403`, unavailable, malformed data, or a
   rejected workspace hint, render metadata-only Operations content with no
   Client greeting, navigation, action links, or cached Client resources.
5. Never use an Operations `workspaceId`, `authorityId`, provider ID, service ID,
   display label, customer name, or email to select or correlate a Client
   workspace. The two surfaces remain visibly separate until a governed
   stable-ID binding is reviewed and authorized.

The neutral Operations-only heading should remain suitable when no Client
account display name is independently authorized. A personal greeting may use
the Client session's display name only after successful Client bootstrap.

## UI architecture caveats

Rendering the current `OperationsHomeApp` and `ClientPortalApp` one beneath the
other would produce two headers/shells and would cause `ClientPortalApp` to run
another session/bootstrap sequence. Avoid shipping that shape.

A bounded implementation should use one root shell and either:

- pass an already verified Client bootstrap into a refactored Client content
  component; or
- extract the Client ready-state shell/content while preserving its current
  workspace-switch and browser-history reauthorization behavior.

The root needs one abort/generation fence spanning the success-gated sequence.
Unmount, navigation, retry, or a newer bootstrap must prevent late Operations or
Client responses from restoring stale content. Workspace switching must continue
to rerun the Client checks and must never reuse Operations metadata as a Client
workspace credential.

There is an unavoidable interval between the Operations `200` and Client
bootstrap completion. Show a bounded loading state, not legacy Client content.
If Client authorization is revoked during that interval, clear all Client state
and retain at most the independently validated Operations metadata. If the
Operations permission is later rechecked and denied, clear the metadata too.

## User-visible gaps and remaining launch requirements

- The original committed baseline `213bd57` showed service labels only. The
  follow-on local composition now reuses independently authorized Client
  navigation/content, but metadata-only accounts still have no resource actions
  or independently verified personal greeting. Do not confuse an authorized
  organization/workspace label with a person's name.
- The composed mature Client portal provides existing projects, deliveries,
  optional requests, feedback, notifications and request-level quotes only
  within its own authorized workspace. Operations-only resource access and
  service-to-resource linking remain separate governed work.
- Drone delivery is not surfaced from the Operations home. It may be added only
  from a successful Client delivery authorization, never inferred from a drone
  or aerial service label.
- Project and one-off requests are not linked from the Operations home. Existing
  Client capability and request-readiness checks must remain authoritative.
- Feedback exists for authorized Client targets, but there is no separately
  defined website-edit workflow. Target types, staff routing, and completion
  semantics need an explicit contract before presenting website edits as a
  distinct service.
- Monthly reports have no defined portal API, authority model, period/source
  contract, or dedicated UI. Fixture text containing “monthly” is not a report
  feature or launch evidence.
- Existing financial presentation is limited to authorized request-level quote
  data. There is no account-level financial summary contract and no reviewed,
  allowlisted Project Alpha financial action-link contract.
- The Client notification surface combines authorized histories, but it is not
  present in metadata-only Operations mode. Cross-channel email/in-app
  duplication and a single logical-event identity still need explicit joined
  acceptance; mailbox absence or provider acceptance is not delivery proof.
- Verified-recipient workflow authorization remains pending. Do not bypass it,
  infer recipients from email/name, or add grants as part of UI composition.

## Launch acceptance matrix

| Operations result | Client bootstrap | Required root outcome | Client reads/actions |
| --- | --- | --- | --- |
| `200`, exact valid envelope | success | One shell with separate Operations services and authorized Client content | Allowed only from Client capabilities and scoped checks |
| `200`, exact valid envelope | `401` or `403` | Metadata-only Operations view with neutral identity copy | Bootstrap checks only; no authorized Client content/actions |
| `200`, exact valid envelope | unavailable, malformed, timeout, or rejected workspace hint | Metadata-only Operations view with bounded Client-unavailable notice | Bootstrap checks only; no Client content/actions; clear prior Client state |
| `404` | success | Existing legacy Client behavior, unchanged | Existing Client authorization only |
| `404` | denial or unavailable | Existing legacy blocked behavior, unchanged | None |
| `401`, `403`, or `503` | not started | Existing fail-closed Operations blocked state | No Client request may be issued |
| malformed Operations `200`, timeout, or network failure | not started | Existing service-home unavailable state | No Client request may be issued |

## Required focused acceptance

- Assert exact request order: Operations first; Client session begins only after
  an exact Operations `200`, or after the existing Operations `404` fallback.
- For every Operations terminal failure, assert that no Client session or
  resource endpoint was requested.
- For Operations success plus Client denial/unavailability, assert service labels
  remain descriptive while greeting, navigation, projects, deliveries, requests,
  feedback, financial data, and notifications are absent.
- Prove no Operations identifier is copied into Client workspace headers, query
  selection, storage, or capability decisions.
- Cover the same subject under a different issuer without correlating the two
  authority streams.
- Cover Client workspace hints that are invalid, cross-tenant, revoked, or
  removed while bootstrap is in flight.
- Cover Operations revocation and Client revocation races in both response orders;
  late responses must not restore cleared state.
- Cover refresh, direct legacy subroutes, Back/Forward, workspace switching,
  keyboard/mobile navigation, and both configured portal domains.
- Cover the Operations feature off/on boundary. `404` must preserve legacy
  behavior; enabling the feature must not manufacture Client access.
- Add staged live acceptance separately. Unit, Miniflare, and intercepted browser
  fixtures prove contracts, not real recipient enrollment, real resource grants,
  provider delivery, or launch readiness.

## Deferred governed work

Any service-to-resource action—such as mapping an Operations service to a Client
delivery, request catalog, Project Alpha project, monthly report, or financial
record—requires an explicit governed stable-ID binding and its own revocation
model. Do not bridge these domains by display labels, customer names, email
addresses, provider names, or heuristic workspace matches.
