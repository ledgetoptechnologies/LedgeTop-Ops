import { createRoot } from "react-dom/client";
import { ClientHub } from "../../src/client/ClientHub";
import { setCsrf } from "../../src/client/api";

const state = window as Window & { bindingCalls: Array<{ path: string; body: unknown }>;
  bindingFlag?: boolean; replaceLinkedClients: () => void; changeHubContext: () => void };
const sourceId = "project-alpha:secondary";
let linkedClients = [{ recordId: "local-child-one", name: "Linked child one" }, { recordId: "local-child-two", name: "Linked child two" }];
const commandId = "11111111-1111-4111-8111-111111111111";
state.bindingCalls = [];
setCsrf("fixture-csrf");
window.fetch = async (input, init) => {
  const path = String(input);
  if (path.includes("/binding-revisions/")) {
    const body = JSON.parse(String(init?.body));
    state.bindingCalls.push({ path, body });
    return Response.json(path.endsWith("/review")
      ? { ...body, commandId, localVersion: 3, priorRevision: "7", liveRevision: "8" }
      : { commandId, status: "acknowledged", revision: "8" });
  }
  if (/\/business\/organizations\//.test(path)) return Response.json({
    client: { public_id: "remote-org", kind: "organization", route_kind: "organizations", root_namespace: "business",
      source_id: sourceId, display_name: "Organization", detail_path: location.pathname, portal_status: "not_provisioned" },
    contacts: [], accounts: [], projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [],
    capabilities: { directory: true, requests: false, delivery: false, viewer: false }, contextVersion: "context-one",
    nativeDirectoryLinkedClients: linkedClients,
  });
  return Response.json({ error: "Unavailable in fixture" }, { status: 404 });
};
const root = createRoot(document.getElementById("root")!);
const render = (key = "initial") => root.render(<ClientHub key={key} mapToken={null} permissions={["team.view", "operations.manage"]}
  nativeDirectoryProfileWrites nativeDirectoryBindingRefresh={state.bindingFlag !== false} />);
state.replaceLinkedClients = () => { linkedClients = []; render("removed"); };
state.changeHubContext = () => render("changed-context");
render();
