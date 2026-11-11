import { describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ requirePermission: vi.fn(), authorize: vi.fn() }));
vi.mock("../src/worker/acl", () => ({ requirePermission: mock.requirePermission }));
vi.mock("../src/worker/delivery", () => ({
  authorizeDeliveryFolderPrefix: mock.authorize,
  decodeRef: (value: string) => value === "folder-ref" ? "Jobs/Clients/Example" : value,
  normalizePrefix: (value: string) => `${value.replace(/\/$/, "")}/`,
}));

import { clientRecipientVersion, isPublicationAcknowledged, listClientDeliveryRecipients, parseClientRecipientQuery } from "../src/worker/client-delivery-recipients";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal = { id: "staff-one", email: "staff@example.test", displayName: "Staff", accessSubject: "staff-subject" } as StaffPrincipal;
const record = { record_id: "client-record-1", record_kind: "client", current_version: 3,
  display_name: "Example Client", organization_record_id: null, organization_version: null, parent_profile_json: null,
  updated_at: "2026-10-30 12:00:00" };

function d1(options: { fail?: boolean; queries?: Array<{ sql: string; values: unknown[] }> } = {}): D1Database {
  return {
    withSession() { return this; },
    prepare(sql: string) {
      if (options.fail) throw new Error("schema unavailable");
      return { bind(...values: unknown[]) { options.queries?.push({ sql, values }); return {
        all: async () => ({ results: sql.includes("FROM project_folders") ? []
          : sql.includes("FROM operations_directory_records record") ? [record]
            : [] }),
        first: async () => null,
      }; } };
    },
  } as unknown as D1Database;
}

function env(options: { fail?: boolean; queries?: Array<{ sql: string; values: unknown[] }> } = {}): Env {
  return { OPS_DB: d1(options), DELIVERY_DB: d1(), DATA_BUCKET: { list: async () => ({ objects: [{ key: "Jobs/Clients/Example/photo.jpg" }], delimitedPrefixes: [] }) } } as unknown as Env;
}

describe("client delivery recipient list", () => {
  it("strictly parses recent and search queries, with a hard 20 item maximum", () => {
    expect(parseClientRecipientQuery(new URL("https://ops.test/api/delivery/client-recipients?folderRef=folder-ref")))
      .toEqual({ folderRef: "folder-ref", q: "", limit: 20, mode: "recent" });
    expect(parseClientRecipientQuery(new URL("https://ops.test/api/delivery/client-recipients?folderRef=folder-ref&q=Acme&limit=4")))
      .toEqual({ folderRef: "folder-ref", q: "Acme", limit: 4, mode: "search" });
    expect(() => parseClientRecipientQuery(new URL("https://ops.test/api/delivery/client-recipients?folderRef=x&limit=21"))).toThrow();
    expect(() => parseClientRecipientQuery(new URL("https://ops.test/api/delivery/client-recipients?folderRef=x&q=a&q=b"))).toThrow();
    expect(() => parseClientRecipientQuery(new URL("https://ops.test/api/delivery/client-recipients?folderRef=x&email=a%40b.test"))).toThrow();
  });

  it("returns only the exact safe shape and separates missing portal setup from errors", async () => {
    mock.requirePermission.mockResolvedValue(undefined);
    mock.authorize.mockResolvedValue(undefined);
    const result = await listClientDeliveryRecipients(env(), principal, { folderRef: "folder-ref" });
    expect(result).toEqual({ mode: "recent", projectFolder: false, recipients: [{
      recipientId: "client-record-1", recipientVersion: expect.stringMatching(/^crv_[A-Za-z0-9_-]{43}$/),
      type: "client", displayName: "Example Client", organizationName: null,
      portal: { state: "not_set_up" }, memberCount: null, lastActivityAt: null,
    }] });
    const serialized = JSON.stringify(result);
    for (const forbidden of ["email", "division", "workspace_id", "identity_id", "sourceId", "pa_"]) expect(serialized).not.toContain(forbidden);
    expect(mock.requirePermission).toHaveBeenCalledWith(expect.anything(), principal, "delivery.share.create", undefined, true);
  });

  it("resolves internal mutations by exact record ID instead of a capped display-name search", async () => {
    mock.requirePermission.mockResolvedValue(undefined);
    mock.authorize.mockResolvedValue(undefined);
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const result = await listClientDeliveryRecipients(env({ queries }), principal,
      { folderRef: "folder-ref", exactRecordId: "client-record-1", limit: 20 });
    expect(result.recipients).toHaveLength(1);
    const roots = queries.find(query => query.sql.includes("FROM operations_directory_records record"));
    expect(roots?.sql).toContain("(? IS NULL OR record.record_id=?)");
    expect(roots?.values.slice(0, 2)).toEqual(["client-record-1", "client-record-1"]);
  });

  it("pins the record and roster without disclosing the hashed inputs", async () => {
    const first = await clientRecipientVersion({ record: { id: "private-record" }, roster: [{ member: "private-member" }] });
    const same = await clientRecipientVersion({ record: { id: "private-record" }, roster: [{ member: "private-member" }] });
    const changed = await clientRecipientVersion({ record: { id: "private-record" }, roster: [{ member: "other-member" }] });
    expect(first).toBe(same);
    expect(first).not.toBe(changed);
    expect(first).not.toContain("private-record");
    expect(first).not.toContain("private-member");
  });

  it("requires the joined immutable snapshot and current checkpoint before treating publication as acknowledged", () => {
    const row = { publication_revision: 7, source_sequence: 7, snapshot_id: "snapshot-current",
      snapshot_verified_id: "snapshot-current", snapshot_sha256: "a".repeat(64), operation_id: "operation-current",
      ack_token: "claim-current", acknowledged_claim_token: "claim-current", checkpoint_id: "checkpoint-current" };
    expect(isPublicationAcknowledged(row)).toBe(true);
    expect(isPublicationAcknowledged({ ...row, snapshot_verified_id: null })).toBe(false);
    expect(isPublicationAcknowledged({ ...row, snapshot_verified_id: "snapshot-stale" })).toBe(false);
    expect(isPublicationAcknowledged({ ...row, checkpoint_id: null })).toBe(false);
  });

  it("fails closed when authority tables cannot be read", async () => {
    mock.requirePermission.mockResolvedValue(undefined);
    mock.authorize.mockResolvedValue(undefined);
    await expect(listClientDeliveryRecipients(env({ fail: true }), principal, { folderRef: "folder-ref" }))
      .rejects.toMatchObject({ status: 503 });
  });
});
