import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NativeDirectoryProfileCreate, NativeDirectoryProfileEdit } from "../../src/client/NativeDirectoryProfileEditor";
import { DirectoryRelationshipRecoveryReview } from "../../src/client/DirectoryRelationshipRecoveryReview";

type Scenario = "create-lost-response" | "admission-400" | "write-400" | "record-switch" | "reload-failure" | "relationship-readonly"
  | "recovery-review" | "recovery-absent" | "recovery-malformed" | "recovery-reentry" | "recovery-invalidated"
  | "recovery-revoked" | "recovery-org-switch" | "recovery-record-switch";
type Call = { path: string; method: string; mutationId: string | null; body: string | null };
const fixtureWindow = window as Window & { nativeDirectoryScenario?: Scenario; nativeDirectoryCalls?: Call[] };
const scenario = fixtureWindow.nativeDirectoryScenario ?? "create-lost-response", calls: Call[] = [];
fixtureWindow.nativeDirectoryCalls = calls;
let uuidSequence = 0;
Object.defineProperty(window.crypto, "randomUUID", { configurable: true,
  value: () => `11111111-1111-4111-8111-${String(++uuidSequence).padStart(12, "0")}` });

const sourceId = "project-alpha:primary";
let createAdmissionCalls = 0, createWriteCalls = 0, profileWriteCalls = 0, recordOneReads = 0;
let recoveryAuthorizationCalls = 0, recoveryStatusCalls = 0;

function snapshot(recordId: string, version = 1) {
  return { recordId, kind: "organization", version,
    profile: { name: recordId === "record-one" ? "Record One" : "Record Two", generalEmail: "", generalPhone: "",
      addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "" },
    scopes: [{ businessAreaId: "area:one", divisionId: null }], editing: { available: true, reason: null } };
}

function readonlyClientSnapshot() {
  return { recordId: "client-one", kind: "client", version: 1,
    profile: { name: "Client One", email: "", phone: "", clientType: "business",
      addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "" },
    scopes: [{ businessAreaId: "area:one", divisionId: null }], linkage: "standalone",
    relationship: { version: 1, organization: null,
      organizations: [{ recordId: "organization-one", expectedVersion: 1, name: "Organization One" }],
      editing: { available: false, reason: "relationship_permission_required" } },
    editing: { available: true, reason: null } };
}

