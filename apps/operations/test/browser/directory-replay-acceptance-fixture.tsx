import { createRoot } from "react-dom/client";
import { DirectoryReplayAcceptance } from "../../src/client/DirectoryReplayAcceptance";
import { RETAINED_SYNTHETIC_CLIENT_ID } from "../../src/client/DirectoryReplayAcceptanceRoute";
import { ApiError } from "../../src/client/api";

type Call = { path: string; method: string; key: string | null; body: string | null; csrf: string | null; contentType: string | null; credentials: RequestCredentials | undefined };
declare global { interface Window { directoryReplayCalls?: Call[]; directoryReplayMode?: "normal" | "pending" | "denied" | "wrong-record" | "lost-write" | "lost-restore" | "lost-recovery" | "malformed-recovery" | "wrong-source" | "readback-mismatch" | "readback-unavailable" | "no-csrf" | "not-owner" } }
const calls = window.directoryReplayCalls = [];
let uuidSequence = 0;
Object.defineProperty(window.crypto, "randomUUID", { configurable: true,
  value: () => `22222222-2222-4222-8222-${String(++uuidSequence).padStart(12, "0")}` });
let version = 4, profile = { name: "Synthetic Portal Acceptance 2026-10-08", email: "", phone: "", clientType: "unknown" as const,
  addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "" };
const seen = new Map<string, string>();
let lost = false;
let recoveryLost = false;
const recoverySeen = new Map<string, string>();
const request = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  const headers = new Headers(init.headers), body = typeof init.body === "string" ? init.body : null;
  calls.push({ path, method: init.method ?? "GET", key: headers.get("Idempotency-Key"), body,
    csrf: headers.get("X-CSRF-Token"), contentType: headers.get("Content-Type"), credentials: init.credentials });
  if (path === "/api/session") return { csrfToken: window.directoryReplayMode === "no-csrf" ? "" : "fixture-only-csrf",
    user: { id: window.directoryReplayMode === "not-owner" ? "staff-readonly" : "staff-beau-koltz", isAdministrator: true } } as T;
  if (path === "/api/admin/staging/directory/replay-destination-readback") return (window.directoryReplayMode === "readback-mismatch"
    ? { status: "mismatch", exactIdentity: true, exactVersion: false, exactGeneration: true, exactProfile: true }
    : window.directoryReplayMode === "readback-unavailable"
      ? { status: "unavailable", exactIdentity: false, exactVersion: false, exactGeneration: false, exactProfile: false }
      : { status: "verified", exactIdentity: true, exactVersion: true, exactGeneration: true, exactProfile: true }) as T;
  if (path === "/api/client-hub/directory/create-generation-recovery") {
    const parsed = JSON.parse(body!), key = headers.get("Idempotency-Key")!, prior = recoverySeen.get(key);
    if (prior && prior !== body) throw new ApiError("conflict", 409, { status: "conflict", reason: "authorization_id" });
    const replayed = Boolean(prior); recoverySeen.set(key, body!);
    if (window.directoryReplayMode === "lost-recovery" && !recoveryLost) { recoveryLost = true; throw new TypeError("response lost after recovery preparation"); }
    if (window.directoryReplayMode === "malformed-recovery") return { status: "prepared", successorCommandId: parsed.successorCommandId,
      generation: 42, replayed, unexpected: true } as T;
    return { status: "prepared", successorCommandId: parsed.successorCommandId, generation: "42", replayed } as T;
  }
  if (window.directoryReplayMode === "denied") throw new ApiError("denied", 403, {});
  if (!init.method) return { recordId: window.directoryReplayMode === "wrong-record" ? "00000000-0000-4000-8000-000000000000" : RETAINED_SYNTHETIC_CLIENT_ID,
    kind: "client", version, profile, scopes: [{ businessAreaId: "staging-native-only-portal-acceptance-20261008-window-1", divisionId: null }],
    linkage: "standalone", relationship: { version: 1, organization: null, organizations: [] },
    editing: window.directoryReplayMode === "pending" ? { available: false, reason: "relationship_delivery_pending" } : { available: true, reason: null } } as T;
  const parsed = JSON.parse(body!), key = headers.get("Idempotency-Key")!, prior = seen.get(key);
  if (prior && prior !== body) throw new ApiError("conflict", 409, { status: "conflict", reason: "idempotency_body_conflict" });
  const replayed = Boolean(prior); seen.set(key, body!);
  if (!replayed) { version += 1; profile = { ...profile, ...parsed.profile }; }
  if (!replayed && !lost && (window.directoryReplayMode === "lost-write" && version === 5
    || window.directoryReplayMode === "lost-restore" && version === 6)) { lost = true; throw new TypeError("response lost after commit"); }
  return { status: replayed ? "written" : "pending", recordId: RETAINED_SYNTHETIC_CLIENT_ID, kind: "client", version,
    replayed, destinations: [{ sourceId: window.directoryReplayMode === "wrong-source" ? "project-alpha:other" : "project-alpha:staging",
      state: replayed ? "acknowledged" : "pending" }] } as T;
};
// Exercise the actual same-origin api.ts transport, including session bootstrap
// and CSRF headers; only the HTTP server is replaced by this browser fixture.
window.fetch = async (input, init) => {
  try { return Response.json(await request(String(input), init)); }
  catch (caught) {
    if (caught instanceof ApiError) return Response.json({ error: caught.message, ...caught.payload }, { status: caught.status });
    throw caught;
  }
};
createRoot(document.getElementById("root")!).render(<DirectoryReplayAcceptance />);
