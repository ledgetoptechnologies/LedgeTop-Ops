import { useEffect, useMemo, useRef, useState } from "react";

export interface ChartSeries { label: string; color: string; values: Array<number | null>; axis?: "left" | "right"; format: (value: number) => string }
interface Props {
  title: string; time: number[]; series: ChartSeries[]; leftLabel?: string; rightLabel?: string;
  /** Shared across every chart and the map: the hovered time (ms) and the zoomed window (ms). */
  cursor: number | null; onCursor: (ms: number | null) => void; range: [number, number]; onRange: (range: [number, number] | null) => void;
}

const HEIGHT = 190, PAD = { left: 52, right: 52, top: 12, bottom: 26 };

/** Index of the last sample at or before `ms` (time is ascending). */
export function indexAt(time: number[], ms: number) {
  let lo = 0, hi = time.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (time[mid]! <= ms) lo = mid; else hi = mid - 1; }
  return lo;
}

function niceTicks(min: number, max: number, count = 4) {
  if (!(max > min)) return [min];
  const step = Math.pow(10, Math.floor(Math.log10((max - min) / count))), err = (max - min) / count / step;
  const nice = step * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
  const ticks = []; for (let v = Math.ceil(min / nice) * nice; v <= max + nice * 1e-9; v += nice) ticks.push(Number(v.toFixed(10)));
  return ticks;
}
const clockLabel = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/**
 * A canvas line chart for one group of telemetry. Long flights are drawn as a min/max envelope per pixel,
 * so 100,000 samples cost the same as 1,000. Hover shows values at the shared cursor; drag zooms all charts.
 */
