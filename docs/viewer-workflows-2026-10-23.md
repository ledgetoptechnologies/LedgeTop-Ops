# Viewer workflow changes — October 23, 2026

## Requested behavior

- Show actionable current processing work without historical failures or recycled projects inflating the Operations alert.
- Open an available orthophoto first, falling back to a verified streaming mesh and then a point cloud. Preserve explicitly selected views in links and browser history.
- Keep authenticated staff and clients within their existing application navigation while viewing models.
- Make authenticated Client Workspace sharing distinct from public links, with an explicit recipient and project.
- Check new and edited measurements, volume reference planes, cross sections, and visible 3D slicing.

## Processing alerts

The overview previously aggregated all rows in `processing_attempts`. A failed attempt continued counting after a retry, and archiving its task or project did not remove it from the aggregate.

The overview now joins each task's `active_attempt_id`, excludes archived/purged tasks and inactive/purged projects, and includes pending attempts in queued work. Historical attempts remain available in processing diagnostics. Restoring a recycled project makes its current failed task actionable again. This change does not delete or dismiss any job.

The live identities of the two screenshot failures have not been retrieved. The regression reproduces the historical-attempt and recycled-project causes using synthetic records.

## Authenticated navigation and sharing

The branch incorporates the existing native association and Operations model UI work from pull request #226 as a prerequisite. It does not merge or close that original pull request or activate runtime flags.

Authenticated linked-model routes open in the same tab within the real Operations or Client Portal layout. The client route preserves the exact workspace from the model URL, including on Back navigation; its project navigation continues to use existing authorized portal data. Public Viewer links retain their separate experience.

Private processing reviews launched from the dedicated Viewer workspace still use isolated review tabs and their existing session-renewal controller. These reviews do not automatically acquire an Operations model association. This change does not eliminate every separate review tab.

The sharing workflow distinguishes Public link and Client Workspace tabs. Account selection identifies the exact project/account pair, and connected workspace targets use the existing native grant functions through the signed Operations bridge. The server continues to validate the target and staff permissions. A model association supplies routing metadata; explicit grants supply client access.

Viewer grants cover the selected account/workspace and its eligible members. They do not implement Files' per-person or department grant model. Project-wide grants explicitly include current and future published tasks, and the displayed grant history is scoped to the current Viewer project/model.

Native revocation prevents subsequent issuance, including renewal, through the live grant check. An already-issued Viewer session can remain valid for the existing bounded lifetime (up to 30 minutes). The signed bridge forwards that limit, the proxy validates it, and the success notice explains it. Legacy queued session-revocation notices retain their pending state.

## Measurements

The existing calculation and lifecycle tests passed before changing the interaction controls. Claude's UI audit found separate usability problems: Escape saved a draft, names opened rename rather than selecting a measurement, the dedicated Volume action was hidden, and calculation notices promised that closing the inspector would save a pending result.

The changes make Enter/Finish save, Escape/Cancel discard unsaved changes, names select, and Rename an explicit action. Choosing Volume saves the polygon before opening the calculation inspector; it does not guess a reference or start a calculation automatically. Editing an outline still invalidates a previously calculated volume. Closing an inspector cannot attach late results; the copy now describes that boundary accurately.

Volume availability uses the scoped server capability response. A confirmed absence of permitted calculation sources disables the action with visible guidance. Pending or failed capability requests are not treated as proof that a source is absent; an orthophoto can still use an authorized point-cloud elevation source. Restoring an unfinished Volume draft after session renewal preserves its intent.

The volume reference plane and the visible slicing plane are independent. Slicing changes visible mesh/direct-cloud data and picking only; it does not change source elevations or volume calculation inputs. The streamed Potree cloud renderer requires its own clipping integration and is explicitly unavailable for slicing in this change.

## LAS/LiDAR scope

Existing code can display registered EPT clouds and selected direct LAS/LAZ/PLY products. Recognition of ODM-named cloud products is not a general standalone LAS upload/import workflow. A future standalone LiDAR import needs explicit CRS and vertical-unit handling, managed ingestion/indexing, authorization, publication, and large-file validation. It is not implemented or advertised as complete here.

## Validation

- Linux container: 46 overview, view-mode, processing/storage lifecycle, and workspace checks passed.
- Measurement calculations, backend and lifecycle audit: 494 passed, two optional Poisson-engine fixture skips before interaction changes.
- Measurement browser audit: 34 passed in isolated Chromium, including profile lifecycle, CSV/PNG downloads, and queued/cancelled server inspection.
- After interaction changes: 476 measurement checks passed, two optional Poisson-engine fixture skips; 76 focused interaction/dialog checks passed.
- Slice/header/runtime checks: 74 passed, including real WebGL framebuffer assertions for removed/retained geometry, streamed arrivals, and reset.
- Follow-up measurement checks: 113 unit tests and 40 browser/wiring checks passed, including the real Volume toolbar, Finish-to-inspector, saved selection/focus/rename, cancellation, and renewed draft recovery.
- Authenticated navigation: 20 Operations browser checks, six client browser checks, ten route checks, and two final failed-job link checks passed. These browser fixtures use the actual application layout and a mocked Viewer iframe.
- Sharing: 79 Viewer checks, 13 focused Operations bridge checks, and the desktop workspace browser scenario passed, including keyboard focus and tab-panel state.
- Combined branch: both application typechecks passed; 42 Operations Viewer tests and 85 overview/view-mode/sharing/proxy tests passed.
- Final revocation follow-up: 87 Viewer tests, 14 Operations bridge/issuer tests, and the Operations typecheck passed.

These checks use synthetic fixtures. They do not certify survey accuracy or establish that the changes are deployed to the live service.
