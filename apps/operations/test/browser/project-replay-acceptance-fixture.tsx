import { createRoot } from "react-dom/client";
import { ProjectReplayAcceptance, PROJECT_COMMANDS_PATH, PROJECT_PREPARATION_PATH } from "../../src/client/ProjectReplayAcceptance";
type Call = { path: string; method: string; key: string | null; body: string | null; csrf: string | null;
  contentType: string | null; credentials: RequestCredentials | undefined };
declare global { interface Window { projectAcceptanceCalls?: Call[]; projectAcceptanceMode?: "normal" | "lost-create" | "stale-readback" | "form" | "wrong-scopes" | "non-admin" | "missing-csrf" | "wrong-directory" | "wrong-local" } }
const calls = window.projectAcceptanceCalls = [], externalId = "synthetic-project-20261008", app = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let uuid = 0, version = 0, lost = false;
Object.defineProperty(window.crypto, "randomUUID", { configurable: true,
  value: () => `33333333-3333-4333-8333-${String(++uuid).padStart(12, "0")}` });
const base = { sourceId: "project-alpha:staging", expectedApplicationId: app,
  scopes: [{ scopeKind: "business_area", businessAreaId: "staging-native-only-portal-acceptance-20261008-window-1", divisionId: null }] };
const project={name:"Synthetic Project Acceptance",description:null,estimatedStart:null,estimatedEnd:null};
let currentProject=project;
const preparation = (stage: "create" | "update", selector: Record<string,unknown>) => { const selectedExternal=String(selector.externalProjectId),
  selectedScopes=selector.scopes as typeof base.scopes; return ({status:"prepared",preparation:stage === "create" ? { operation:stage,...base,
  scopes:selectedScopes,externalProjectId:selectedExternal,
  expectedAuthorizationGeneration:"1",local:{expectedLocalVersion:0,expectedLocalProjectionSha256:null},
  directory:{organizationRecordId:selector.organizationRecordId,clientRecordId:selector.clientRecordId??null},organization:{externalId:String(selector.organizationRecordId),expectedPublicId:"a".repeat(32),expectedRevision:"1",expectedProjectionSha256:"b".repeat(64)},client:null}
  :{operation:stage,...base,scopes:selectedScopes,externalProjectId:selectedExternal,expectedAuthorizationGeneration:"2",expectedPublicId:"d".repeat(32),
    expectedRevision:String(version),expectedProjectionSha256:"c".repeat(64),project:currentProject,
    local:{expectedLocalVersion:window.projectAcceptanceMode==="stale-readback"?0:version,expectedLocalProjectionSha256:"c".repeat(64)}}}); };
const seen = new Map<string, string>();
window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const path=String(input);
  const body = typeof init.body === "string" ? init.body : null, key = new Headers(init.headers).get("Idempotency-Key");
  const headers=new Headers(init.headers);
  calls.push({ path, method: init.method ?? "GET", key, body, csrf:headers.get("X-CSRF-Token"),
    contentType:headers.get("Content-Type"),credentials:init.credentials });
  if (path === "/api/session") return Response.json({ csrfToken: window.projectAcceptanceMode==="missing-csrf"?"":"fixture-csrf-token-value",
    user: { id:"protected-owner",isAdministrator: window.projectAcceptanceMode!=="non-admin" } });
  if (path === PROJECT_PREPARATION_PATH) { const selector=JSON.parse(body!),value=preparation(selector.operation,selector);
    if(window.projectAcceptanceMode==="wrong-scopes") value.preparation.scopes=[{scopeKind:"business_area",businessAreaId:"other",divisionId:null}];
    if(window.projectAcceptanceMode==="wrong-directory"&&selector.operation==="create")value.preparation.directory.organizationRecordId="another-organization";
    if(window.projectAcceptanceMode==="wrong-local"&&selector.operation==="create")value.preparation.local={expectedLocalVersion:1,expectedLocalProjectionSha256:"c".repeat(64)};
    return Response.json(value); }
  if (path !== PROJECT_COMMANDS_PATH) throw new Error("unexpected path");
  const parsed = JSON.parse(body!), prior = seen.get(key!);
  if (prior && prior !== body) return Response.json({ sourceId: base.sourceId, expectedApplicationId: app, stage: "plan",
    outcome: { status: "conflict", reason: "command_id" } });
  const replayed = Boolean(prior); seen.set(key!, body!);
  if (!replayed) { version += 1; currentProject=parsed.command.project; }
  const result = { sourceId: base.sourceId, expectedApplicationId: app, stage: "activate",
    outcome: { status: "activated", commandId: parsed.command.commandId, externalProjectId: externalId, version, replayed } };
  if (!replayed && !lost && window.projectAcceptanceMode === "lost-create" && parsed.operation === "create") {
    lost = true; throw new TypeError("response lost after commit");
  }
  return Response.json(result);
};
const useForm=["form","wrong-scopes","non-admin","missing-csrf"].includes(window.projectAcceptanceMode??"");
createRoot(document.getElementById("root")!).render(<ProjectReplayAcceptance
  {...(useForm?{}:{selection:{sourceId:"project-alpha:staging" as const,expectedApplicationId:app,externalProjectId:externalId,organizationRecordId:"organization-one",clientRecordId:null,project,scopes:base.scopes}})}
  location={{ protocol: "https:", hostname: "ops-staging.ledgetopdroneservices.com", port: "",
    pathname: "/administration/staging/project-v2-replay-acceptance" } as Location} />);
