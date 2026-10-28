# Viewer workspace redesign — audit and plan (2026-10-27)

Owner: Claude (UX/design + workspace frontend). Backend hierarchy, DTOs and processing protocol: Codex / Processing.
Branch: `claude/viewer-workspace-redesign` from `origin/main` 2f458ff (includes PR 321).
Status: **plan for review — no code written yet.**

Direction from Beau (relayed by Codex, confirmed in session): a substantial daily-use revamp of the
staff workspace (`/workspace`). Keep the dark theme. Align accents with the Operations design tokens.
Keep the structure people like, and keep everything that works today.

---

## 1. What exists today (audit summary)

The workspace is one script (`workspace-projects.js`, about 1,000 dense lines) that re-renders
`#workspace-content` with `innerHTML`. `workspace.js` is an older, unreferenced shell: nothing loads or
tests it.

- **Sections:** Dashboard, Providers & nodes, Background work, Recycle Bin, Diagnostics. Routes are
  `?section=&project=&task=&panel=`. Project and task pages only exist under `section=dashboard`.
- **Hierarchy in the UI:** Project → source set (dataset) → Task → Runs (attempts) → Outputs.
  Organizations and clients appear only inside the Share dialog.

### What works well (keep)

- Dark, calm surface with orange primary actions.
- Left navigation rail with a health indicator.
- Background count in the header.
- Deep-linkable URLs, and back/forward navigation that works.
- The task ⋯ menu.
- Live log tail.
- Orthophoto preview on the task.
- Provider master/detail layout.
- Share dialog tabs.
- Good dialog focus handling in `workspace-dialogs.mjs`.
- Reduced-motion support.

### Problems found (with evidence in the audit notes)

1. **No startup loading state.** The page is blank while 13+ requests run.
2. **Silent data failures.** If `/projects`, `/tasks` or `/providers` fails, the page shows
   "No projects yet." and "0/0 nodes" with no error. Refresh gives no feedback that it's working.
3. **Two detail patterns for one thing.** The project is an inline accordion inside the dashboard
   list. The task is *both* an inline expansion and a separate page (settings, files, GCP).
   Long pages scroll inside the list.
4. **No per-task run history.** "Processing history" opens the global Diagnostics page.
   `attemptHistory()` exists but is never called.
5. **No customer or organization level.** Every project sits in one flat list. That won't scale for
   daily use.
6. **Mobile.**
   - The four metric cards fill the whole first screen at 375px, so projects start below the fold.
   - "New project" is hidden at ≤720px, with no other way to reach it.
7. **Duplicated headings.** For example, h1 "Providers & nodes" sits directly above h2
   "Providers & nodes". The same happens for Recycle Bin and Background work.
8. **Crowded actions.**
   - Output rows show 6 or more buttons.
   - A provider node shows 5 buttons, plus 4 for each preset.
   - "View" means different things depending on status.
9. **Technical copy:** "source sets", "Loading authoritative task details…", "Viewer admission",
   "Linked dataset lifecycle", and "Some survey statistics are not available yet. These fields are
   separate from node connection health."
10. **Styling drift.**
    - About 79 hard-coded colours bypass the 11 tokens.
    - The font is `Outfit` but is never loaded.
    - Body text is mostly 11–13px.
    - Branding is the old remote LTDS logo and the title "LTDS Viewer Workspace".
11. **Accessibility.**
    - The nav has no `aria-current`, and there is no skip link.
    - Focus styles are missing on buttons and nav.
    - `#workspace-content` is a live region that re-renders completely, so screen readers
      over-announce.
    - The generic `openModal` doesn't restore focus when it closes.
    - The import tabs lack `role=tab` / `aria-selected`.
    - Error toasts are not `role=alert`.

---

## 2. Design goals

1. **Find the work fast.** Customer → project → task → run in at most two clicks from the start screen,
   with search across all of them.
2. **Status you can trust.** Show what's happening, what needs you, and what is merely waiting. Never
   show an empty list when loading failed. Never show "failed" because a connection dropped.
3. **One consistent detail pattern.** Use real pages with breadcrumbs instead of nested accordions.
4. **Fewer, clearer actions.** One primary action per object. Everything else goes in a ⋯ menu.
   Labels are plain words.
5. **Same look across Ledge Top.** Use the Operations tokens adapted for dark, the LT mark, and
   "Ledge Top". There is no per-domain branding.
6. **Nothing lost.** Every current capability stays reachable (see §7).

---

## 3. Information architecture

