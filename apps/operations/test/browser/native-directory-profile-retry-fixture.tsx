import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NativeDirectoryProfileCreate, NativeDirectoryProfileEdit } from "../../src/client/NativeDirectoryProfileEditor";

type Scenario = "create-lost-response" | "admission-400" | "write-400" | "record-switch" | "reload-failure";
type Call = { path: string; method: string; mutationId: string | null; body: string | null };
const fixtureWindow = window as Window & { nativeDirectoryScenario?: Scenario; nativeDirectoryCalls?: Call[] };
const scenario = fixtureWindow.nativeDirectoryScenario ?? "create-lost-response", calls: Call[] = [];
fixtureWindow.nativeDirectoryCalls = calls;
let uuidSequence = 0;
Object.defineProperty(window.crypto, "randomUUID", { configurable: true,
  value: () => `11111111-1111-4111-8111-${String(++uuidSequence).padStart(12, "0")}` });

const sourceId = "project-alpha:primary";
let createAdmissionCalls = 0, createWriteCalls = 0, profileWriteCalls = 0, recordOneReads = 0;

function snapshot(recordId: string, version = 1) {
  return { recordId, kind: "organization", version,
    profile: { name: recordId === "record-one" ? "Record One" : "Record Two", generalEmail: "", generalPhone: "",
      addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "" },
    scopes: [{ businessAreaId: "area:one", divisionId: null }], editing: { available: true, reason: null } };
}

window.fetch = async (input, init) => {
  const path = String(input), method = init?.method ?? "GET", body = typeof init?.body === "string" ? init.body : null;
  const mutationId = new Headers(init?.headers).get("Idempotency-Key");
  calls.push({ path, method, mutationId, body });
  if (path.includes("/create-options")) return Response.json({ kind: "organization",
    sources: [{ id: sourceId, name: "Primary" }], scopes: [{ id: "area:one", name: "Area One", divisions: [] }], organizations: [] });
  if (path.endsWith("/create-admissions")) {
    createAdmissionCalls += 1;
    if (scenario === "admission-400" && createAdmissionCalls === 1)
      return new Response(JSON.stringify({ error: "Invalid create admission" }), { status: 400 });
    return Response.json({ status: "prepared" });
  }
  if (path.endsWith("/organizations") && method === "POST") {
    createWriteCalls += 1;
    if (scenario === "create-lost-response" && createWriteCalls === 1)
      return new Response(JSON.stringify({ error: "Response lost after commit" }), { status: 503 });
    if (scenario === "write-400" && createWriteCalls === 1)
      return new Response(JSON.stringify({ error: "Write response could not be accepted" }), { status: 400 });
    const parsed = JSON.parse(body!);
    return Response.json({ status: "pending", recordId: parsed.mutationId, kind: "organization", version: 1, replayed: true,
      destinations: [{ sourceId, state: "pending" }] });
  }
  const match = path.match(/\/organizations\/(record-(?:one|two))$/);
  if (match && method === "GET") {
    const recordId = match[1]!;
    if (recordId === "record-one") recordOneReads += 1;
    if (scenario === "reload-failure" && recordId === "record-one" && recordOneReads > 1)
      return new Response(JSON.stringify({ error: "Reload failed" }), { status: 503 });
    return Response.json(snapshot(recordId));
  }
  if (match && method === "PATCH") {
    profileWriteCalls += 1;
    const parsed = JSON.parse(body!);
    if (scenario === "record-switch" && profileWriteCalls === 1)
      return new Response(JSON.stringify({ error: "Response lost after commit" }), { status: 503 });
    return Response.json({ status: "pending", recordId: match[1], kind: "organization",
      version: parsed.expectedLocalVersion + 1, replayed: false, destinations: [{ sourceId, state: "pending" }] });
  }
  return new Response(JSON.stringify({ error: `Unsupported fixture request: ${method} ${path}` }), { status: 404 });
};

function Fixture() {
  const [recordId, setRecordId] = useState("record-one");
  if (["create-lost-response", "admission-400", "write-400"].includes(scenario)) return <NativeDirectoryProfileCreate />;
  return <><button type="button" onClick={() => setRecordId("record-two")}>Switch to record two</button>
    <NativeDirectoryProfileEdit kind="organization" recordId={recordId} /></>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
