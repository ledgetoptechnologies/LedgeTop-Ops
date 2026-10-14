import { createRoot } from "react-dom/client";
import { ClientHub } from "../../src/client/ClientHub";

type Call = { path: string; method: string; body?: unknown };
type FixtureWindow = Window & { enrollmentFlag?: boolean; enrollmentHubCalls?: Call[]; changeEnrollmentContext?: () => void };
const state = window as FixtureWindow, sourceId = "project-alpha:primary";
state.enrollmentHubCalls = [];
const linkedClients = [{ recordId: "local-child-one", name: "Linked child one" },
  { recordId: "local-child-two", name: "Linked child two" }];
window.fetch = async (input, init = {}) => {
  const path = String(input), method = init.method ?? "GET";
  if (path.includes("/reviewed-import-enrollment/")) {
    state.enrollmentHubCalls!.push({ path, method, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path.endsWith("/session")) return Response.json({ csrfToken: `123.${"a".repeat(64)}`, verifiedUntil: "2099-01-01T00:00:00.000Z" });
    if (path.endsWith("/review")) {
      const recordId = decodeURIComponent(path.split("/").at(-2)!);
      return Response.json({ review: { recordId, kind: path.includes("/organizations/") ? "organization" : "client",
        recordVersion: 7, enrollmentVersion: 3, sources: [{ sourceId, enrolled: false },
          { sourceId: "project-alpha:secondary", enrolled: false }] } });
    }
    const body = JSON.parse(String(init.body));
    return Response.json({ outcome: { status: "written", replayed: false,
      recordId: decodeURIComponent(path.split("/").at(-1)!), enrollmentVersion: 4, sourceIds: body.sourceIds } });
  }
  if (/\/business\/organizations\//.test(path)) return Response.json({
    client: { public_id: "remote-parent", kind: "organization", route_kind: "organizations", root_namespace: "business",
      source_id: sourceId, display_name: "Imported organization", detail_path: location.pathname, portal_status: "not_provisioned" },
    contacts: [], accounts: [], projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [],
    capabilities: { directory: true, requests: false, delivery: false, viewer: false }, contextVersion: "context-one",
    nativeDirectoryProfile: { recordId: "local-parent", kind: "organization" }, nativeDirectoryLinkedClients: linkedClients,
  });
  return Response.json({ error: "Unavailable in fixture" }, { status: 404 });
};
const root = createRoot(document.getElementById("root")!);
const render = (key = "initial") => root.render(<ClientHub key={key} mapToken={null}
  permissions={["team.view", "operations.manage"]} nativeDirectoryProfileWrites={false}
  reviewedImportEnrollment={state.enrollmentFlag !== false} />);
state.changeEnrollmentContext = () => render("changed-context");
render();