### Navigation rail (left; a drawer on mobile)

| Today | Proposed | Notes |
|---|---|---|
| Dashboard | **Projects** | Start screen. Projects grouped by customer. |
| — | **Processing** | New. Every run across all projects, with queue and delivery stages. Absorbs "Background work". |
| Background work | Processing → *Imports* and *Model derivatives* tabs | The header Background badge stays and links here. |
| Providers & nodes | **Nodes & presets** | Same master/detail layout, with node actions in a ⋯ menu. |
| Recycle Bin | Recycle Bin | Unchanged, with the duplicate heading removed. |
| Diagnostics | Diagnostics | Keeps storage, worker and failed mutations. Run history moves to Processing and per-task Runs. |

The rail footer keeps platform health. The header keeps: page title + breadcrumb, Background badge,
Refresh (with a busy state), and **New project**. On mobile, New project moves into the Projects page
header so it's always reachable.

### Hierarchy

Codex's hierarchy draft:

```
Organization / customer        (new; optional grouping)
  └─ Project                   (existing, e.g. "New Build")
       └─ Task                 (existing)
            └─ Run / attempt   (existing attempts; new stage/attention metadata)
                 └─ Outputs / versions
```

- Groups or subcategories are an **optional** extra level inside an organization. They are a heading,
  never a required step.
- Legacy projects with no `organizationId` appear under **Unassigned**, in its own group, at the end.
- Grouping is display only. It never merges clients by display name and never grants access.

### Routes

The existing params stay, and one is added: `?section=projects&org=&project=&task=&panel=`.
`section=dashboard` keeps working as an alias, so bookmarks and Ops deep links don't break.
`panel` gains `overview` (default) and `runs`, alongside today's `files`, `gcp` and `settings`.

---

## 4. Screens

### 4.1 Projects (start screen)

- **Status strip** (one row, replacing the four large cards):
  - Processing now
  - Needs attention
  - Ready to share
  - Nodes healthy

  Each item is a filter chip. On mobile the strip scrolls sideways instead of stacking four tall
  cards.
- **Toolbar:**
  - Search across customer, project and task names.
  - Customer filter.
  - Status chips: All, Processing, Needs attention, Ready.
  - Sort: Recent activity (default) or Name.
- **List grouped by customer.** Each group heading shows the customer name, its project count, and a
  collapse toggle. Each project row shows:
  - name and short description;
  - latest activity (when, and what);
  - counts (tasks, running, ready);
  - an attention badge when needed.

  Clicking a row opens the project page; it no longer expands an accordion.
- **Empty state:** "No projects yet", with a New project button.
- **Error state:** "Couldn't load projects", with the reason and a Try again button. This is
  separate per data source, so a failed provider list doesn't hide projects.

### 4.2 Project page

- Breadcrumb: Customer › Project.
- Title and description. Primary action **New task**. Also Share, and a ⋯ menu with Rename,
  Import existing results, Move to Recycle Bin, and later Assign to customer once Codex's API exists.
- **Tasks table** (cards on mobile). Columns:
  - Task
  - Latest run status and stage chip
  - Images
  - Runtime
  - Updated
  - Quick action: **Open 3D** when ready, otherwise **View run**.
- **Source sets** become "Photo sets", in a collapsible section under the tasks with the same
  actions as today.

### 4.3 Task page (one detail pattern)

- Breadcrumb: Customer › Project › Task.
- Header: task name, status and stage chip. Primary action **Open 3D model**. Secondary actions are
  Model report and Share. The ⋯ menu holds Download files, Rename, Restart/Cancel, and Move to
  Recycle Bin.
- **Tabs** (each keeps its existing deep link):
  1. **Overview.** Survey facts (GSD, area, points, CRS, disk), orthophoto preview, the latest run
     card with live log (Download tail, Fullscreen), and LOD/streaming notices.
  2. **Runs.** New per-task run history using the existing `attemptHistory()` and the
     `/tasks/{id}/attempts` data: run number, start time, duration, node, outcome and stage
     timeline, plus "View diagnostics" for each run.
  3. **Files & versions.** Today's output panel. Each version shows **one** primary action (Open /
     Download), with the rest in ⋯.
  4. **Ground control points.** Unchanged workflow, restyled.
  5. **Settings.** Processing options, streaming and product recovery, and photo-set lifecycle.
- The inline task expansion on the dashboard is **removed**. Clicking a task always opens this page.

### 4.4 Processing (new)

