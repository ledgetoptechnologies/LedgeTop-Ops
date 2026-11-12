# Ledge Top UI standards

This is the single reference for how Ledge Top web UI should look, read, and
behave across **Operations** (`apps/operations`), the **Client Portal**
(`apps/client`), and the **Viewer** (`apps/viewer`: staff workspace and result
viewer). New UI work should follow it; existing UI is being brought into line
in small, reviewable steps (see "Roadmap" at the end).

`docs/ui-improvements.md` is a changelog of past work. This file is the
standard.

## 1. Principles

1. **One product, three doors.** Staff move between Operations and the Viewer,
   and clients move between the Client Portal and the Viewer, without feeling
   they changed vendor: the same mark, colours, words, account menu, and a way
   back.
2. **Say where people are.** Every screen has a URL, a page title, a visible
   heading, and (below the top level) a breadcrumb or a back link to its
   parent.
3. **No dead ends.** Every final state (error, expired link, empty result) says
   what happened and offers the next action.
4. **Accessible by default.** WCAG 2.2 AA is the floor, not a stretch goal.
5. **Tokens, not literals.** Colours, sizes, radii, shadows and motion come from
   the shared tokens in `packages/ui/src/styles.css`. The Viewer (plain HTML/JS)
   mirrors the same names and values in its own stylesheets.

## 2. Brand

- The generic **LT mark** plus the words **Ledge Top** on every domain and
  every standalone page (sign-in, onboarding, admin tools, share links,
  recovery pages). Use `Brand`/`LtMark` from `@ltds/ui`, or the inline SVG in
  the Viewer. Never hot-link a logo from another site and never use
  per-domain names such as "Ledge Top Drone Services" or "LTDS" in the UI.
- Brand orange is `#ee5007` (`--orange`). Use it for the mark, accents,
  selected states, focus rings, and large display text.
- Product names: **Operations**, **Client Portal**, **Viewer** (staff area:
  **Viewer workspace**). Page titles read `<Page> · <Product> · Ledge Top`.
- Help copy: there is no support mailbox. Use exactly "Ask your Ledge Top
  contact or admin." (or "…contact or admin to …") instead of writing a new
  sentence such as "Contact your Ledge Top representative".

## 3. Tokens

### Colour

| Token | Value | Use |
|---|---|---|
| `--orange` | `#ee5007` | Brand mark, non-text accents, focus outline, selected indicator |
| `--orange-action` | `#cc4706` | Filled primary buttons and white-text badges or avatars (4.7:1) |
| `--orange-dark` | `#a83a05` | Primary hover/active (`--orange-hover` aliases it), orange text on light backgrounds |
| `--orange-soft` | `#fff0e8` | Tinted backgrounds for selected/brand areas |
| `--ink` | `#151b22` | Body text |
| `--muted` | `#66717d` | Secondary text (4.6:1 on the page background) |
| `--line` / `--border` | `#e0e5e9` | Dividers, card borders |
| `--paper` | `#fff` | Cards, inputs |
| `--blue`, `--green`, `--red`, `--amber` (+ `-soft`) | | Links, success, danger, warning |
| `--focus-ring` | `0 0 0 2px var(--orange)` | Focus ring for inputs that draw their own border |
| `--control-placeholder` | `#6b7580` | Placeholder text (4.7:1) |

White text on `#ee5007` is only 3.6:1, which fails WCAG for normal text, so
**filled buttons use `--orange-action`**, never `--orange`.

The Viewer is dark. It uses the same brand values with dark surfaces; muted
text on its dark background must still reach 4.5:1 (for example `#9699a3`,
6.6:1, not `#717275`, 3.9:1).

### Type, space, shape

- Font: Inter (loaded by the shared UI package), falling back to the system UI
  stack. Never name a font in CSS that the page does not load.
- Type scale (proposed): `.75rem, .875rem, 1rem, 1.125rem, 1.375rem, 1.75rem`.
  New CSS picks from these; do not add new in-between sizes.
