# Explicit current-tab workspace recovery

The normal recovery popup and its same-origin BroadcastChannel/opener exchange
remain the preferred path because the working document stays mounted. Browsers
that cannot open that popup can offer an explicit current-tab action through
`createWorkspaceRecovery`'s `onPopupBlocked` callback. The callback receives
`continueInCurrentTab` and `navigationState`; no automatic navigation occurs.
`recovery.navigationState()` also reports whether recovery is paused.

The workspace supplies current section/project/task hints and new-task state
(`pendingUpload`, `selectedFileCount`, `unsavedTaskDraft`). A UI may present these
facts before invoking `continueInCurrentTab()`. Existing pending-upload
`beforeunload` handlers remain registered; recovery does not bypass them or
dispose a pending upload. A browser-cancelled navigation leaves recovery paused.
The callback's copy/button layout is a separate UI integration.

The action uses only the already validated Operations origin and existing fixed
`/viewer/reauthorize` path. It records a five-minute nonce, previous session ID and
subject, exact Viewer/Operations origins and validated non-secret view hints in
this tab's sessionStorage. No extra bearer, grant or permission is persisted.
Operations echoes the explicit `recoveryMode=same-tab` alongside the nonce in the
validated Viewer return fragment. Deploy this small Ops counterpart before
offering the Viewer action; an older return fails closed rather than being
relayed to a workspace that no longer exists.

At startup, `resumeCurrentTabWorkspaceRecovery` runs before initial redemption
or popup relay. It consumes and deletes the nonce and strips the capability URL
before any network request. It redeems the fresh one-use grant using the existing
browser bearer and verifies unchanged session ID, subject, bearer and controller
origin before installing the returned envelope. Unknown/expired/replayed state,
wrong origins or modes, redirects, revocation, switched identity and late timed
out responses install nothing. The popup path remains unchanged. No CORS flag,
Access grant, new permission or server authentication route is introduced.

## What survives navigation

Server-saved projects, tasks, uploads already committed server-side and saved
measurements remain on the server. Current section/project/task hints and
existing non-secret model-controller routing descriptors remain in this browser
tab. Routing is restored only after the same server-authenticated subject is
validated; routing metadata never grants access.

Unsent selected photo File objects/handles, active browser promises, unsaved
new-task form fields, unsaved GCP edits and measurement drafts in the navigated
document do not survive a full navigation. They are not silently serialized or
replayed. Files may need to be selected again. An in-flight upload or mutation
can have an uncertain server outcome after navigation; inspect its current
server state before starting another operation.

Already open separate model tabs keep their own in-memory camera/drafts while
they remain open, but renewal may pause while the workspace owner is absent.
They reconnect only through the authenticated restored controller; this does
not promise server persistence of unsaved drafts. Inner-model current-tab
launch/iframe fallback is outside this change.

## Workspace navigation evidence fields

`createWorkspaceRecovery.getNavigationState()` now receives an ephemeral workspace-only snapshot from `workspaceNavigationState`:

- `pendingUpload`: existing New Task transfer flag OR the reachable legacy Import upload loop is still running.
- `selectedFileCount`: New Task selected count plus legacy selected artifacts. An in-progress legacy upload retains its count if the modal disappears; the same modal/operation files are counted once. These are selected references, not a count of server-unacknowledged photos; legacy artifacts can be models/GCP files as well as photos.
- `unsavedTaskDraft`: existing New Task controller flag, unchanged.
- `unsavedGcpMark`: current valid GCP draft has no exact saved correspondence, or its pixel X/Y differ from that correspondence. Saved seeds and reverted edits are clean. Acknowledged saves update the local correspondence baseline before optional refresh, so a refresh failure does not make an acknowledged mark look unsaved.
- `pendingGcpSave`: specifically a GCP save request is pending, independent of generic workspace busy state. It resets on success, rejection and synchronous failure. The request may already have reached the server; check saved marks after renewal before retrying.

The workspace tracker registers its own `beforeunload` handler while any legacy
upload is active. It guards ordinary navigation and tab closing as well as
same-tab recovery. Cancelling navigation keeps the upload and selected files;
settling the last upload removes only that tracker’s handler. New Task's
existing upload guard remains independent. The browser regression uses the
actual legacy uploader and production tracker with mocked endpoint responses,
rather than installing a test-only guard.

These fields grant no access, persist no File handles, and report no inner-model measurement state. They do not preserve arbitrary form input. The recovery offer consumes these fields and requires acknowledgement when work would be discarded. Full HTTPS recovery remains a separate acceptance check.

## Operations source port and qualification

This is the selected recovery portion of upstream Viewer PR21 at
`3a97bf691644eddffb55e152ef1c7ac69429f456`, ported onto Operations main
`3f0442df6dddf31931d9ba2821e5496b5ad5a3ee`. It excludes the old branding,
favicons, task-row layout and unrelated UI changes. The paired Ops contract is
PR229 at `5a6f80546325a06f6334f0d129aa42324cef347d`; the Ops owner must migrate
and review that behavior on its current base before either half is released.

The port independently attempts URL sanitization and tab-local nonce
consumption, even if either browser facility throws. A failure of either step
prevents redemption. This closes a cleanup gap in the historical candidate.

`test/workspace-current-tab-paired-contract.test.mjs` imports the actual Viewer
and Ops modules. It defaults to the in-repository Ops counterpart; for source
qualification only, `VIEWER_OPS_REAUTH_MODULE` may name a reviewed counterpart
in another worktree. Its issuer and redemption endpoint are mocks: passing it
does not certify server authorization, real one-use storage, or HTTPS behavior.
If the counterpart is absent, those tests explicitly skip and paired
qualification is incomplete.

The browser UI regression exercises real acknowledgement and beforeunload
Cancel/Confirm behavior on a local fixture. It must be run in an authorized
browser test environment; source presence is not evidence of a passing run.
Before release, qualify the integrated Ops/Viewer code with actual same-tab
return, stable identity, changed/revoked identity denial, cancelled navigation,
pending-work warning, and unchanged popup/background renewal. The separate
production client iframe startup failure remains unresolved by this feature.
