import { createRoot } from "react-dom/client";
import { SharedDirectoryProfileEdit } from "../../src/client/SharedDirectoryProfileEdit";
import "../../../../packages/ui/src/styles.css";
import "../../src/client/styles.css";
export type Scenario = "pending" | "bulk" | "clean" | "unavailable" | "old-route" | "malformed" | "nonowner" | "lost-response" | "resume" | "pending-response" | "wrong-ack" | "incomplete-ack";
export type Call = { path: string; method: string; operationId: string | null; body: string | null };
const w = window as Window & { recoveryScenario?: Scenario; recoveryCalls?: Call[] };
const scenario = w.recoveryScenario ?? "pending", calls: Call[] = []; w.recoveryCalls = calls;
let writes = 0, sequence = 0;
export const ACTIVE = "22222222-2222-4222-8222-222222222222";
Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: () => `11111111-1111-4111-8111-${String(++sequence).padStart(12,"0")}` });
window.fetch = async (input, init) => {
  const path = String(input), method = init?.method ?? "GET", body = typeof init?.body === "string" ? init.body : null;
  calls.push({ path, method, operationId: new Headers(init?.headers).get("Idempotency-Key"), body });
  if (path === "/api/client-hub/shared-profiles/records/synthetic-record") return Response.json({canMerge:scenario !== "nonowner",sharedProfile:{
    id:"synthetic-shared",kind:"organization",version:1,profile:{name:"Synthetic organization",generalEmail:"synthetic@example.test",generalPhone:"",addressLine1:"",addressLine2:"",city:"",state:"",postalCode:"",country:""},
    members:[{recordId:"synthetic-record",version:1,sourceIds:["project-alpha:primary"]}],delivery:{state:"acknowledged"},editing:{available:false}}});
  if (path === "/api/client-hub/shared-profiles/authority-recovery" && method === "GET") {
    if (scenario === "old-route") return Response.json({error:"Not found"},{status:404});
    return Response.json({available:scenario !== "unavailable",pendingHeads:scenario === "malformed" ? -1 : ["clean","bulk"].includes(scenario) ? 0 : 2,
      bulkPending:scenario === "bulk",activeRecovery:scenario === "resume" ? {operationId:ACTIVE,state:"pending"} : null});
  }
  if (path === "/api/client-hub/shared-profiles/authority-recovery" && method === "POST") {
    ++writes;
    if (scenario === "lost-response" && writes === 1) return Response.json({error:"Synthetic response lost"},{status:503});
    return Response.json({ok:true,operationId:scenario === "wrong-ack" && writes === 1 ? ACTIVE : JSON.parse(body!).operationId,
      state:scenario === "pending-response" && writes === 1 ? "pending" : "completed",pendingHeads:["pending-response","incomplete-ack"].includes(scenario) && writes === 1 ? 2 : 0});
  }
  return Response.json({error:"Unexpected fixture request"},{status:404});
};
createRoot(document.getElementById("root")!).render(<SharedDirectoryProfileEdit kind="organization" recordId="synthetic-record" />);