- **Runs tab.** All active and recent runs across projects, grouped by stage:
  - Running
  - Waiting (for worker, transfer or delivery)
  - Needs attention (disk-pressure blocked, delivery retrying, awaiting acceptance)
  - Finished today

  Each row links to the task page Runs tab.
- **Imports** and **Model derivatives** tabs show today's Background content. The cap of 3 rows
  becomes ordinary paging (25 rows).

### 4.5 Nodes & presets

The layout is unchanged, with these changes:
- Node actions (Edit, Token, Refresh capabilities, Disable) go in a ⋯ menu.
- Each preset row has one **Edit** button, with View, Duplicate and Delete in a ⋯ menu.
- "Viewer admission" becomes "Max parallel jobs".

---

## 5. Run status design

Two separate signals, matching Codex's draft:

- **Outcome badge** (the existing `attempt.status`, unchanged meaning): Queued · Running · Completed ·
  Failed · Cancelled.
- **Stage / attention chip** (new orchestration metadata, shown only when present):

| Stage | Label | Tone |
|---|---|---|
| `waiting_for_worker` | Waiting for a worker | neutral |
| `waiting_for_transfer` | Transferring photos | neutral (progress if given) |
| `waiting_for_delivery` | Waiting for results | neutral |
| `awaiting_acceptance` | Checking results | neutral |
| `delivery_retrying` | Retrying delivery | amber |
| `blocked_disk_pressure` | Paused: storage full | amber, counted in "Needs attention", with a link to Diagnostics → storage |
| `accepted` | Delivered | green (only until Completed shows) |

**Connection rule:** when the browser loses contact with the API, runs keep their last known state
with a grey "Status unknown, reconnecting" note. They are never shown as failed or disappeared. Codex
will provide the exact enum fixture; until then I'll use a stub that has these values.

---

## 6. Visual system

- **Theme:** dark only (`color-scheme: dark`), as today.
- **Tokens:** one `:root` block in `workspace.css`, mapped from `packages/ui/src/styles.css` and
  adapted for dark surfaces:

| Ops token | Ops value | Viewer (dark) |
|---|---|---|
| `--orange` (primary) | `#ee5007` | `#ee5007` (hover `#ff6b24`, pressed `#a83a05`) |
| `--blue` (links/secondary) | `#2468d6` | `#5b8ff0` (lightened to keep contrast on dark) |
| `--green` / `--red` / `--amber` | `#17713e` / `#9c2735` / `#9a3c08` | `#45d483` / `#ff6b6b` / `#f5a524` text on 12–16% tinted fills |
| `--radius-sm/md/lg` | 8 / 11 / 14px | same |
| `--space-xs…xl` | .5 / .75 / 1 / 1.5 / 2.5rem | same |
| `--focus-ring` | `0 0 0 3px rgba(238,80,7,.2)` | same colour at .45 alpha |
| font | Inter, system-ui | Inter, system-ui (drop the never-loaded Outfit) |

- Surfaces: `--surface-0` (page) `#08090b`, `--surface-1` (panels) `#111216`, `--surface-2`
  (raised/hover) `#18191e`, and `--border` `#292b32`. These are today's values, now named.
- All roughly 79 hard-coded colours are replaced by tokens.
- Type scale: body text 14px, small 12px (metadata only), headings 16/20/24px.
- **Brand:** the approved LT mark (`LT_MARK_SVG` from `packages/ui`) inlined in the rail and the
  favicon, plus "Ledge Top" / "Viewer". The page title is "Ledge Top Viewer". This removes the
  remote `ledgetopdroneservices.com` logo dependency.

---

## 7. Preservation list (must keep working)

- **Model view:** PR 321 navigation, the unfinished-measurement guard, and `dialog[open]` keyDown.
  Volumes, profiles, clipping and orthophoto-first open. `index.html`, `main.js` and
  `measurement-*` are not touched.
- **Auth:** the `/workspace/<grant>` redeem flow, renewal, and current-tab recovery. The
  modules are not touched; only their containers are restyled.
- **Sharing:** public links (create, edit, revoke, password, expiry, views, permissions), direct
  client grants, and the "Share through an Operations project" fallback. Same forms, ids and
  `data-*` hooks.
- **Task workflow:** New task dialog (files, folder, server, saved source; photo map; node; preset;
  options; continue in background), cancel/restart/retry, live logs, GCP marking, imports (device and
  server folder), uploads with leave-page warning, LOD/streaming recovery, and product downloads.
