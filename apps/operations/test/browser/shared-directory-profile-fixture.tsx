import { createRoot } from "react-dom/client";
import { SharedDirectoryProfileEdit } from "../../src/client/SharedDirectoryProfileEdit";
import "../../../../packages/ui/src/styles.css";
import "../../src/client/styles.css";

export type Scenario = "update-lost-response" | "update-reload-failure" | "pending" | "conflict" | "readonly" | "protected"
  | "stale" | "merge" | "merge-denied" | "merge-differences" | "merge-lost-response" | "merge-malformed"
  | "owner-positive" | "owner-lost-response" | "bootstrap-positive" | "bootstrap-lost-response"
  | "owner-alias" | "owner-half-pair" | "owner-suspended";
export type Call = { path: string; method: string; mutationId: string | null; body: string | null };
const fixtureWindow = window as Window & { sharedProfileScenario?: Scenario; sharedProfileCalls?: Call[] };
const scenario = fixtureWindow.sharedProfileScenario ?? "pending", calls: Call[] = [];
const aliasScenario = scenario === "owner-alias" || scenario === "owner-half-pair" || scenario === "owner-suspended";
fixtureWindow.sharedProfileCalls = calls;
let sequence = 0, updates = 0, confirms = 0, postUpdateReads = 0, merged = false,ownerWrites=0,bootstrapWrites=0,ownerEnabled=false,bootstrapped=false;
Object.defineProperty(window.crypto, "randomUUID", { configurable: true,
  value: () => `11111111-1111-4111-8111-${String(++sequence).padStart(12, "0")}` });
const members = [
  { recordId: "record-one", version: 4, sourceIds: ["project-alpha:primary"] },
  { recordId: "record-two", version: 7, sourceIds: ["project-alpha:secondary"] },
];
const profile = { name: "Synthetic Shared Organization", generalEmail: "shared@example.test", generalPhone: "555-0100",
  addressLine1: "100 Test Way", addressLine2: "", city: "Example City", state: "WI", postalCode: "00000", country: "US" };
const isClient=scenario.startsWith('owner-')||scenario.startsWith('bootstrap-');
const clientProfile={name:'Synthetic Shared Client',email:'client@example.test',phone:'555-0100',addressLine1:'100 Test Way',addressLine2:'',city:'Example City',state:'WI',postalCode:'00000',country:'US'};
let updatedProfile:Record<string,string> = isClient?clientProfile:profile;
const isMerge = scenario.startsWith("merge");
window.fetch = async (input, init) => {
  const path = String(input), method = init?.method ?? "GET", body = typeof init?.body === "string" ? init.body : null;
  calls.push({ path, method, mutationId: new Headers(init?.headers).get("Idempotency-Key"), body });
  if (path === "/api/client-hub/shared-profiles/records/record-one") {
    if (scenario === "protected") return Response.json({ error: "Profile access denied" }, { status: 403 });
    if (updates && scenario === "update-reload-failure" && ++postUpdateReads === 1)
      return Response.json({ error: "Read unavailable after commit" }, { status: 503 });
    if (isMerge && !merged) return Response.json({ sharedProfile: null, canMerge: true });
    if(scenario.startsWith('bootstrap-')&&!bootstrapped)return Response.json({sharedProfile:null,canMerge:false,canBootstrap:true});
    return Response.json({ sharedProfile: { id: "shared-one", kind: isClient?'client':"organization", version: scenario === "stale" ? 0 : updates ? 3 : 2,
      profile: updatedProfile, members:isClient?[aliasScenario?{...members[0],sourceIds:['project-alpha:staging']}:members[0]]:members, delivery: { state: scenario === "conflict" ? "conflict" : scenario === "pending" || updates ? "pending" : "acknowledged" },
      ...(isClient?{portalSetup:{available:true,candidates:[{workspaceId:'workspace-one',sourceId:aliasScenario?'project-alpha:staging':'project-alpha:primary',
        ...(scenario==='owner-alias'||scenario==='owner-suspended'?{portalSourceId:'project-alpha:primary',correspondenceRevisionId:'11111111-2222-4333-8444-555555555555'}:{}),
        ...(scenario==='owner-half-pair'?{portalSourceId:'project-alpha:primary'}:{}),
        principalPublicId:'principal-one',targetPublicId:'target-one',recordId:'record-one',groupId:'shared-one',clientName:'Synthetic Shared Client',
        ...(scenario==='owner-suspended'?{state:'suspended',currentGrantId:'grant-one',currentGrantRevision:2}:{state:ownerEnabled?'enabled':'available'})}]}}:{}),
      editing: { available: scenario !== "readonly", reason: scenario === "readonly" ? "permission_required" : null } } });
  }
  if (path.startsWith("/api/client-hub/shared-profiles/candidates?"))
    return Response.json({ candidates: [{ ...members[1], kind: "organization", name: "Synthetic Other Organization" }] });
  if (path === "/api/client-hub/shared-profiles/preview" && method === "POST")
    return Response.json({ previewToken: "synthetic-reviewed-token", kind: "organization", profile: scenario === "merge-malformed" ? null : profile,
      members, expiresAt: new Date(Date.now() + 600_000).toISOString(), differences: scenario === "merge-differences" ? ["generalEmail"] : [],
      canConfirm: scenario !== "merge-denied" });
  if (path === "/api/client-hub/shared-profiles/confirm" && method === "POST") {
    confirms += 1; merged = true;
    if (scenario === "merge-lost-response" && confirms === 1) return Response.json({ error: "Merge response lost after commit" }, { status: 503 });
    return Response.json({ status: "acknowledged" });
  }
  if (path === "/api/client-hub/shared-profiles/shared-one" && method === "PATCH") {
    updates += 1; updatedProfile = JSON.parse(body!).profile;
    if (scenario === "update-lost-response" && updates === 1) return Response.json({ error: "Update response lost after commit" }, { status: 503 });
    return Response.json({ status: "pending" });
  }
  if(path==='/api/client-hub/shared-profiles/bootstrap'&&method==='POST'){
    bootstrapWrites+=1;bootstrapped=true;
    if(scenario==='bootstrap-lost-response'&&bootstrapWrites===1)return Response.json({error:'Setup response lost after commit'},{status:503});
    return Response.json({replayed:bootstrapWrites>1});
  }
  if(path==='/api/client-hub/shared-profiles/portal-grants'&&method==='POST'){
    ownerWrites+=1;ownerEnabled=true;
    if(scenario==='owner-lost-response'&&ownerWrites===1)return Response.json({error:'Portal permission response lost after commit'},{status:503});
    return Response.json({ok:true,revision:1});
  }
  if(path==='/api/client-hub/directory/standalone-clients/record-one'&&method==='GET')return Response.json({recordId:'record-one',kind:'client',version:4,
    profile:{...clientProfile,clientType:'business'},scopes:[{businessAreaId:'area-one',divisionId:null}],linkage:'standalone',
    relationship:{version:1,organization:null,organizations:[],editing:{available:false,reason:'permission_required'}},editing:{available:true,reason:null}});
  if (path === "/api/client-hub/directory/organizations/record-one" && method === "GET")
    return Response.json({ recordId: "record-one", kind: "organization", version: 4, profile,
      scopes: [{ businessAreaId: "area-one", divisionId: null }], editing: { available: true, reason: null } });
  return Response.json({ error: "Unexpected fixture request" }, { status: 404 });
};
createRoot(document.getElementById("root")!).render(<SharedDirectoryProfileEdit kind={isClient?'client':"organization"} recordId="record-one" />);
