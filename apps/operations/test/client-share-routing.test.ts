import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { autoSelectedProject, backendForSource, nativeTargetsForRecipient, recipientDetail, recipientDetails, recipientKey, validClientShareProjects, validClientShareRecipient,
  validClientShareRecipientSearch, type ClientShareAudienceType, type ClientShareRecipient } from "../src/client/client-share-routing";

const primaryRow = (type: ClientShareAudienceType = "principal", publicId = "person-p"): ClientShareRecipient => ({
  key: recipientKey("primary", "project-alpha:primary", "workspace-p", type, publicId), backend: "primary", sourceId: "project-alpha:primary",
  divisionLabel: "Ledge Top Drone Services", workspaceId: "workspace-p", workspaceName: "Harbor workspace", audienceType: type, publicId,
  displayName: "Alex Harbor", email: type === "principal" ? "alex@example.test" : null, folderBindingId: "binding-a" });
const project = (n: number) => ({ projectId: `project-${n}`, projectName: `Project ${n}`, projectEndSupported: n % 2 === 0 });
const nativeRow = (publicId = "person-n", email: string | null = "alex.tech@example.test"): ClientShareRecipient => ({
  key: recipientKey("native", "project-alpha:secondary", "workspace-n", "principal", publicId), backend: "native", sourceId: "project-alpha:secondary",
  divisionLabel: "Ledge Top Technologies", workspaceId: "workspace-n", workspaceName: "Harbor technology", audienceType: "principal", publicId,
  displayName: "Alex Harbor", email });
const none = { principal: false, organization: false, department: false, client: false, connected: false };
const search = (recipients: unknown[], primary = "ready", native = "ready", truncated = none) => ({ recipients, primary, native, truncated });

describe("client share recipient routing", () => {
  it("routes every audience kind of the primary source to the primary back end and connected-workspace people to native", () => {
    for (const kind of ["principal", "department", "organization", "client"] as const) {
      const row = primaryRow(kind, `id-${kind}`);
      expect(validClientShareRecipient(row)).toBe(true);
      expect(backendForSource(row.sourceId)).toBe("primary");
      expect(nativeTargetsForRecipient(row, [project(1)])).toEqual([]);
    }
    // Project-wide audiences were never offered by the dialog and still are not.
    expect(validClientShareRecipient(primaryRow("project" as ClientShareAudienceType, "id-project"))).toBe(false);
    const person = nativeRow();
    expect(validClientShareRecipient(person)).toBe(true);
    expect(backendForSource(person.sourceId)).toBe("native");
    expect(nativeTargetsForRecipient(person, [project(1)])).toEqual([{ sourceId: "project-alpha:secondary", sourceName: "Ledge Top Technologies", workspaceId: "workspace-n",
      workspaceName: "Harbor technology", projectId: "project-1", projectName: "Project 1", projectEndSupported: false }]);
  });

  it("refuses rows whose stated back end disagrees with their source, so they cannot reach the other route", () => {
    const primaryAsNative = { ...primaryRow(), backend: "native", key: recipientKey("native", "project-alpha:primary", "workspace-p", "principal", "person-p"), folderBindingId: undefined };
    const nativeAsPrimary = { ...nativeRow(), backend: "primary", key: recipientKey("primary", "project-alpha:secondary", "workspace-n", "principal", "person-n"), folderBindingId: "binding-a" };
    const swappedSource = { ...nativeRow(), sourceId: "project-alpha:primary" };
    for (const row of [primaryAsNative, nativeAsPrimary, swappedSource]) expect(validClientShareRecipient(row)).toBe(false);
    expect(nativeTargetsForRecipient(swappedSource as ClientShareRecipient, [project(1)])).toEqual([]);
    expect(validClientShareRecipient({ ...nativeRow(), publicId: "someone-else" })).toBe(false);
    expect(validClientShareRecipient({ ...nativeRow(), audienceType: "organization", key: recipientKey("native", "project-alpha:secondary", "workspace-n", "organization", "person-n") })).toBe(false);
    // Projects are never trusted from the person search; they come from the per-person lookup.
    expect(validClientShareRecipient({ ...nativeRow(), projects: [project(1)] })).toBe(false);
    expect(validClientShareRecipient({ ...primaryRow(), folderBindingId: undefined })).toBe(false);
  });

  it("refuses a response with rows or counts from a back end that reported no access, or duplicate keys", () => {
    expect(validClientShareRecipientSearch(search([primaryRow(), nativeRow()]))).toBe(true);
    expect(validClientShareRecipientSearch(search([primaryRow()], "not_permitted"))).toBe(false);
    expect(validClientShareRecipientSearch(search([nativeRow()], "ready", "unavailable"))).toBe(false);
    expect(validClientShareRecipientSearch(search([nativeRow(), nativeRow()]))).toBe(false);
    expect(validClientShareRecipientSearch(search([], "link_required", "not_permitted"))).toBe(true);
    expect(validClientShareRecipientSearch(search([nativeRow()], "failed", "ready"))).toBe(true);
    expect(validClientShareRecipientSearch(search([], "ready", "not_permitted", { ...none, connected: true }))).toBe(false);
    expect(validClientShareRecipientSearch(search([], "not_permitted", "ready", { ...none, principal: true }))).toBe(false);
    expect(validClientShareRecipientSearch({ ...search([]), truncated: true })).toBe(false);
    expect(validClientShareRecipientSearch({ ...search([]), primary: "maybe" })).toBe(false);
  });

  it("chooses a project automatically only for a bound folder or a complete set of exactly one", () => {
    expect(autoSelectedProject({ projects: [project(4)], bound: false, complete: true })).toEqual({ project: project(4), reason: "only" });
    expect(autoSelectedProject({ projects: [project(4)], bound: true, complete: true })).toEqual({ project: project(4), reason: "bound" });
    // A truncated or name-filtered list never auto-selects, even with one row.
    expect(autoSelectedProject({ projects: [project(4)], bound: false, complete: false })).toBeNull();
    expect(autoSelectedProject({ projects: [project(1), project(2)], bound: false, complete: true })).toBeNull();
    expect(validClientShareProjects({ projects: [project(1), project(2)], bound: true, complete: true })).toBe(false);
    expect(validClientShareProjects({ projects: [project(1), project(1)], bound: false, complete: true })).toBe(false);
    expect(validClientShareProjects({ projects: [project(1)], bound: false, complete: false })).toBe(true);
  });

  it("keeps same-named clients distinguishable, including people without an email", () => {
    expect(recipientDetail(primaryRow())).toBe("Harbor workspace · alex@example.test");
    expect(recipientDetail(nativeRow())).toBe("Harbor technology · alex.tech@example.test");
    const first = recipientDetail(nativeRow("person-aaa111", null)), second = recipientDetail(nativeRow("person-bbb222", null));
    expect(first).not.toBe(second); expect(first).toContain("ref aaa111");
    expect(recipientDetail(primaryRow("organization", "org-123456"))).toBe("Harbor workspace · organization · current members · ref 123456");
  });

  it("never names a business or division, and tells apart rows that would otherwise read the same", () => {
    const both = { ...nativeRow("person-n-777777", "alex@example.test"), workspaceName: "Harbor workspace" };
    const other = { ...nativeRow("person-q"), displayName: "Blair Quay", email: "blair@example.test" };
    const details = recipientDetails([primaryRow("principal", "person-p-111111"), both, other]);
    for (const value of details.values()) expect(value).not.toMatch(/Drone Services|Technologies|Ledge Top/);
    const one = details.get(primaryRow("principal", "person-p-111111").key)!, two = details.get(both.key)!;
    expect(one).not.toBe(two);
    expect(one).toBe("Harbor workspace · alex@example.test · ref 111111");
    expect(two).toBe("Harbor workspace · alex@example.test · ref 777777");
    // A row with no look-alike keeps its plain detail.
    expect(details.get(other.key)).toBe("Harbor technology · blair@example.test");
  });
});