- Spacing: `--space-xs .5rem`, `--space-sm .75rem`, `--space-md 1rem`,
  `--space-lg 1.5rem`, `--space-xl 2.5rem`.
- Radius: `--radius-sm 8px` (controls, buttons), `--radius-md 11px` (cards),
  `--radius-lg 14px` (dialogs, large panels), `999px` only for pills.
- Shadow: `--shadow-sm`, `--shadow-md`, `--shadow-lg`. No new literal shadows.
- Breakpoints: `640px` (phone), `960px` (tablet / nav collapse), `1280px`
  (wide). Use `max-width: 639.98px` style ranges so breakpoints never overlap.

## 4. Components and patterns

| Need | Use | Don't |
|---|---|---|
| Primary action | `.button-orange` (one per view) | A second orange button beside it |
| Secondary action | `.button-ghost` | Bare dark default `button` |
| Destructive action | `.button-danger`, confirmed in a dialog | `window.confirm()` |
| Confirm / choose / enter text | `requestChoice` / `requestText` / `<Dialog>` from `@ltds/ui` | `confirm()`, `alert()`, `prompt()`, hand-rolled `role="dialog"` divs |
| Loading | `Skeleton` for content areas, `Loading` for short waits | Spinner on a final state |
| Empty | `EmptyState` with the next action | Plain "No items" text |
| Error | `.notice.error` with `role="alert"` and a retry or next step | Raw server error text |
| Sub-sections of a page | `SubNav` (links with `aria-current="page"`) | `role="tablist"` on navigation links |
| Dates | `formatDate` / `formatDateTime` (`@ltds/shared`) | Bare `toLocaleString()` |
| Sizes | `formatBytes` | Raw byte counts |

Tabs (`role="tablist"`) are only for content that swaps in place without
changing the URL, with arrow-key support. Anything that changes the URL is a
link.

## 5. Navigation

- **Every view has a URL** and Back/Forward work. In-app links are routed
  client-side (no full reload for same-app links).
- **Page title** updates on every view; **focus moves to the page `h1`** after
  in-app navigation so screen readers announce the new page.
- **Breadcrumbs** on every page below the top level
  (e.g. `Clients › Acme › Request 42`). A lone "Back" button is not enough.
- **Top navigation** names match page headings exactly. A menu never contains
  an item with the menu's own name.
- **Standalone admin pages** use the same `Brand` header and a "Back to
  Operations" link, and are linked from Administration.

### Viewer information architecture (approved)

Client → Viewer project → tasks. **Group** never appears in the project list
or breadcrumbs; at most it is optional staff metadata in client management.

### Moving between apps

| From → To | Opens | Must provide |
|---|---|---|
| Operations → Viewer workspace | New tab (same tab if pop-ups are blocked) | LT header, signed-in identity, **Back to Operations** link |
| Viewer workspace → task result | Same Viewer tab family | **Back to task** link to the workspace task |
| Operations → model (session shell) | Same tab | Exactly one header (the Viewer hides its own bar when embedded) |
| Client Portal → model | New tab | LT header, **Back to project** link to the project's 3D models tab |
| Public share link | Same tab | LT header; no account menu (by design) |