export function TelemetryChart({ title, time, series, leftLabel, rightLabel, cursor, onCursor, range, onRange }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null), wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const visible = series.filter(item => !hidden.has(item.label));

  useEffect(() => {
    const node = wrap.current; if (!node) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(280, Math.floor(entries[0]!.contentRect.width))));
    observer.observe(node); return () => observer.disconnect();
  }, []);

  const extents = useMemo(() => {
    const [from, to] = range, start = Math.max(0, indexAt(time, from)), end = Math.max(start, indexAt(time, to));
    const result: Record<"left" | "right", [number, number] | null> = { left: null, right: null };
    for (const item of visible) {
      const axis = item.axis ?? "left";
      for (let i = start; i <= end; i++) {
        const v = item.values[i]; if (v == null) continue;
        const current = result[axis]; result[axis] = current ? [Math.min(current[0], v), Math.max(current[1], v)] : [v, v];
      }
    }
    for (const axis of ["left", "right"] as const) {
      const e = result[axis]; if (e && e[0] === e[1]) result[axis] = [e[0] - 1, e[1] + 1];
    }
    return { start, end, ...result };
  }, [time, visible, range]);

  const plotWidth = width - PAD.left - PAD.right, plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const xOf = (ms: number) => PAD.left + ((ms - range[0]) / Math.max(1, range[1] - range[0])) * plotWidth;
  const msOf = (x: number) => range[0] + ((x - PAD.left) / plotWidth) * (range[1] - range[0]);

  useEffect(() => {
    const node = canvas.current; if (!node) return;
    const ratio = window.devicePixelRatio || 1;
    node.width = width * ratio; node.height = HEIGHT * ratio;
    const ctx = node.getContext("2d"); if (!ctx) return;
    ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, HEIGHT);
    const styles = getComputedStyle(node), grid = styles.getPropertyValue("--chart-grid") || "#e3e6ea", ink = styles.getPropertyValue("--chart-ink") || "#5a636e";
    ctx.font = "11px Inter, system-ui, sans-serif"; ctx.fillStyle = ink; ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (const axis of ["left", "right"] as const) {
      const e = extents[axis]; if (!e) continue;
      for (const tick of niceTicks(e[0], e[1])) {
        const y = PAD.top + plotHeight - ((tick - e[0]) / (e[1] - e[0])) * plotHeight;
        if (axis === "left") { ctx.beginPath(); ctx.moveTo(PAD.left, y + 0.5); ctx.lineTo(PAD.left + plotWidth, y + 0.5); ctx.stroke(); }
        ctx.textAlign = axis === "left" ? "right" : "left";
        ctx.fillText(String(Math.round(tick * 10) / 10), axis === "left" ? PAD.left - 6 : PAD.left + plotWidth + 6, y + 4);
      }
    }
    ctx.textAlign = "center";
    for (const tick of niceTicks(range[0] / 1000, range[1] / 1000, 6)) ctx.fillText(clockLabel(tick * 1000), xOf(tick * 1000), HEIGHT - 8);
    for (const item of visible) {
      const e = extents[item.axis ?? "left"]; if (!e) continue;
      const yOf = (v: number) => PAD.top + plotHeight - ((v - e[0]) / (e[1] - e[0])) * plotHeight;
      ctx.strokeStyle = item.color; ctx.lineWidth = 1.6; ctx.beginPath();
      let column = -1, lo = 0, hi = 0, started = false;
      const flush = () => { if (column < 0) return; const x = PAD.left + column + 0.5;
        if (!started) { ctx.moveTo(x, yOf(lo)); started = true; } else ctx.lineTo(x, yOf(lo)); if (hi !== lo) ctx.lineTo(x, yOf(hi)); };
      for (let i = extents.start; i <= extents.end; i++) {
        const v = item.values[i]; if (v == null) continue;
        const c = Math.floor(xOf(time[i]!) - PAD.left);
        if (c !== column) { flush(); column = c; lo = v; hi = v; } else { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      flush(); ctx.stroke();
    }
    if (cursor != null && cursor >= range[0] && cursor <= range[1]) {
      ctx.strokeStyle = ink; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(xOf(cursor) + 0.5, PAD.top); ctx.lineTo(xOf(cursor) + 0.5, PAD.top + plotHeight); ctx.stroke(); ctx.setLineDash([]);
    }
    if (drag) { ctx.fillStyle = "rgba(238, 80, 7, 0.12)"; ctx.fillRect(Math.min(drag[0], drag[1]), PAD.top, Math.abs(drag[1] - drag[0]), plotHeight); }
  }, [width, extents, visible, cursor, range, drag, time, plotHeight, plotWidth]);

  const at = cursor == null ? -1 : indexAt(time, cursor);
  const local = (event: React.PointerEvent) => event.clientX - (event.currentTarget as HTMLElement).getBoundingClientRect().left;
  return <figure className="flight-chart" ref={wrap}>
    <figcaption><strong>{title}</strong>
      <span className="flight-chart-legend">{series.map(item => <button type="button" key={item.label} aria-pressed={!hidden.has(item.label)}
        onClick={() => setHidden(current => { const next = new Set(current); if (next.has(item.label)) next.delete(item.label); else next.add(item.label); return next; })}>
        <i style={{ background: item.color }} />{item.label}{at >= 0 && item.values[at] != null && !hidden.has(item.label) ? `: ${item.format(item.values[at]!)}` : ""}
      </button>)}</span>
    </figcaption>
    <div className="flight-chart-axes"><span>{leftLabel}</span><span>{rightLabel}</span></div>
    <canvas ref={canvas} style={{ width: "100%", height: HEIGHT }} role="img"
      aria-label={`${title} over the flight. Drag across the chart to zoom; double-click to reset.`}
      onPointerMove={event => { const x = local(event); if (drag) setDrag([drag[0], x]); onCursor(Math.min(range[1], Math.max(range[0], msOf(x)))); }}
      onPointerLeave={() => { onCursor(null); }}
      onPointerDown={event => { (event.target as HTMLElement).setPointerCapture(event.pointerId); setDrag([local(event), local(event)]); }}
      onPointerUp={() => { if (drag && Math.abs(drag[1] - drag[0]) > 8) { const a = msOf(Math.min(...drag)), b = msOf(Math.max(...drag)); onRange([a, b]); } setDrag(null); }}
      onDoubleClick={() => onRange(null)} />
  </figure>;
}