- **Storage:** Recycle Bin restore/purge (type-the-ID confirmation), and failed-mutation retry.
- **Every** `data-action` name, form id, and `#workspace*` shell id that JavaScript or tests rely on,
  unless the PR that changes it also updates its test.

---

## 8. Accessibility and responsive acceptance

- Skip link; nav `aria-current="page"`; visible `:focus-visible` on every interactive element.
- Replace the whole-content live region with one small `role=status` announcer ("Loaded 12 projects",
  "Refresh failed"). Error toasts become `role=alert`.
- `openModal` restores focus. Import tabs get `role=tab` and `aria-selected`. Breadcrumbs use
  `nav[aria-label=Breadcrumb]`.
- Contrast: body text ≥ 4.5:1 and UI parts ≥ 3:1 on every surface token, checked with a script.
- Touch targets ≥ 44px (already tested for task quick actions).
- No horizontal scroll at 320, 390 and 1440px, matching the existing browser test. At 375px,
  projects appear in the first screen.

**Browser acceptance:**
- the existing `workspace-project-browser.test.mjs` flows (updated selectors), plus new cases for
  the customer grouping, task tabs, Runs tab, Processing page, and error/loading states;
- run on the synthetic fixture server, Edge headless, at 3 widths;
- screenshots before and after attached to each PR.

---

## 9. Delivery plan (small PRs, each fully tested)

| # | PR | Main files | Tests to update |
|---|---|---|---|
| 1 | **Tokens, typography, brand.** No markup or structure change. | `workspace.css`, `workspace-management.css`, `workspace-transfers.css`, `workspace-task-workflow.css`, `workspace.html` (brand/title/favicon only) | none expected (CSS `@media(max-width:720px)` and `min-height:46px` strings kept) |
| 2 | **Loading, error and busy states + a11y basics** (skip link, aria-current, focus rings, announcer, modal focus restore) | `workspace-projects.js` (`load`, `render`, `openModal`), `workspace.html` | `workspace-project-browser` (live-region expectations), `workspace-task-layout` (render output) |
| 3 | **Projects page grouped by customer** (stub adapter: legacy projects go to Unassigned) + status strip + filters | `workspace-projects.js`, new `workspace-hierarchy.mjs` (pure, unit-tested) | `workspace-project-dashboard` (NAV order/labels, metric markup), `workspace-shell` (route fn names), `workspace-project-browser` |
| 4 | **Project page and task page tabs** (remove inline accordions; add Overview and Runs tabs) | `workspace-projects.js` | `workspace-task-layout` (taskDetail/taskWorkspacePage output, panel names), `workspace-project-browser`, `project-share-browser` (`open-project` flow) |
| 5 | **Processing page and run-stage chips** (uses Codex's enum fixture) | `workspace-projects.js`, new `workspace-run-status.mjs` | `workspace-project-dashboard` (background ids), new unit tests for stage mapping |
| 6 | **Action and copy clean-up** (⋯ menus on outputs, nodes and presets; plain labels) | `workspace-projects.js` | label assertions in `workspace-project-dashboard`, `workspace-task-layout`, `workspace-direct-client-browser` (texts) |

**Test constraint:** many tests slice `workspace-projects.js` by **function name** and need
one-line declarations (`function taskPanel(`, `const X=` …). Each PR keeps existing function names
and declaration lines. New UI goes into new functions or modules. Any rename updates its test in the
same PR, as listed above.

---

## 10. Coordination needed with Codex

- **Hierarchy DTO:** organizations/customers, optional groups, `organizationId`/`groupId` on projects
  (null means Unassigned), and an endpoint or field to list them. Needed for PR 3; until then I use a
  stub fixture.
- **Run stage enum fixture**, needed for PR 5.
- **Shared seams I will not edit without agreement:** `workspace-new-task.mjs` (restyle via CSS
  only), `workspace-dialogs.mjs`, `workspace-direct-client-share.mjs`, `workspace-task-options.mjs`,
  and the recovery/renewal modules.
- **`workspace.js`** is dead code: not loaded and not tested. I propose deleting it in PR 1 if Codex
  agrees.

## 11. Decisions for Beau

1. Rename **Dashboard → Projects** and add a **Processing** page that absorbs Background work?
   (Recommended.)
2. Replace the four big metric cards with a **slim status strip**? (Recommended; this is the
   biggest mobile win.)
3. Group the project list **by customer by default**, with Unassigned last? (Recommended; there is
   a toggle for a flat list.)