Only server-issued grants carry identity between apps; never trust IDs or
roles from URL parameters. If a pop-up is blocked, say so ("Your browser
blocked the new tab") and offer the same-tab fallback.

## 6. Words

Sentence case for everything (buttons, headings, tabs). Use these terms:

| Use | Not |
|---|---|
| Client (the customer organization) | Customer, Organization (in UI copy) |
| Client Portal | client portal, Client Delivery |
| 3D models (Operations area), Viewer (the app) | Models, 3D Viewer, Secure 3D Viewer |
| Viewer workspace | Viewer Workspace |
| Deliveries (client-facing files sent to a client) | Past deliveries, Client archive |
| Trash | Recycle Bin |
| Reset view | Reset camera, Fit to Screen |
| Processing services | Providers & nodes |
| Manage (admin menu) | Administration › Administration |

Open naming decisions are listed under "Roadmap".

## 7. Accessibility checklist (WCAG 2.2 AA)

- Text contrast ≥ 4.5:1 (≥ 3:1 for ≥ 24px or ≥ 18.66px bold); UI parts and
  focus indicators ≥ 3:1. Check with the tokens above.
- Visible focus on every interactive element: `outline: 2px solid var(--orange);
  outline-offset: 2px`. Never remove an outline without a replacement of equal
  contrast.
- Targets ≥ 24×24px (2.5.8); we aim for 44px on touch-first controls.
- A **Skip to content** link as the first focusable element (a shared
  `SkipLink` is planned in `@ltds/ui`), and `header`, `nav`, `main` landmarks.
- Every control has an accessible name (`<label for>`, or `aria-label` for
  icon-only buttons; `title` alone is not enough).
- Toggle buttons expose state with `aria-pressed`; the current page link uses
  `aria-current="page"`.
- Status messages use `role="status"` (polite) or `role="alert"` (errors). Do
  not wrap large re-rendered regions in `aria-live`.
- Dialogs are native `<dialog>` (focus trap, Escape, `aria-labelledby`).
- Respect `prefers-reduced-motion`; avoid motion over 250ms for UI chrome.
- Passwords use `type="password"`.

## 8. Motion

- Use motion for **orientation** (a panel slides from where it came from, a
  dialog fades in), never for decoration.
- Durations: 120–200ms for small elements, ≤ 250ms for panels and pages;
  ease-out on enter, ease-in on exit.
- React apps: [`motion`](https://motion.dev) (`motion/react`) with
  `MotionConfig reducedMotion="user"` and `LazyMotion` to keep the bundle small.
  Viewer: the browser's Web Animations API (or `motion`'s vanilla `animate()`).
- Add page transitions only after in-app links stop doing full reloads;
  otherwise the reload throws the transition away.

### Component libraries

Kokonut UI and Bklit UI are shadcn/ui registries that require Tailwind CSS (and
Bklit uses d3); Meta's Astryx is a React design system built on StyleX and is
still in beta. None of our apps use Tailwind, shadcn or StyleX, so adopting
any of them means a styling-stack migration, not a drop-in. Use them as
**reference designs**: rebuild the specific pattern we want with our tokens.
Revisit Bklit if we add data-heavy dashboards and decide to adopt Tailwind.

## 9. Roadmap

In flight: shared tokens, contrast and focus (#489); help copy and load
failures (#487); in-app confirmation dialogs (#491); sidebar navigation for
Operations and the Client Portal (#494); Viewer look and left rail (#488,
#495, #496); Viewer final-state overlay (#505). Remaining, in order of value:

1. Client-side routing for in-app links in Operations (`AppLink`), per-view
   page titles and focus management. *(Operations, M)*
2. Shared `SubNav`, breadcrumbs, and a `StandaloneShell` for unlinked admin
   pages. *(Operations, M)*
3. Replace native `confirm()`/`alert()` with `@ltds/ui` dialogs. *(Operations,
   M)*
4. Shared `formatDate`/`formatDateTime`/`formatBytes`. *(both React apps, M)*
5. Viewer workspace header: LT mark, identity, "Back to Operations"; result
   viewer "Back to task"; hide the Viewer bar when embedded. *(overlaps open
   Viewer PRs #406/#475; coordinate first)*
6. Viewer final-state overlay with an action instead of a spinner.
   *(touches `apps/viewer/main.js`; coordinate)*
7. Collapse literal colours, radii, shadows and font sizes onto tokens, file
   by file. *(L, incremental)*
8. Merge the duplicated Client Portal home/request pages. *(Client, L)*
9. Optional dark theme for the React apps using the token names above.

**Open naming decisions (need an owner call):** whether the Viewer's area
measurement tool is called *Polygon* (current UI, and #492) or *Area*; whether
the Operations "Data" area is called *Data* or *Delivery*; and how to distinguish a Viewer
project (a folder of 3D tasks under a client) from an Operations project
(a job) in shared screens.
