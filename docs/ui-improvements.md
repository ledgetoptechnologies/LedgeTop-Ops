# UI/UX Improvements

## 2026-08-02 — CSS/UI Polish

A comprehensive CSS and UI/UX improvement pass across the shared design system
and both app-specific stylesheets. No logic changes, CSS-only.

### Shared Design System (`packages/ui/src/styles.css`)

- **Design tokens**: Added CSS custom properties for colors (`--green`,
  `--green-soft`, `--red`, `--red-soft`, `--amber`, `--amber-soft`,
  `--blue-dark`), border radii (`--radius-sm/md/lg`), shadows
  (`--shadow-sm/md/lg`), and spacing (`--space-xs/sm/md/lg/xl`).
- **Typography**: Added `text-rendering: optimizeLegibility` and
  `-webkit-font-smoothing: antialiased` for crisper text rendering.
  Body `line-height: 1.5` for better readability.
- **Buttons**: Added hover states for all button variants (default dark,
  orange, ghost, danger). Added `:active` transform feedback
  (`scale(.98)`). Added `display: inline-flex` with `gap` for icon
  alignment. Disabled buttons no longer change background on hover.
- **Focus-visible**: Global `:focus-visible` outline (3px orange-tinted)
  on all interactive elements: `button`, `.button`, `a`, `input`,
  `select`, `textarea`. Improves keyboard accessibility across the
  entire app.
- **Links**: Added `:hover` (underline + darker blue) and `:active`
  (orange) states. Added `transition: color .15s ease`.
- **Status pills**: Added `align-items: center` and `white-space: nowrap`
  to prevent pill text wrapping.
- **Notice banners**: New `.notice`, `.notice.error`, `.notice.ok`,
  `.notice.warning` utility classes with consistent left-border accent
  styling. Used by the operations app for status messages.
- **Table base**: New `table`, `th`, `td` base styles with uppercase
  header labels, hover row highlighting, and `td small` muted detail
  text. Reduces duplication with per-app table styles.
- **Reduced motion**: Global `prefers-reduced-motion` rule that
  effectively disables all animations and transitions for users who
  request reduced motion.

### Client App (`apps/client/src/client/styles.css`)

- **Breadcrumb buttons**: Added `border-radius`, `transition`, and
  `:focus-visible` outline. Previously had no keyboard focus indicator.
- **View switch**: Added `border-radius`, `transition`, `:hover` color
  change, and `:focus-visible` outline. Previously had no hover or focus
  feedback.
- **Top navigation links**: Added `:focus-visible` outline for keyboard
  accessibility.
- **Account button**: Added `cursor: pointer`, `transition`, `:hover`
  background change, and `:focus-visible` outline. Previously had no
  interactive feedback despite being a clickable button.
- **Sidebar navigation**: Added `:focus-visible` outline on
  `.client-portal-nav a` links.
- **Workspace tabs**: Added `transition` and `:hover` color change.
  Added `:focus-visible` outline.
- **Project strip buttons**: Added `:focus-visible` outline.
- **Project cards**: Added `:focus-within` border highlight (when a
  card contains a focused link). Added `.portal-back` hover color
  transition.
- **Portal message color fix**: Changed `.portal-message` default color
  from green (`#247a43`) to neutral (`var(--muted)`). The green default
  was misleading for non-success messages. Success messages now use the
  `.portal-request-notice` class which explicitly sets green.

### Operations App (`apps/operations/src/client/styles.css`)

- **Header nav buttons**: Added `transition` for smooth color/border
  changes. Added `:focus-visible` outline for keyboard navigation.
- **Delivery tools buttons**: Added `border-radius`, `transition`,
  `:hover` background, and `:focus-visible` outline. Previously had no
  hover or focus feedback.
- **Subtabs (delivery + operations)**: Added `border-radius`,
  `transition`, `:hover` color change, and `:focus-visible` outline.
- **Mobile stats**: Improved spacing on `max-width:700px` breakpoint:
  increased gap from `.5rem` to `.65rem`, increased card padding from
  `.8rem` to `.85rem`, and reduced stat font size from `2rem` to
  `1.6rem` to prevent text overflow on narrow screens.
- **Reduced motion**: Added `prefers-reduced-motion` rule scoped to
  `.ops-shell *` that disables animations and transitions.

### Verification

All gates pass:
- TypeScript: `tsc --noEmit` clean for both apps
- Tests: 194 client + 152 operations = 346 total, all pass
- Builds: Both apps build successfully via `node scripts/build.mjs`
- Source layout invariants: 4/4 pass

### Files Changed

| File | Lines Changed |
|------|--------------|
| `packages/ui/src/styles.css` | +225 -5 |
| `packages/ui/src/index.tsx` | trailing newline only |
| `apps/client/src/client/styles.css` | +14 -5 |
| `apps/operations/src/client/styles.css` | +9 -2 |