import { createRoot } from "react-dom/client";
import { NativeDirectoryBindingRefresh } from "../../src/client/NativeDirectoryBindingRefresh";
import { setCsrf } from "../../src/client/api";

type FixtureWindow = Window & { bindingScenario?: string; bindingCalls?: Array<{ path: string; body: unknown }>;
  unmountBinding?: () => void };
const state = window as FixtureWindow, scenario = state.bindingScenario ?? "acknowledged";
const commandId = "11111111-1111-4111-8111-111111111111";
const successorId="22222222-2222-4222-8222-222222222222";
let executions = 0;
state.bindingCalls = [];
setCsrf("fixture-csrf");
window.fetch = async (input, init) => {
  const path = String(input), body = JSON.parse(String(init?.body));
  state.bindingCalls!.push({ path, body });
  if(path.endsWith('/recovery-review')){
    executions++;if(scenario==='recovery-lost'&&executions===1)throw new TypeError('lost recovery response');
    return Response.json({commandId:successorId,supersededCommandId:commandId,capturedAttempts:2,recordId:'client-one',sourceId:'project-alpha:primary',localVersion:3,priorRevision:'7',liveRevision:'8'});
  }
  if(path.endsWith('/recovery-execute'))return Response.json({commandId:successorId,status:'acknowledged',revision:'8'});
  if (path.endsWith("/review")) return Response.json({ commandId, recordId: scenario === "bad-review" ? "wrong-record" : "client-one",
    sourceId: "project-alpha:primary", localVersion: 3, priorRevision: "7", liveRevision: "8",
    ...(scenario==='recovery-candidate'||scenario==='recovery-lost'?{recoveryCandidate:true,capturedAttempts:2}:{}),
    ...(scenario==='recovery-reserved-reload'?{commandId:successorId,supersededCommandId:commandId,capturedAttempts:2}:{}) });
  executions++;
  if (scenario === "network" && executions === 1) throw new TypeError("lost response");
  if (scenario === "uncertain" && executions === 1) return Response.json({ commandId, status: "uncertain" });
  if ((scenario === "preflight-fresh" || scenario === "preflight-prior") && executions === 1) return Response.json({ commandId,
    status: scenario === "preflight-prior" ? "uncertain" : "blocked", reason: "refresh_capability_unavailable", frozenCommandRetained: true, latestAttemptSent: false });
  if (scenario === "wrong-command" && executions === 1) return Response.json({ commandId: "22222222-2222-4222-8222-222222222222", status: "acknowledged", revision: "8" });
  if (scenario === "wrong-revision" && executions === 1) return Response.json({ commandId, status: "acknowledged", revision: "9" });
  if (scenario === "blocked" || scenario === "conflict") return Response.json({ commandId, status: scenario });
  return Response.json({ commandId, status: "acknowledged", revision: "8" });
};
const root = createRoot(document.getElementById("root")!);
state.unmountBinding = () => root.unmount();
root.render(<NativeDirectoryBindingRefresh enabled={scenario !== "disabled"} recoveryEnabled={scenario.startsWith('recovery-')} recordId="client-one" sourceId="project-alpha:primary" />);
