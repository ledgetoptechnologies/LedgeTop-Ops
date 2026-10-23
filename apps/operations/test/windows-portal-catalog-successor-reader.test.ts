import { describe, expect, it, vi } from "vitest";
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand as canonical,
  type OperationsPortalNativeDeliveryAuthorityCommand } from "@ltds/shared/operations-portal-native-delivery-authority";
import { readWindowsPortalCatalogSuccessorAuthorizationEntrypoint as read,
  readWindowsPortalSuccessorAuthorizationEntrypoint as download } from "../src/worker/operations-portal-native-delivery-authority-reader";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const grant = (): OperationsPortalNativeDeliveryAuthorityCommand => ({
  protocol: "operations-portal-native-delivery-authority", protocolVersion: 1, permissionSchemaVersion: 3,
  action: "delivery.grant", operationId: id(1), authority: { authorityId: id(2), expectedRevision: "0", resultingRevision: "1" },
  target: { targetId: id(3), targetRevision: "1", clientAuthorityId: id(4), workspaceId: "synthetic-workspace",
    rootKind: "standalone_client", rootRecordId: "synthetic-client" },
  recipient: { recipientBindingId: id(5), enrollmentIntentId: id(6), targetClientRecordId: "synthetic-client",
    issuer: "https://synthetic.cloudflareaccess.com", subject: "synthetic-recipient", homeOwnershipEpoch: "1", homeGrantRevision: "1",
    homeGrantOperationId: id(7), homeRequestFingerprint: "a".repeat(64) },
  publication: { operationId: id(101), publicationId: id(201), revision: "1", sourceSequence: "1", snapshotId: id(301), snapshotSha256: "b".repeat(64) },
  resource: { folderReservationId: id(11), folderReservationRevision: "1", clientFolderBindingId: "synthetic-folder",
    externalProjectId: "synthetic-project", projectVersion: "1", opsFolderProjectId: "synthetic-physical", opsDivisionId: "synthetic-division",
    selectedR2Prefix: "synthetic/photos/", baseR2Prefix: "synthetic/", baseMatchMethod: "manual", baseConfirmedBy: "synthetic-owner",
    baseConfirmedAt: "2026-10-01T00:00:00.000Z" },
  features: ["file.download"], expiresAt: new Date(Date.now() + 3600_000).toISOString(), reasonCode: "Synthetic chain", observedAt: new Date().toISOString(),
});
const row = (sequence: number) => ({ operation_id: id(100 + sequence), publication_id: id(200 + sequence),
  expected_revision: sequence - 1, revision: sequence, source_sequence: sequence,
  snapshot_id: id(300 + sequence), snapshot_sha256: "b".repeat(64), resource_retained: 1 });

