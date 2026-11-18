import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
import { clientShareBackendForSource, clientShareRecipientKey, searchClientShareRecipients, type ClientShareRecipientDependencies } from "../src/worker/client-share-recipients";
import { validClientShareRecipientSearch } from "../src/client/client-share-routing";
import type { Env, StaffPrincipal } from "../src/worker/types";

const env = {} as Env;
const staff: StaffPrincipal = { id: "staff-a", email: "staff@example.test", displayName: "Staff", accessSubject: "subject", projectAlphaUserId: null };
const primaryResult = {
  folderBindingId: "binding-a", workspaceId: "workspace-primary", workspaceLabel: "Harbor workspace", scopeTypeFilter: null,
  audiences: [
    { type: "principal" as const, publicId: "person-p", displayName: "Alex Harbor", email: "alex@example.test", recipientMode: "exact" as const },
    { type: "department" as const, publicId: "dept-p", displayName: "Harbor survey team", recipientMode: "dynamic" as const },
    { type: "organization" as const, publicId: "org-p", displayName: "Harbor Group", recipientMode: "dynamic" as const },
    { type: "client" as const, publicId: "client-p", displayName: "Harbor Marina", recipientMode: "dynamic" as const },
    { type: "project" as const, publicId: "project-p", displayName: "Harbor dredging", recipientMode: "dynamic" as const },
  ],
  truncatedKinds: { principal: true, organization: false, department: false, client: false },
};
const nativeResult = {
  truncated: false,
  recipients: [{ sourceId: "project-alpha:secondary", sourceName: "Secondary", workspaceId: "workspace-native", workspaceName: "Harbor technology",
    principalPublicId: "person-n", displayName: "Alex Harbor", email: "alex.tech@example.test" }],
};
function deps(overrides: Partial<ClientShareRecipientDependencies> = {}): ClientShareRecipientDependencies {
  return {
    primaryEnabled: () => true,
    searchPrimary: vi.fn(async () => primaryResult) as unknown as ClientShareRecipientDependencies["searchPrimary"],
    nativeReady: vi.fn(async () => true),
    searchNative: vi.fn(async () => nativeResult) as unknown as ClientShareRecipientDependencies["searchNative"],
    ...overrides,
  };
}
const search = (d: ClientShareRecipientDependencies, q = "Harbor") => searchClientShareRecipients(env, staff, "folder-ref", "Jobs/Harbor/", q, d);

