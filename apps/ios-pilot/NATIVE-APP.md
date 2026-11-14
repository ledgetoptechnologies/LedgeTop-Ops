# Connected native app

Direction (Beau, 2026-11-13): the app is native first. Apple rejects apps that
are only a website in a wrapper (App Review guideline 4.2), so the main screens
are SwiftUI and read data directly. The embedded web view (`WEB-SHELL.md`) is
kept for sign-in during the pilot and as the fallback for pages that are not
native yet.

## How it connects

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
| Client detail, files, offline, notifications | none | Not native yet |

Shown only in builds that enable the workspace (`LTOpsWebShellEnabled` plus an
allowlist). The repository default stays the offline demo.

## Not done

- Device linking to replace the email-code sign-in (agreed direction, later).
- Native client detail, operations, deliveries and offline files.
- Face ID lock, push notifications.
- Independent review of this branch (Codex has not reviewed it).