function database(features: string[], secondFeatures = features) {
  let authCount = 0;
  const bound: unknown[][] = [];
  const g = grant(), a = g.authority, t = g.target, r = g.recipient, f = g.resource, p = g.publication;
  const proof = { authority_id: a.authorityId, revision: Number(a.resultingRevision), recipient_binding_id: r.recipientBindingId,
    enrollment_intent_id: r.enrollmentIntentId, issuer: r.issuer, subject: r.subject, target_id: t.targetId,
    target_revision: Number(t.targetRevision), target_client_record_id: r.targetClientRecordId,
    client_authority_id: t.clientAuthorityId, workspace_id: t.workspaceId, client_folder_binding_id: f.clientFolderBindingId,
    folder_reservation_id: f.folderReservationId, folder_reservation_revision: Number(f.folderReservationRevision),
    external_project_id: f.externalProjectId, project_version: Number(f.projectVersion), publication_operation_id: p.operationId,
    publication_id: p.publicationId, publication_revision: Number(p.revision), publication_source_sequence: Number(p.sourceSequence),
    publication_snapshot_id: p.snapshotId, publication_snapshot_sha256: p.snapshotSha256,
    home_ownership_epoch: Number(r.homeOwnershipEpoch), home_grant_revision: Number(r.homeGrantRevision),
    home_grant_operation_id: r.homeGrantOperationId, home_request_fingerprint: r.homeRequestFingerprint,
    ops_folder_project_id: f.opsFolderProjectId, ops_division_id: f.opsDivisionId,
    selected_r2_prefix: f.selectedR2Prefix, expires_at: g.expiresAt };
  const prepare = vi.fn((sql: string) => ({ bind: (...values: unknown[]) => {
    const auth = sql.startsWith("SELECT head.authority_id");
    if (auth) bound.push(values);
    return { first: async () => auth ? { ...proof, features_json: JSON.stringify(++authCount === 1 ? features : secondFeatures) } : row(3),
      all: async () => ({ success: true, results: [row(1), row(2), row(3)] }) };
  } }));
  const db = { withSession: () => ({ prepare }) } as unknown as D1Database;
  const env = { OPS_DB: db, ENVIRONMENT: "production", EXPECTED_HOST: "ops.ledgetopdroneservices.com",
    PUBLIC_BASE_URL: "https://ops.ledgetopdroneservices.com", OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: "true" };
  return { env, bound, prepare };
}
describe("explicit-feature private catalog successor RPC", () => {
  it.each(["folder.list", "file.metadata"] as const)("admits a %s-only original/current grant without download access", async feature => {
    const d = database([feature]), g = { ...grant(), features: [feature] };
    const result = JSON.parse(await read(d.env, canonical(g), feature));
    expect(result).toMatchObject({ ok: true, protocolVersion: 1, feature,
      catalog: { authorization: { features: [feature] }, continuity: { publicationCount: 3 } } });
    expect(result).not.toHaveProperty("successor");
    expect(d.bound).toHaveLength(2);
    expect(d.bound.every(values => values[7] === feature)).toBe(true);
    expect(JSON.parse(await download(d.env, canonical(g)))).toEqual({ ok: false, protocolVersion: 1, code: "denied" });
  });
  it.each([undefined, null, "file.download", "file.preview", "folder.list ", {}, []])("rejects invalid catalog feature %j before database access", async feature => {
    const d = database(["folder.list"]);
    expect(JSON.parse(await read(d.env, canonical(grant()), feature))).toEqual({ ok: false, protocolVersion: 1, code: "invalid" });
    expect(d.prepare).not.toHaveBeenCalled();
  });
  it("requires selected feature in the original grant before history access", async () => {
    const d = database(["file.metadata"]);
    expect(JSON.parse(await read(d.env, canonical({ ...grant(), features: ["folder.list"] }), "file.metadata"))).toMatchObject({ ok: false, code: "denied" });
    expect(d.prepare).not.toHaveBeenCalled();
  });
  it.each([0, 1])("rejects missing current feature on authorization query %i", async query => {
    const d = database(query === 0 ? ["file.download"] : ["folder.list"], ["file.download"]);
    expect(JSON.parse(await read(d.env, canonical({ ...grant(), features: ["folder.list"] }), "folder.list"))).toMatchObject({ ok: false, code: "denied" });
    expect(d.bound).toHaveLength(query + 1);
  });
  it.each(["", "{}", "not json", " ", "x".repeat(65_537)])("rejects malformed/noncanonical/oversized input", async raw => {
    const d = database(["folder.list"]);
    expect(JSON.parse(await read(d.env, raw, "folder.list"))).toMatchObject({ ok: false, code: "invalid" });
    expect(d.prepare).not.toHaveBeenCalled();
  });
  it("preserves disabled admission and noncanonical duplicate-key rejection", async () => {
    const d = database(["folder.list"]), wire = canonical({ ...grant(), features: ["folder.list"] });
    expect(JSON.parse(await read({ ...d.env, OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: "false" }, wire, "folder.list"))).toMatchObject({ ok: false, code: "disabled" });
    expect(JSON.parse(await read(d.env, wire.replace('{', '{"protocolVersion":1,'), "folder.list"))).toMatchObject({ ok: false, code: "invalid" });
    expect(d.prepare).not.toHaveBeenCalled();
  });
  it("denies expired original grants before database access", async () => {
    const d = database(["folder.list"]);
    const g = { ...grant(), features: ["folder.list" as const], expiresAt: "2000-01-01T00:00:00.000Z", observedAt: "1999-12-31T00:00:00.000Z" };
    expect(JSON.parse(await read(d.env, canonical(g), "folder.list"))).toMatchObject({ ok: false, code: "denied" });
    expect(d.prepare).not.toHaveBeenCalled();
  });
  it("sanitizes unexpected database failures", async () => {
    const d = database(["folder.list"]);
    d.prepare.mockImplementation(() => { throw new Error("private database detail"); });
    expect(JSON.parse(await read(d.env, canonical({ ...grant(), features: ["folder.list"] }), "folder.list")))
      .toEqual({ ok: false, protocolVersion: 1, code: "unavailable" });
  });
  it("keeps the download response protocol unchanged", async () => {
    const d = database(["file.download"]);
    const result = JSON.parse(await download(d.env, canonical(grant())));
    expect(result).toMatchObject({ ok: true, protocolVersion: 1, successor: { authorization: { features: ["file.download"] } } });
    expect(result).not.toHaveProperty("catalog"); expect(result).not.toHaveProperty("feature");
  });
});
