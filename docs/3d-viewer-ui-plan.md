# Dedicated LTDS Viewer UI plan

Status: product direction approved; implementation in progress. This document
does not authorize a deployment or feature-flag change.

## Product boundary

Operations and Client Portal remain the identity and authorization control
plane. The dedicated Viewer application owns Viewer projects, datasets,
imports, processing tasks, provider/node administration, review, publishing,
storage lifecycle, and interactive viewing. Operations exposes a lightweight
Data hub with delivery tools and a read-only 3D overview; it does not duplicate
the Viewer processing workspace.

- Staff administer Viewer projects and processing at
  `https://viewer.ledgetopdroneservices.com`.
- `https://ops.ledgetopdroneservices.com` shows model/task/storage/worker
  summary information and launches the Viewer workspace.
- Clients discover authorized models at
  `https://client.ledgetopdroneservices.com`.
- The full interactive workspace opens in a new tab at
  `https://viewer.ledgetopdroneservices.com/session/{one-time-grant}`.
- The grant is redeemed immediately and removed from the active URL.
- Large model and asset responses flow directly from Viewer/Nginx to the
  browser. They never proxy through an LTDS Worker.
- The bare Viewer root is the authenticated staff management application. A
  resource-scoped `/session/...` route remains the full client, public-share,
  or review viewer and never exposes the staff catalog without authorization.

The attachment's `legtopdroneservices.com` spelling is a typo. The canonical
domain is `ledgetopdroneservices.com`.

## Entry points

### Operations

1. An authorized staff member opens **Data** in Operations.
2. The 3D overview shows bounded counts, storage, provider health, and active
   work without loading model assets or duplicating management controls.
3. **Open Viewer workspace** hands the staff member to the dedicated Viewer
   domain using a short-lived admin grant and no second login.
4. Model review links still use resource-scoped one-time Viewer grants.

### Client Portal

1. An authorized client opens the project's **3D Models** section.
2. Selecting **Open 3D Viewer** follows the same new-tab grant flow.
3. Losing the underlying project/model authorization prevents renewal and
   revokes the associated Viewer session according to the existing contract.

### Public share

The durable public URL remains an LTDS share URL. After validating its status,
expiry, access code, and source authorization, LTDS hands the browser to a
short Viewer session. A temporary Viewer session URL is never the durable link
the user distributes.

## Viewer management application

The staff shell uses the approved black/charcoal visual language with LTDS
orange accents. It provides:

- overview metrics for projects, tasks, outputs, storage, active work, and
  provider/node health;
- project and task workspaces;
- dataset upload and import;
- durable processing scheduling against admitted NodeODM or ClusterODM nodes;
- processing history, logs, recovery, review, publishing, and output lifecycle;
- provider credentials, probes, capabilities, presets, and admission limits;
- authenticated Client Portal grants and separate public Viewer links; and
- storage, trash, restore, purge, and operational health surfaces.

Heavy assets remain direct Viewer/Nginx responses and never transit an LTDS
Worker.

## Task and artifact imports

Imports are task-level and asset-driven. A complete WebODM project or output
bundle is never required.

- An operator may import an unmodified WebODM task backup (`all.zip`), a
  mounted WebODM task folder, or one or more individual supported artifacts.
- A task may contain any supported subset: mesh/GLB, native 3D Tiles, EPT or
  other supported point cloud, orthophoto, DSM, or DTM.
- Viewer detects asset kinds, validates each format safely, records immutable
  content identity, prevents duplicate adoption, and exposes only the modes
  that are actually present.
- Additional compatible outputs may be attached as a new immutable task
  version; existing published versions remain reproducible.
- Missing asset kinds are normal and never treated as an incomplete bundle.

## Client grants and public links

- Authenticated grants select an existing Client Portal client/project and
  authorize either one Viewer task or an entire Viewer project.
- Project grants include future published tasks by default; an operator may
  choose a fixed current selection instead.
- Client Portal identity, membership, entitlement, project association,
  expiry, and explicit deny state remain authoritative. No Viewer-local client
  account or password is created.
- Only published derivatives are grantable. Raw imagery, GCP sources, provider
  archives, logs, credentials, and unpublished outputs remain private.
- Removing or changing the source authorization prevents renewal and revokes
  source-bound Viewer grants/sessions.
- Public links are a separate Viewer capability for recipients without a
  portal account. They remain expirable, optionally protected, independently
  revocable, and constrained to the selected published output.

## Desktop layout