function recoveryClientSnapshot() {
  const recovery = scenario === "recovery-review" || scenario === "recovery-invalidated" || scenario === "recovery-revoked"
    ? { available: true, status: "needs_review", sourceIds: ["project-alpha:primary", "project-alpha:secondary"] }
    : scenario === "recovery-malformed"
      ? { available: true, status: "needs_review", sourceIds: ["project-alpha:primary"], leaked: "not-allowed" }
      : undefined;
  return { recordId: "client-recovery", kind: "client", version: 3,
    profile: { name: "Recovery Client", email: "", phone: "", clientType: "business",
      addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "" },
    scopes: [{ businessAreaId: "area:one", divisionId: null }], linkage: "linked",
    relationship: { version: 2, organization: { recordId: "organization-one", expectedVersion: 5, name: "Intended Organization" },
      organizations: [{ recordId: "organization-one", expectedVersion: 5, name: "Intended Organization" }],
      editing: { available: false, reason: "terminal_generation_conflict" }, ...(recovery ? { recovery } : {}) },
    editing: { available: false, reason: "terminal_generation_conflict" } };
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
  if (path.endsWith("/standalone-clients/client-one") && method === "GET")
    return Response.json(readonlyClientSnapshot());
  if (path.endsWith("/standalone-clients/client-recovery") && method === "GET")
    return Response.json(recoveryClientSnapshot());
  if (path.includes("/standalone-clients/client-recovery/relationship-generation-recovery/status") && method === "GET") {
    recoveryStatusCalls += 1;
    if (scenario === "recovery-reentry") return Response.json(recoveryStatusCalls === 1
      ? { status: "prepared", sourceId, updatedAt: "2026-10-10T00:00:00.000Z" }
      : { status: "acknowledged", sourceId, updatedAt: "2026-10-10T00:01:00.000Z" });
    if (scenario === "recovery-invalidated" && recoveryStatusCalls > 1)
      return Response.json({ status: "review_ready", review: { reviewId: "44444444-4444-4444-8444-444444444444",
        recordId: "client-recovery", sourceId, predecessorCommandId: "55555555-5555-4555-8555-555555555555",
        evidenceSha256: "b".repeat(64), clientRevision: "8", organizationRevision: "10", organizationRecordId: "organization-one",
        remoteParentPublicId: null, observedAuthorizationGeneration: "13", expiresAt: "2026-10-10T02:00:00.000Z" } });
    if (scenario === "recovery-revoked") return new Response(JSON.stringify({ status: "authority_revoked" }), { status: 403 });
    return Response.json({ status: "none" });
  }
  if (path.includes("/standalone-clients/client-prop/relationship-generation-recovery/status") && method === "GET") {
    recoveryStatusCalls += 1;
    if (recoveryStatusCalls === 1) return Response.json({ status: "review_ready", review: {
      reviewId: "66666666-6666-4666-8666-666666666666", recordId: "client-prop", sourceId,
      predecessorCommandId: "77777777-7777-4777-8777-777777777777", evidenceSha256: "c".repeat(64),
      clientRevision: "11", organizationRevision: "12", organizationRecordId: "organization-one",
      remoteParentPublicId: null, observedAuthorizationGeneration: "14", expiresAt: "2026-10-10T03:00:00.000Z" } });
    return Response.json({ status: "none" });
  }
  if (path.includes("/standalone-clients/client-prop-new/relationship-generation-recovery/status") && method === "GET")
    return Response.json({ status: "none" });
  if (path.endsWith("/standalone-clients/client-recovery/relationship-generation-recovery/reviews") && method === "POST") {
    const parsed = JSON.parse(body!);
    return Response.json({ status: "review", review: { reviewId: "22222222-2222-4222-8222-222222222222",
      recordId: "client-recovery", sourceId: parsed.sourceId, predecessorCommandId: "33333333-3333-4333-8333-333333333333",
      evidenceSha256: "a".repeat(64), clientRevision: "7", organizationRevision: "9", organizationRecordId: "organization-one",
      remoteParentPublicId: null, observedAuthorizationGeneration: "12", expiresAt: "2026-10-10T01:00:00.000Z" } });
  }
  if (path.includes("/standalone-clients/client-recovery/relationship-generation-recovery/reviews/") && path.endsWith("/authorize") && method === "POST") {
    recoveryAuthorizationCalls += 1;
    if (recoveryAuthorizationCalls === 1) return new Response(JSON.stringify({ error: "Synthetic reservation response loss" }), { status: 503 });
    const parsed = JSON.parse(body!);
    return Response.json({ status: "prepared", successorCommandId: parsed.successorCommandId, generation: "12", replayed: true });
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
  const [recoveryIdentity, setRecoveryIdentity] = useState({ recordId: "client-prop", organizationRecordId: "organization-one" });
  if (["create-lost-response", "admission-400", "write-400"].includes(scenario)) return <NativeDirectoryProfileCreate />;
  if (scenario === "relationship-readonly") return <NativeDirectoryProfileEdit kind="client" recordId="client-one" />;
  if (scenario === "recovery-org-switch" || scenario === "recovery-record-switch") return <>
    <button type="button" onClick={() => setRecoveryIdentity(scenario === "recovery-org-switch"
      ? { recordId: "client-prop", organizationRecordId: "organization-two" }
      : { recordId: "client-prop-new", organizationRecordId: "organization-one" })}>Switch recovery identity</button>
    <DirectoryRelationshipRecoveryReview recordId={recoveryIdentity.recordId} intendedOrganizationName="Current Organization"
      intendedOrganizationRecordId={recoveryIdentity.organizationRecordId}
      capability={{ available: true, status: "needs_review", sourceIds: [sourceId] }} /></>;
  if (["recovery-review", "recovery-absent", "recovery-malformed", "recovery-reentry", "recovery-invalidated", "recovery-revoked"].includes(scenario))
    return <NativeDirectoryProfileEdit kind="client" recordId="client-recovery" />;
  return <><button type="button" onClick={() => setRecordId("record-two")}>Switch to record two</button>
    <NativeDirectoryProfileEdit kind="organization" recordId={recordId} /></>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
