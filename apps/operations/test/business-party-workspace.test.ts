import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({
  readBusinessParty: vi.fn(),
  listProjects: vi.fn(),
  listCollection: vi.fn(),
  listServiceAssignments: vi.fn(),
  resolveContext: vi.fn(),
  verifyContext: vi.fn(),
}));

vi.mock("../src/worker/business-parties", () => ({ readBusinessParty: mocks.readBusinessParty }));
vi.mock("../src/worker/client-hub-business-projects", () => ({ listClientHubBusinessProjects: mocks.listProjects }));
vi.mock("../src/worker/client-hub-collections", () => ({ listClientHubCollection: mocks.listCollection }));
vi.mock("../src/worker/client-service-assignments", () => ({ listClientServiceAssignments: mocks.listServiceAssignments }));
vi.mock("../src/worker/client-hub", () => ({
  resolveClientHubDetailContext: mocks.resolveContext,
  verifyClientHubDetailContext: mocks.verifyContext,
}));

import { readBusinessPartySourceWorkspace } from "../src/worker/business-party-workspace";

const principal = { id: "staff-a" } as StaffPrincipal;
const env = {} as Env;
const member = {
  linkId: "link-secondary", root: { sourceId: "project-alpha:secondary", kind: "organization" as const, recordId: "org-2" },
  displayName: "Example customer", sourceName: "Secondary Alpha", availability: "available" as const,
  detailPath: "/clients/sources/project-alpha%3Asecondary/business/organizations/org-2",
};
const party = { id: "party-a", kind: "organization" as const, displayName: "Example customer", version: 4,
  status: "active" as const, members: [member], canManage: true, needsReview: false };
const context: ClientHubCollectionContext = {
  root: { source_id: "project-alpha:secondary", root_namespace: "business", kind: "organization", public_id: "org-2",
    pa_public_id: "org-2", mapping_status: "mapped", display_name: "Example customer", sort_name: "example customer",
    status: "active", portal_status: "provisioned", workspace_id: "workspace-2", legacy_account_id: null,
    account_count: 1, project_count: 2, request_count: 0, contact_count: 1, meaningful_activity_at: null,
    source_version: "source-v2", indexed_at: "2026-08-30T00:00:00.000Z", scan_generation: 2 },
  canonicalRoot: { sourceId: "project-alpha:secondary", rootNamespace: "business", kind: "organization", publicId: "org-2" },
  access: { directory: true, requests: false, delivery: true, viewer: false }, contextVersion: "c".repeat(64),
};
const projects = { items: [{ id: "project-secondary" }], page: { available: true, reason: null, nextCursor: null,
  hasMore: false, returned: 1, limit: 5 }, canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion };
const contacts = { items: [{ id: "contact-secondary" }], page: { available: true, reason: null, nextCursor: null,
  hasMore: false, returned: 1, limit: 5 }, canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion };
const serviceAssignments = { items: [{ row_key: "assignment-secondary", service_label: "Aerial mapping", effective_status: "effective" }],
  page: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 1, limit: 5 },
  readiness: { tables: "ready", receiver: "ready", source: "observed", directory: "ready", projection: "ready", catalog: "ready" },
  canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion, refreshedAt: "2026-08-30T00:00:00.000Z" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.readBusinessParty.mockResolvedValue(structuredClone(party));
  mocks.resolveContext.mockResolvedValue(context);
  mocks.listProjects.mockResolvedValue(projects);
  mocks.listCollection.mockResolvedValue(contacts);
  mocks.listServiceAssignments.mockResolvedValue(serviceAssignments);
  mocks.verifyContext.mockResolvedValue(undefined);
});

