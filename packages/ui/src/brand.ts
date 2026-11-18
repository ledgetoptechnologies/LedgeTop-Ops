/**
 * The one definition of the Ledge Top mark and brand colours.
 *
 * React apps use it through `LtMark`/`Brand` in index.tsx and the tokens in styles.css. The Viewer is
 * plain JavaScript built from its own folder, so it gets a generated copy: `scripts/viewer-brand.mjs`
 * writes apps/viewer/public/lt-mark.svg from this file, and scripts/viewer-brand.test.mjs fails when that
 * file, the favicons, styles.css or the Viewer's colour variables drift from these values.
 * Keep this file free of imports so Node can load it directly.
 */

export const BRAND_COLORS = {
  /** Brand orange: the mark, non-text accents, focus outlines, selected indicators. */
  orange: "#ee5007",
  /** Filled buttons and white-text badges (4.7:1 with white). */
  orangeAction: "#cc4706",
  /** Hover/active for filled buttons; orange text on light backgrounds. */
  orangeDark: "#a83a05",
  /** Orange text, links and hover on the Viewer's dark surfaces. */
  orangeOnDark: "#ff6b24",
  /** Measurement lines and highlighted values in the Viewer (not used for text on light backgrounds). */
  measureHighlight: "#f8cb2e",
  /** Light strokes and letters of the mark. */
  markLight: "#f5f3ef",
  /** Rounded tile behind the mark in favicons. */
  markTile: "#0b0b0e",
} as const;

export const LT_MARK = {
  viewBox: "238.5 226 776 776",
  strokeWidth: 56,
  frame: "M273.5 655V370.5a99 99 0 0 1 99-99H605M979.5 583v274.5a99 99 0 0 1-99 99H650M605 956.5H372.5a99 99 0 0 1-99-99V703",
  accent: "M650 271.5h230.5a99 99 0 0 1 99 99V538",
  letters: "M365 370l93 92v244h135l66 94H418l-53-54zM503 453h349l54 88H780v332l-96-100V541H563z",
} as const;

const markBody = `<g fill="none" stroke-width="${LT_MARK.strokeWidth}"><path stroke="${BRAND_COLORS.markLight}" d="${LT_MARK.frame}"/><path stroke="${BRAND_COLORS.orange}" d="${LT_MARK.accent}"/></g><path fill="${BRAND_COLORS.markLight}" d="${LT_MARK.letters}"/>`;

/** Approved LT monogram (segmented frame, orange upper-right corner) as standalone SVG markup; transparent for dark surfaces. */
export const LT_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LT_MARK.viewBox}">${markBody}</svg>`;

/** The mark on its dark rounded tile, as every app's favicon.svg. */
export const LT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="190 178 873 873"><rect x="190" y="178" width="873" height="873" rx="190" fill="${BRAND_COLORS.markTile}"/>${markBody}</svg>`;