```text
+--------------------------------------------------------------------------+
| LTDS logo | Project / model identity       3D | Cloud | Ortho | DSM | DTM |
+----------------------+---------------------------------------------------+
| Layers               |                                                   |
|  Streamed LOD        |                                                   |
|  Full-resolution     |                                                   |
|  Camera positions    |                model canvas                       |
|                      |                                                   |
| Navigation help      |                                                   |
|                      |                                                   |
| Measurements         |                                                   |
|  Select Distance     |                                                   |
|  Area   Volume       |                                                   |
|                      |                                                   |
| Camera               |                                                   |
|  Reset  Top  Full    |                                                   |
+----------------------+---------------------------------------------------+
| FPS | coordinates | display units | mode | bytes | LOD | points | tris   |
+--------------------------------------------------------------------------+
```

- Use the supplied black/charcoal and LTDS-orange screenshot as the visual
  baseline, not merely as a list of features.
- Keep the canvas dominant. The desktop tool rail is approximately 288-320px
  and can collapse to an icon rail.
- The header shows friendly project/model names, never opaque IDs.
- Output tabs appear only when the authorized version has the corresponding
  derivative. The default is the best available 3D representation.
- The lower status strip is informational and must not obscure canvas input.

## Mobile and tablet layout

- The model canvas consumes the viewport.
- Output modes use a horizontally scrollable, keyboard-accessible selector or
  a compact mode menu when the full row does not fit.
- Layers, measurements, navigation help, and camera controls move into a
  modal tool drawer. The drawer never permanently consumes canvas width.
- Every actionable target is at least 44px.
- Fullscreen, reset view, current mode, connection state, and the tool-drawer
  control remain reachable without precision tapping.
- Test explicitly at 320px, 390px, tablet width, landscape, keyboard-only,
  and 200% zoom.

## Permission-aware tools

- `view=false`: no session is issued.
- `measure=false`: measurement modes and existing measurements are hidden.
- `cameras=false`: camera-position layer and photo actions are hidden.
- `download=false`: no download action or raw derivative URL is exposed.
- Unpublished review sessions expose only approved derived outputs and cannot
  create a share or change the published model version.
- Missing output kinds are omitted rather than shown as permanently disabled
  tabs.

## Session and renewal UX

- The Viewer never presents a second username/password screen.
- The one-time grant is removed with `history.replaceState` immediately after
  redemption.
- The control-plane tab and Viewer accept renewal messages only from the exact
  expected `Window`, exact allowed origin, protocol version, and model ID.
- A transient renewal failure preserves the current live session, camera,
  selected output, layers, measurements, and settings while retrying.
- When recovery is no longer possible, show a non-modal **Reconnect from
  LTDS** state. Do not silently discard the canvas state before session expiry.
- If the browser blocks the new tab, show a deliberate fallback action. Do
  not unexpectedly replace the project-management tab without explanation.

## Required states

1. Opening secure Viewer session.
2. Loading project metadata.
3. Loading selected derivative with progress where available.
4. Viewer ready.
5. Session renewal in progress (normally unobtrusive).
6. Temporary connection loss with retry.
7. Authorization expired or revoked.
8. Model/version no longer available.
9. Selected derivative missing or failed integrity verification.
10. Browser lacks required WebGL/WebGPU capability.

Errors must use friendly project/model context, a bounded diagnostic code, and
a clear recovery action. They must not expose filesystem paths, bearer tokens,
grant IDs, internal provider responses, or service configuration.

## Confirmed interaction direction

- Closely mirror the supplied dark/orange visual language while keeping the
  layout accessible and responsive.
- Render output-mode buttons dynamically from the authorized asset inventory.
- Reuse Client Portal authentication for authenticated client viewing.
- Keep public links distinct from authenticated client grants.
- Preserve the full Viewer shell for authorized sessions, filtering tools by
  both permissions and available asset kinds.

## Acceptance criteria

- Ops and Client screens never become the heavy-asset data path.
- Ops provides a bounded Data/3D overview and does not duplicate Viewer task,
  dataset, provider, processing, or storage administration.
- The Viewer root provides the full staff management workspace.
- An authorized model opens in a dedicated Viewer tab without another login.
- The active URL contains no reusable credential after bootstrap.
- The full Viewer chrome matches the approved desktop and mobile layout.
- Renewal preserves live Viewer state and fails closed after authorization is
  revoked or expires.
- Range and full asset requests go directly to the Viewer domain and remain
  bound to the authorized model/version.
- A task can be created from any one supported artifact or supported subset;
  available viewing buttons exactly match the registered assets.
- Existing Client Portal clients can receive project- or task-level access
  without a second identity, while public links remain separately revocable.
- Desktop, mobile, keyboard, zoom, loading, error, renewal, refresh, new-tab,
  and revocation behaviors have automated coverage plus live staging evidence.
