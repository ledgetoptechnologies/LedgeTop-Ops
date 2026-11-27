import { BRAND_COLORS, LT_MARK } from "./brand";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The page's own styles: the mark's frame traces itself, the orange corner breathes and a thin bar
 * sweeps beneath. System colours only, no fonts or other assets; reduced motion holds a still mark.
 */
export const VIEWER_PLACEHOLDER_CSS = "html,body{height:100%;margin:0}"
  + "body{display:grid;place-items:center;background:#11181d;overflow:hidden}"
  + "main{display:grid;justify-items:center;gap:1.75rem}"
  + "main::before{content:\"\";position:fixed;inset:0;pointer-events:none;"
  + `background:radial-gradient(circle at 50% 46%,${BRAND_COLORS.orange}1f 0,transparent 34rem)}`
  + "svg{width:5.5rem;height:5.5rem;overflow:visible;filter:drop-shadow(0 .5rem 1.5rem #0008)}"
  + ".frame{stroke-dasharray:1;stroke-dashoffset:1;animation:lt-trace 2.4s cubic-bezier(.65,0,.35,1) infinite}"
  + ".accent{animation:lt-breathe 2.4s ease-in-out infinite}"
  + ".letters{opacity:0;animation:lt-rise .7s .15s ease-out forwards}"
  + `.bar{position:relative;width:7.5rem;height:3px;border-radius:3px;background:${BRAND_COLORS.markLight}1a;overflow:hidden}`
  + `.bar::after{content:\"\";position:absolute;inset:0 auto 0 0;width:40%;border-radius:inherit;background:${BRAND_COLORS.orange};`
  + "animation:lt-sweep 1.4s cubic-bezier(.65,0,.35,1) infinite}"
  + ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}"
  + "@keyframes lt-trace{0%{stroke-dashoffset:1}55%,75%{stroke-dashoffset:0}100%{stroke-dashoffset:-1}}"
  + "@keyframes lt-breathe{0%,100%{opacity:.45}50%{opacity:1}}"
  + "@keyframes lt-rise{from{opacity:0;transform:translateY(.4rem)}to{opacity:1;transform:none}}"
  + "@keyframes lt-sweep{from{transform:translateX(-100%)}to{transform:translateX(250%)}}"
  + "@media (prefers-reduced-motion:reduce){.frame,.accent,.letters,.bar::after{animation:none}"
  + ".frame{stroke-dashoffset:0}.letters{opacity:1}.bar::after{width:100%;opacity:.6}}";

/**
 * Fills the blank tab shown while the secure 3D Viewer session is issued: the animated Ledge Top mark and
 * a sweep bar, with the status kept for screen readers only. Built from DOM nodes and fixed values, so
 * nothing is parsed as markup, no caller data is shown and nothing outside the document is loaded.
 */
export function writeViewerPlaceholder(target: Document) {
  const style = target.createElement("style");
  style.textContent = VIEWER_PLACEHOLDER_CSS;
  const main = target.createElement("main");
  main.setAttribute("role", "status");
  const svg = target.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", LT_MARK.viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const stroke = (className: string, color: string, d: string) => {
    const path = target.createElementNS(SVG_NS, "path");
    path.setAttribute("class", className);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", String(LT_MARK.strokeWidth));
    path.setAttribute("pathLength", "1");
    path.setAttribute("d", d);
    return path;
  };
  svg.appendChild(stroke("frame", BRAND_COLORS.markLight, LT_MARK.frame));
  svg.appendChild(stroke("accent", BRAND_COLORS.orange, LT_MARK.accent));
  const letters = target.createElementNS(SVG_NS, "path");
  letters.setAttribute("class", "letters");
  letters.setAttribute("fill", BRAND_COLORS.markLight);
  letters.setAttribute("d", LT_MARK.letters);
  svg.appendChild(letters);
  const bar = target.createElement("div");
  bar.className = "bar";
  bar.setAttribute("aria-hidden", "true");
  const status = target.createElement("span");
  status.className = "sr";
  status.textContent = "Opening the 3D Viewer";
  main.appendChild(svg);
  main.appendChild(bar);
  main.appendChild(status);
  target.head.appendChild(style);
  target.body.textContent = "";
  target.body.appendChild(main);
}
