import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { autoSelectedProject, backendForSource, nativeTargetsForRecipient, recipientDetail, recipientKey, validClientShareRecipient,
  validClientShareRecipientSearch, type ClientShareAudienceType, type ClientShareRecipient } from "../src/client/client-share-routing";

const primaryRow = (type: ClientShareAudienceType = "principal", publicId = "person-p"): ClientShareRecipient => ({
  key: recipientKey("primary", "project-alpha:primary", "workspace-p", type, publicId), backend: "primary", sourceId: "project-alpha:primary",
  divisionLabel: "Ledge Top Drone Services", workspaceId: "workspace-p", workspaceName: "Harbor workspace", audienceType: type, publicId,
  displayName: "Alex Harbor", email: type === "principal" ? "alex@example.test" : null, folderBindingId: "binding-a" });
const project = (n: number) => ({ projectId: `project-${n}`, projectName: `Project ${n}`, projectEndSupported: n % 2 === 0 });
const nativeRow = (projects = [project(1)], publicId = "person-n"): ClientShareRecipient => ({
  key: recipientKey("native", "project-alpha:secondary", "workspace-n", "principal", publicId), backend: "native", sourceId: "project-alpha:secondary",
  divisionLabel: "Ledge Top Technologies", workspaceId: "workspace-n", workspaceName: "Harbor technology", audienceType: "principal", publicId,
  displayName: "Alex Harbor", email: "alex.tech@example.test", projects });
const search = (recipients: unknown[], primary = "ready", native = "ready") => ({ recipients, primary, native, truncated: false });

describe("client share recipient routing", () => {
  it("routes every audience kind of the primary source to the primary back end and connected-workspace people to native", () => {
    for (const kind of ["principal", "department", "organization", "client"] as const) {
      const row = primaryRow(kind, `id-${kind}`);
      expect(validClientShareRecipient(row)).toBe(true);
      expect(backendForSource(row.sourceId)).toBe("primary");
      expect(nativeTargetsForRecipient(row)).toEqual([]);
    }
    // Project-wide audiences were never offered by the dialog and still are not.
    expect(validClientShareRecipient(primaryRow("project", "id-project"))).toBe(false);
    const person = nativeRow();
    expect(validClientShareRecipient(person)).toBe(true);
    expect(backendForSource(person.sourceId)).toBe("native");
    expect(nativeTargetsForRecipient(person)).toEqual([{ sourceId: "project-alpha:secondary", sourceName: "Ledge Top Technologies", workspaceId: "workspace-n",
      workspaceName: "Harbor technology", projectId: "project-1", projectName: "Project 1", projectEndSupported: false }]);
  });

  it("refuses rows whose stated back end disagrees with their source, so they cannot reach the other route", () => {
    const primaryAsNative = { ...primaryRow(), backend: "native", key: recipientKey("native", "project-alpha:primary", "workspace-p", "principal", "person-p"), projects: [project(1)], folderBindingId: undefined };
    const nativeAsPrimary = { ...nativeRow(), backend: "primary", key: recipientKey("primary", "project-alpha:secondary", "workspace-n", "principal", "person-n"), folderBindingId: "binding-a", projects: undefined };
    const swappedSource = { ...nativeRow(), sourceId: "project-alpha:primary" };
    for (const row of [primaryAsNative, nativeAsPrimary, swappedSource]) expect(validClientShareRecipient(row)).toBe(false);
    expect(nativeTargetsForRecipient(swappedSource as ClientShareRecipient)).toEqual([]);
    // Display text never identifies a row: a different id with the same key text is refused.
    expect(validClientShareRecipient({ ...nativeRow(), publicId: "someone-else" })).toBe(false);
    expect(validClientShareRecipient({ ...nativeRow(), audienceType: "organization", key: recipientKey("native", "project-alpha:secondary", "workspace-n", "organization", "person-n") })).toBe(false);
    expect(validClientShareRecipient({ ...nativeRow([]) })).toBe(false);
    expect(validClientShareRecipient({ ...nativeRow([project(1), project(1)]) })).toBe(false);
    expect(validClientShareRecipient({ ...primaryRow(), folderBindingId: undefined })).toBe(false);
  });

  it("refuses a response with rows from a back end that reported no access, or duplicate keys", () => {
    expect(validClientShareRecipientSearch(search([primaryRow(), nativeRow()]))).toBe(true);
    expect(validClientShareRecipientSearch(search([primaryRow()], "not_permitted"))).toBe(false);
    expect(validClientShareRecipientSearch(search([nativeRow()], "ready", "unavailable"))).toBe(false);
    expect(validClientShareRecipientSearch(search([nativeRow(), nativeRow()]))).toBe(false);
    expect(validClientShareRecipientSearch(search([], "link_required", "not_permitted"))).toBe(true);
    expect(validClientShareRecipientSearch({ ...search([]), primary: "maybe" })).toBe(false);
  });

  it("chooses the project automatically only when the person has exactly one", () => {
    expect(autoSelectedProject(nativeRow([project(4)]))).toEqual(project(4));
    expect(autoSelectedProject(nativeRow([project(1), project(2)]))).toBeNull();
    expect(autoSelectedProject(primaryRow())).toBeNull();
  });

  it("keeps same-named clients in different divisions distinguishable", () => {
    expect(recipientDetail(primaryRow())).toBe("Ledge Top Drone Services · Harbor workspace · alex@example.test");
    expect(recipientDetail(nativeRow())).toBe("Ledge Top Technologies · Harbor technology · alex.tech@example.test");
    expect(recipientDetail(primaryRow("organization", "org"))).toBe("Ledge Top Drone Services · Harbor workspace · organization · current members");
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
    expect(app).toContain('unified preselected={backend === "native" ? recipient : null} historyTarget={historyNode}');
    expect(app).toContain('aria-label="Client access for this folder"');
    expect(app).toContain("Restore as new version");
    expect(native).toContain('"Cancel unpublished access"');
    expect(native).toContain("createPortal(<>{grants.map(grant =>");
  });
  it("filters as the user types against the combined endpoint and carries the id-based key", () => {
    expect(picker).toContain("/api/delivery/client-share-recipients?");
    expect(picker).toContain("window.setTimeout(");
    expect(picker).toContain("key={option.key} aria-selected={selected?.key === option.key}");
    expect(picker).toContain("validClientShareRecipientSearch(result)");
  });
});