const app = readFileSync(new URL("../src/client/OperationsApp.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const native = readFileSync(new URL("../src/client/NativeDeliveryGrantPanel.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const picker = readFileSync(new URL("../src/client/ClientSharePicker.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
describe("combined client share dialog source", () => {
  it("has no portal choice and no unused workspace grant path", () => {
    expect(app).not.toContain("Portal connection");
    expect(app).not.toContain("function ClientWorkspaceGrant(");
    expect(app).not.toContain("type WorkspaceGrantTarget");
    expect(app).toContain("<ClientSharePicker folderId={folder.id}");
  });
  it("routes the chosen recipient by source and keeps both back ends' own panels and histories", () => {
    expect(app).toContain('const backend = recipient ? backendForSource(recipient.sourceId) : null;');
    expect(app).toContain('unified preselected={backend === "primary" ? recipient : null} historyTarget={historyNode}');
    expect(app).toContain('otherBackendSelected={backend === "native"}');
    expect(app).toContain('unified preselected={backend === "native" ? recipient : null} historyTarget={historyNode}');
    expect(app).toContain('aria-label="Client access for this folder"');
    expect(app).toContain("No client access is recorded for this folder.");
    expect(app).toContain("Restore as new version");
    expect(native).toContain('"Cancel unpublished access"');
    expect(native).toContain("/api/delivery/client-share-recipients/projects?");
  });
  it("names no business or division anywhere in the Client Workspace tab", () => {
    const start = app.indexOf("function AuthenticatedDeliveryGrantPanel("), end = app.indexOf("function ShareDialog(");
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const tab = app.slice(start, end);
    for (const source of [tab, native, picker]) {
      expect(source).not.toMatch(/Drone Services|Ledge Top Technologies|projectAlphaSourceName\(|primaryName/);
      expect(source).not.toMatch(/\.sourceName\}|\["Source",|\.divisionLabel\}/);
    }
    expect(picker).toContain("recipientDetails(options)");
  });
  it("filters as the user types against the combined endpoint and carries the id-based key", () => {
    expect(picker).toContain("/api/delivery/client-share-recipients?");
    expect(picker).toContain("window.setTimeout(");
    expect(picker).toContain("key={option.key} aria-selected={selected?.key === option.key}");
    expect(picker).toContain("validClientShareRecipientSearch(result)");
  });
});