describe("unified business-party source workspace", () => {
  it("hydrates only the exact reviewed source and preserves provenance and entry points", async () => {
    const result = await readBusinessPartySourceWorkspace(env, principal, "party-a", "link-secondary", 4);
    expect(mocks.resolveContext).toHaveBeenCalledWith(env, principal, "organization", "org-2", "project-alpha:secondary", "business");
    expect(mocks.listProjects).toHaveBeenCalledWith(env, principal, context, { initial: true, limit: 5 });
    expect(mocks.listCollection).toHaveBeenCalledWith(env, context, "businessContacts", { initial: true, limit: 5 });
    expect(mocks.listServiceAssignments).toHaveBeenCalledWith(env, principal, context, { initial: true, limit: 5 });
    expect(mocks.verifyContext).toHaveBeenCalledTimes(2);
    expect(mocks.verifyContext).toHaveBeenNthCalledWith(1, env, principal, context);
    expect(mocks.verifyContext).toHaveBeenNthCalledWith(2, env, principal, context);
    expect(mocks.readBusinessParty).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ partyId: "party-a", partyVersion: 4, canonicalRoot: context.canonicalRoot,
      projects, contacts, serviceAssignments, source: { workspaceAvailable: true, capabilities: context.access },
      entryPoints: { projects: `${member.detailPath}#client-business-projects`, contacts: `${member.detailPath}#client-business-contacts`,
        serviceAssignments: `${member.detailPath}#client-service-assignments`,
        access: `${member.detailPath}#client-portal-access`, delivery: `${member.detailPath}#client-delivery-access`,
        audit: `${member.detailPath}#client-audit` } });
  });

  it.each([
    ["missing link", { ...party, members: [] }],
    ["unavailable source", { ...party, members: [{ ...member, availability: "unavailable", detailPath: null }] }],
    ["stale party version", { ...party, version: 5 }],
  ])("fails closed before source hydration for %s", async (_label, initialParty) => {
    mocks.readBusinessParty.mockResolvedValue(initialParty);
    await expect(readBusinessPartySourceWorkspace(env, principal, "party-a", "link-secondary", 4))
      .rejects.toMatchObject({ status: 409 } satisfies Partial<HTTPException>);
    expect(mocks.resolveContext).not.toHaveBeenCalled();
    expect(mocks.listProjects).not.toHaveBeenCalled();
    expect(mocks.listServiceAssignments).not.toHaveBeenCalled();
  });

  it("rejects a canonical source mismatch without releasing any source records", async () => {
    mocks.resolveContext.mockResolvedValue({ ...context, canonicalRoot: { ...context.canonicalRoot, sourceId: "project-alpha:primary" } });
    await expect(readBusinessPartySourceWorkspace(env, principal, "party-a", "link-secondary", 4))
      .rejects.toMatchObject({ status: 409 } satisfies Partial<HTTPException>);
    expect(mocks.listProjects).not.toHaveBeenCalled();
    expect(mocks.listCollection).not.toHaveBeenCalled();
    expect(mocks.listServiceAssignments).not.toHaveBeenCalled();
  });

  it("discards hydrated data when membership changes during independent reads", async () => {
    mocks.readBusinessParty
      .mockResolvedValueOnce(structuredClone(party))
      .mockResolvedValueOnce({ ...party, version: 5, members: [] });
    await expect(readBusinessPartySourceWorkspace(env, principal, "party-a", "link-secondary", 4))
      .rejects.toMatchObject({ status: 409 } satisfies Partial<HTTPException>);
    expect(mocks.verifyContext).toHaveBeenCalled();
    expect(mocks.listProjects).toHaveBeenCalled();
    expect(mocks.listCollection).toHaveBeenCalled();
  });

  it("discards hydrated data when the source context changes during the final membership read", async () => {
    mocks.verifyContext
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new HTTPException(409, { message: "Client mapping changed" }));
    await expect(readBusinessPartySourceWorkspace(env, principal, "party-a", "link-secondary", 4))
      .rejects.toMatchObject({ status: 409 } satisfies Partial<HTTPException>);
    expect(mocks.readBusinessParty).toHaveBeenCalledTimes(2);
    expect(mocks.verifyContext).toHaveBeenCalledTimes(2);
  });
});
