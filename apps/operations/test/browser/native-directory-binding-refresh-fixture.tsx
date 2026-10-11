import { createRoot } from "react-dom/client";
import { NativeDirectoryBindingRefresh } from "../../src/client/NativeDirectoryBindingRefresh";
import { setCsrf } from "../../src/client/api";

type FixtureWindow = Window & { bindingScenario?: string; bindingCalls?: Array<{ path: string; body: unknown }>;
  unmountBinding?: () => void };
const state = window as FixtureWindow, scenario = state.bindingScenario ?? "acknowledged";
const commandId = "11111111-1111-4111-8111-111111111111";
let executions = 0;
state.bindingCalls = [];
setCsrf("fixture-csrf");
window.fetch = async (input, init) => {
  const path = String(input), body = JSON.parse(String(init?.body));
  state.bindingCalls!.push({ path, body });
  if (path.endsWith("/review")) return Response.json({ commandId, recordId: scenario === "bad-review" ? "wrong-record" : "client-one",
    sourceId: "project-alpha:primary", localVersion: 3, priorRevision: "7", liveRevision: "8" });
  executions++;
  if (scenario === "network" && executions === 1) throw new TypeError("lost response");
  if (scenario === "uncertain" && executions === 1) return Response.json({ commandId, status: "uncertain" });
  if (scenario === "wrong-command" && executions === 1) return Response.json({ commandId: "22222222-2222-4222-8222-222222222222", status: "acknowledged", revision: "8" });
  if (scenario === "wrong-revision" && executions === 1) return Response.json({ commandId, status: "acknowledged", revision: "9" });
  if (scenario === "blocked" || scenario === "conflict") return Response.json({ commandId, status: scenario });
  return Response.json({ commandId, status: "acknowledged", revision: "8" });
};
const root = createRoot(document.getElementById("root")!);
state.unmountBinding = () => root.unmount();
root.render(<NativeDirectoryBindingRefresh enabled={scenario !== "disabled"} recordId="client-one" sourceId="project-alpha:primary" />);
