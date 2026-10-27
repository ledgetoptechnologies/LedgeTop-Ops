/** Content-free startup evidence. This protocol never authorizes or renews a session. */
const PHASES = new Set([
  "shell-loaded", "module-started", "redeem-started", "redeem-http",
  "session-applied", "init-returned", "ready-sent", "bootstrap-failed",
]);
const HTTP_STATUSES = new Set<number | string>([200, 400, 401, 403, 404, 409, 410, 429, 500, 502, 503, 504, "other"]);
export const VIEWER_DIAGNOSTICS_TTL_MS = 60_000;

export type ViewerStartupSnapshot = Readonly<{
  phase: string;
  sequence: number;
  frameLoads: number;
  stages: readonly string[];
  status?: number | "other";
}>;

export function createViewerStartupDiagnostics({ origin, nonce, source, now = () => performance.now(), onChange }: {
  origin: string;
  nonce: string;
  source: () => Window | null | undefined;
  now?: () => number;
  onChange: (snapshot: ViewerStartupSnapshot) => void;
}) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || !/^[a-f0-9]{32}$/.test(nonce)) {
    throw new Error("Invalid Viewer diagnostics binding");
  }
  const startedAt = now();
  let closed = false;
  let probes = 0;
  let snapshot: ViewerStartupSnapshot = Object.freeze({ phase: "awaiting-shell", sequence: 0, frameLoads: 0, stages: Object.freeze([]) });
  const live = () => !closed && now() >= startedAt && now() - startedAt < VIEWER_DIAGNOSTICS_TTL_MS;
  const update = (next: ViewerStartupSnapshot) => { snapshot = Object.freeze(next); onChange(snapshot); };
  return {
    probe() {
      const target = source();
      if (!live() || !target || probes >= 4) return false;
      probes += 1;
      try {
        target.postMessage({ version: 1, type: "ltds-viewer:startup-probe", nonce }, origin);
        return true;
      } catch {
        // Optional diagnostics must never interrupt authorization or rendering.
        return false;
      }
    },
    frameLoaded() {
      if (!live()) return;
      if (snapshot.frameLoads > 0) {
        // WindowProxy survives navigation. Never attribute a replacement document's
        // reset sequence (or an old queued reply) to this initial startup attempt.
        closed = true;
        update({ ...snapshot, phase: "frame-reloaded", frameLoads: 2 });
        return;
      }
      update({ ...snapshot, frameLoads: 1 });
    },
    receive(event: Pick<MessageEvent, "origin" | "source" | "data">) {
      if (!live() || event.origin !== origin || !event.source || event.source !== source()) return false;
      const data: unknown = event.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return false;
      const value = data as Record<string, unknown>;
      const keys = Object.keys(value).sort().join(",");
      const http = value.phase === "redeem-http";
      if (keys !== (http ? "nonce,phase,sequence,status,type,version" : "nonce,phase,sequence,type,version") ||
        value.version !== 1 || value.type !== "ltds-viewer:startup-phase" || value.nonce !== nonce ||
        typeof value.phase !== "string" || !PHASES.has(value.phase) ||
        !Number.isInteger(value.sequence) || Number(value.sequence) < 1 || Number(value.sequence) > 16 ||
        Number(value.sequence) <= snapshot.sequence ||
        (http && !HTTP_STATUSES.has(value.status as number | string))) return false;
      update({ ...snapshot, phase: value.phase, sequence: Number(value.sequence),
        stages: Object.freeze([...snapshot.stages, http ? `redeem-http:${value.status}` : value.phase]),
        ...(http ? { status: value.status as number | "other" } : {}) });
      return true;
    },
    snapshot: () => snapshot,
    close() { closed = true; },
  };
}
