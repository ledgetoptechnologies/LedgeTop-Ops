# Connected native app

Direction (Beau, 2026-11-13): the app is native first. Apple rejects apps that
are only a website in a wrapper (App Review guideline 4.2), so the main screens
are SwiftUI and read data directly. The embedded web view (`WEB-SHELL.md`) is
kept for sign-in during the pilot and as the fallback for pages that are not
native yet.

## Modes

A build opens exactly one of these, chosen by `PilotWorkspaceMode.select` (package-tested):

| Mode | When | Authority |
|---|---|---|
| Demo | Default, and whenever a requested mode is not available | None; sample data |
| Scoped read-only | `LTOpsLiveEnabled` and a reviewed scoped source exists | A scoped credential that can only read; no web session, no website; no dashboard or tasks yet |
| Staff web session | `LTOpsWebShellEnabled` with a valid allowlist | The person's full staff sign-in, with the website as a fallback. Staging pilot for the owner only |

A build that sets both flags opens nothing connected. A build that asks for the scoped mode never falls
back to the staff session. No reviewed scoped origin is enabled in source today, so the scoped mode is
unreachable in every current build.

## How the staff web session connects

- The person signs in once on the Cloudflare Access email-code page, shown in a
  sign-in sheet that closes itself when the workspace loads.
- Native code then calls the same JSON API the website uses (`/api/session`,
  `/api/dashboard`, `/api/operations`, `/api/client-hub`) with that session, through
  `Sources/LTOpsCore/OpsWorkspace.swift`. Requests use an ephemeral URLSession
  that stores nothing and never follows redirects; a redirect or sign-in page
  means "signed out", never data.
- "Sign out" removes the session and all stored web data.

## Screens

| Screen | Source | Status |
|---|---|---|
| Home: counts, upcoming operations, open tasks, stale-data notice | native, `/api/dashboard` | Built |
| Operations: open/all/completed filter, search, detail (schedule, site, notes) | native, `/api/operations` | Built |
| Tasks: open tasks first, optional completed, due date and assignee | native, `/api/tasks` | Built |
| Clients: search, paging | native, `/api/client-hub` | Built; a client opens its website page in the web view |
| More: account, full workspace, sign out, demo | native | Built |
| Client detail with projects | native, from a data source that offers projects | Built; shown for read-only sources. The staff session still opens the website page |
| Files, offline, notifications | none | Not native yet |

Shown only in builds that enable the workspace (`LTOpsWebShellEnabled` plus an
allowlist). The repository default stays the offline demo.

## Not done

- Device linking to replace the email-code sign-in (agreed direction, later).
- Native client detail, operations, deliveries and offline files.
- Face ID lock, push notifications.
- Independent review of this branch (Codex has not reviewed it).