describe("combined client share recipient search", () => {
  it("maps the primary source to the authenticated grant back end and every other source to connected workspaces", () => {
    expect(clientShareBackendForSource("project-alpha:primary")).toBe("primary");
    expect(clientShareBackendForSource("project-alpha:secondary")).toBe("native");
    expect(clientShareBackendForSource("project-alpha:another")).toBe("native");
  });

  it("returns every audience kind from both back ends with division labels and id-based keys", async () => {
    const d = deps(), result = await search(d);
    expect(d.searchPrimary).toHaveBeenCalledWith(env, staff, "Jobs/Harbor/", "Harbor");
    expect(d.searchNative).toHaveBeenCalledWith(env, staff, "folder-ref", "Harbor");
    expect(result.primary).toBe("ready"); expect(result.native).toBe("ready");
    const byKind = Object.fromEntries(result.recipients.filter(row => row.backend === "primary").map(row => [row.audienceType, row]));
    for (const kind of ["principal", "department", "organization", "client"]) {
      expect(byKind[kind]).toMatchObject({ backend: "primary", sourceId: "project-alpha:primary", divisionLabel: "Ledge Top Drone Services", folderBindingId: "binding-a" });
    }
    expect(byKind.department!.email).toBeNull();
    // Project-wide audiences were not offered before and are not offered now.
    expect(byKind.project).toBeUndefined();
    const native = result.recipients.find(row => row.backend === "native")!;
    expect(native).toMatchObject({ sourceId: "project-alpha:secondary", divisionLabel: "Ledge Top Technologies", audienceType: "principal", publicId: "person-n",
      key: clientShareRecipientKey("native", "project-alpha:secondary", "workspace-native", "principal", "person-n") });
    expect(native.folderBindingId).toBeUndefined();
    expect(native).not.toHaveProperty("projects");
    // Truncation is reported per kind, so a busy kind cannot hide another.
    expect(result.truncated).toEqual({ principal: true, organization: false, department: false, client: false, connected: false });
    // The same person in both divisions stays two rows, told apart by division and key.
    const alex = result.recipients.filter(row => row.displayName === "Alex Harbor");
    expect(alex.map(row => row.divisionLabel).sort()).toEqual(["Ledge Top Drone Services", "Ledge Top Technologies"]);
    expect(new Set(alex.map(row => row.key)).size).toBe(2);
    expect(validClientShareRecipientSearch(result)).toBe(true);
  });

  it("gives no primary rows when the caller lacks the division permission", async () => {
    const result = await search(deps({ searchPrimary: vi.fn(async () => { throw new HTTPException(403, { message: "Forbidden" }); }) as never }));
    expect(result.primary).toBe("not_permitted");
    expect(result.recipients.every(row => row.backend === "native")).toBe(true);
    // No primary counts leak to a caller without the division permission.
    expect([result.truncated.principal, result.truncated.organization, result.truncated.department, result.truncated.client]).toEqual([false, false, false, false]);
  });

  it("gives no connected-workspace rows when the caller has no native rights or it is not deployed", async () => {
    const denied = await search(deps({ searchNative: vi.fn(async () => { throw new HTTPException(403, { message: "native_delivery_staff_unavailable" }); }) as never }));
    expect(denied.native).toBe("not_permitted"); expect(denied.recipients.every(row => row.backend === "primary")).toBe(true);
    const searchNative = vi.fn();
    const absent = await search(deps({ nativeReady: vi.fn(async () => false), searchNative: searchNative as never }));
    expect(absent.native).toBe("unavailable"); expect(searchNative).not.toHaveBeenCalled();
    expect(absent.recipients.every(row => row.backend === "primary")).toBe(true);
  });

  it("reports the link step only for an unlinked folder", async () => {
    const unlinked = await search(deps({ searchPrimary: vi.fn(async () => { throw new HTTPException(404, { message: "This folder is not bound to a client workspace" }); }) as never }));
    expect(unlinked.primary).toBe("link_required");
    const other = await search(deps({ searchPrimary: vi.fn(async () => { throw new HTTPException(404, { message: "Folder binding not found" }); }) as never }));
    expect(other.primary).toBe("unavailable");
    const searchPrimary = vi.fn();
    const disabled = await search(deps({ primaryEnabled: () => false, searchPrimary: searchPrimary as never }));
    expect(disabled.primary).toBe("unavailable"); expect(searchPrimary).not.toHaveBeenCalled();
  });

  it("drops a primary-source row offered by the connected-workspace search", async () => {
    const result = await search(deps({ searchNative: vi.fn(async () => ({ truncated: false, recipients: [
      { ...nativeResult.recipients[0]!, sourceId: "project-alpha:primary", principalPublicId: "smuggled" },
    ] })) as never }));
    expect(result.recipients.some(row => row.publicId === "smuggled")).toBe(false);
    expect(result.recipients.filter(row => row.backend === "native")).toEqual([]);
  });

  it("returns one half's results when the other half fails unexpectedly", async () => {
    const report = vi.fn();
    const nativeDown = await search(deps({ report, searchNative: vi.fn(async () => { throw new Error("database offline"); }) as never }));
    expect(nativeDown.native).toBe("failed"); expect(nativeDown.primary).toBe("ready");
    expect(nativeDown.recipients.filter(row => row.backend === "primary")).toHaveLength(4);
    const primaryDown = await search(deps({ report, searchPrimary: vi.fn(async () => { throw new Error("database offline"); }) as never }));
    expect(primaryDown.primary).toBe("failed"); expect(primaryDown.recipients.map(row => row.backend)).toEqual(["native"]);
    expect(report).toHaveBeenCalledTimes(2);
    expect(validClientShareRecipientSearch(nativeDown)).toBe(true); expect(validClientShareRecipientSearch(primaryDown)).toBe(true);
  });

  it("validates the query before calling either back end", async () => {
    const d = deps();
    await expect(search(d, "x")).rejects.toMatchObject({ status: 400 });
    await expect(search(d, "y".repeat(101))).rejects.toMatchObject({ status: 400 });
    expect(d.searchPrimary).not.toHaveBeenCalled(); expect(d.searchNative).not.toHaveBeenCalled();
  });
});
