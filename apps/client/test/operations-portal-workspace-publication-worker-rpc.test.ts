import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256OperationsPortalWorkspacePublication, sha256OperationsPortalWorkspaceSnapshot }
  from "@ltds/shared/operations-portal-workspace-publication";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationDirectory = path.join(root, "apps", "client", "migrations");
const enabledBindings = { ENVIRONMENT: "staging",
  EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com",
  CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true" };
const disabled = [
  { name: "production", bindings: { ...enabledBindings, ENVIRONMENT: "production" } },
  { name: "missing-environment", bindings: { EXPECTED_HOST: enabledBindings.EXPECTED_HOST,
    CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true" } },
  { name: "wrong-host", bindings: { ...enabledBindings, EXPECTED_HOST: "delivery.example.test" } },
  { name: "false-flag", bindings: { ...enabledBindings,
    CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "false" } },
  { name: "missing-flag", bindings: { ENVIRONMENT: enabledBindings.ENVIRONMENT,
    EXPECTED_HOST: enabledBindings.EXPECTED_HOST } },
] as const;

async function publication() {
  const value = { protocol: "operations-portal-workspace-publication", protocolVersion: 1, action: "publish",
    publicationId: crypto.randomUUID(), operationId: crypto.randomUUID(), expectedRevision: "0", resultingRevision: "1",
    target: { targetId: crypto.randomUUID(), targetRevision: "4", clientAuthorityId: crypto.randomUUID(),
      workspaceId: `workspace-${crypto.randomUUID()}`, rootKind: "organization",
      rootRecordId: `ops/org/${crypto.randomUUID()}` },
    snapshot: { snapshotId: crypto.randomUUID(), checkpointId: crypto.randomUUID(), sourceSequence: "1", complete: true,
      counts: { directoryRecords: 1, projects: 0, folderReservations: 0,
        recipientAuthorityHeads: 0, deliveryAuthorityHeads: 0 }, snapshotSha256: "0".repeat(64),
      directoryRecords: [{ recordId: "", kind: "organization", version: "1", parentRecordId: null,
        relationshipVersion: null, displayName: "RPC acceptance customer", externalFences: [] }],
      projects: [], folderReservations: [], recipientAuthorityHeads: [], deliveryAuthorityHeads: [] },
    actorProof: { staffId: "rpc-acceptance-owner", verifiedAccessSubject: "rpc-acceptance-subject",
      admissionVersion: "1", profileVersion: "1", grantGeneration: "1",
      verifiedUntil: "2030-01-01T00:00:00.000Z" }, observedAt: "2026-09-30T00:00:00.000Z" };
  value.snapshot.directoryRecords[0]!.recordId = value.target.rootRecordId;
  value.snapshot.snapshotSha256 = await sha256OperationsPortalWorkspaceSnapshot(value);
  return value;
}

describe("operations publication through a real named Worker service binding", () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    const result = await build({ configFile: false, logLevel: "silent", ssr: { noExternal: true },
      build: { ssr: fileURLToPath(new URL("../src/worker/operations-portal-workspace-publication-entrypoint.ts",
        import.meta.url)), target: "esnext", write: false, minify: false,
        rollupOptions: { external: id => id.startsWith("cloudflare:") } } });
    const output = Array.isArray(result) ? result[0] : result;
    if (!output || !("output" in output)) throw new Error("publication RPC test bundle missing");
    const chunk = output.output.find(item => item.type === "chunk" && item.isEntry);
    if (!chunk || chunk.type !== "chunk") throw new Error("publication RPC test entrypoint missing");
    const targets = ["enabled", ...disabled.map(candidate => candidate.name)];
    runtime = new Miniflare({ workers: [
      { name: "rpc-driver", modules: true, compatibilityDate: "2026-07-22", compatibilityFlags: ["nodejs_compat"],
        serviceBindings: Object.fromEntries(targets.map(name => [name,
          { name: `publication-${name}`, entrypoint: "OperationsPortalWorkspacePublicationIngress" }])),
        script: `function rpcResponse(value) {
          const primitive = typeof value === 'string';
          const symbols = primitive ? [] : Object.getOwnPropertySymbols(value);
          return new Response(primitive ? value : JSON.stringify(value), {headers: {
            'content-type': 'application/json', 'x-rpc-result-type': typeof value,
            'x-rpc-result-symbol-count': String(symbols.length)}});
        }
        export default { async fetch(request, env) {
          const [name, action] = new URL(request.url).pathname.split('/').slice(1);
          if (!Object.hasOwn(env, name)) return new Response(null, {status: 404});
          const length = Number(request.headers.get('content-length') || '0');
          if (!Number.isSafeInteger(length) || length < 0 || length > 1900000)
            return new Response(null, {status: 413});
          if (action === 'http') return env[name].fetch(request);
          const input = await request.json();
          if (action === 'publish' || action === 'discard-publish') {
            const result = await env[name].publishWorkspace(input);
            return action === 'discard-publish' ? new Response('caller discarded RPC result', {status: 502}) : rpcResponse(result);
          }
          if (action === 'status') return rpcResponse(await env[name].getPublicationStatus(input));
          if (action === 'disposition') return rpcResponse(await env[name].getPublicationDisposition(input));
          if (action === 'cancel' || action === 'discard-cancel') {
            const result = await env[name].cancelWorkspacePublication(input);
            return action === 'discard-cancel' ? new Response('caller discarded RPC result', {status: 502}) : rpcResponse(result);
          }
          return new Response(null, {status: 404});
        } };` },
      { name: "publication-enabled", modules: true, compatibilityDate: "2026-07-16",
        compatibilityFlags: ["nodejs_compat"], script: chunk.code, bindings: enabledBindings,
        d1Databases: { DELIVERY_DB: crypto.randomUUID() } },
      ...disabled.map(candidate => ({ name: `publication-${candidate.name}`, modules: true,
        compatibilityDate: "2026-07-16", compatibilityFlags: ["nodejs_compat"], script: chunk.code,
        bindings: candidate.bindings, d1Databases: { DELIVERY_DB: crypto.randomUUID() } })),
    ] });
    const database = await runtime.getD1Database("DELIVERY_DB", "publication-enabled");
    const reviewed = fs.readdirSync(migrationDirectory).filter(name => /^\d{4}_.+\.sql$/.test(name)
      && name <= "0223_operations_portal_workspace_publications.sql").sort();
    expect(reviewed).toHaveLength(142);
    await database.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)").run();
    for (const name of [...reviewed, "0225_operations_portal_workspace_publication_cancellations.sql"]) {
      const statements = splitD1MigrationStatements(fs.readFileSync(path.join(migrationDirectory, name), "utf8"))
        .map(sql => database.prepare(sql));
      statements.push(database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name));
      await database.batch(statements);
    }
  }, 180_000);
  afterAll(async () => { if (runtime) await runtime.dispose(); });

  async function call(name: string, action: string, input: unknown) {
    return runtime.dispatchFetch(`https://rpc.example.test/${name}/${action}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }

  it("returns disabled on every RPC and leaves each disabled database unchanged", async () => {
    for (const candidate of disabled) {
      const database = await runtime.getD1Database("DELIVERY_DB", `publication-${candidate.name}`);
      await database.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all();
      const schema = async () => (await database.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all()).results;
      const before = await schema();
      for (const action of ["publish", "status", "disposition", "cancel"]) {
        const response = await call(candidate.name, action, { unexpected: true });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-rpc-result-type")).toBe("string");
        expect(response.headers.get("x-rpc-result-symbol-count")).toBe("0");
        expect(await response.json()).toEqual({ ok: false, protocol: "operations-portal-workspace-publication",
          protocolVersion: 1, code: "disabled", retryable: true });
      }
      expect(await schema()).toEqual(before);
    }
  });

  it("serializes committed and cancelled evidence and recovers caller-discarded results", async () => {
    const committed = await publication();
    expect(await (await call("enabled", "disposition", committed)).json())
      .toEqual({ ok: true, disposition: "not-found" });
    const first = await call("enabled", "publish", committed);
    const receipt = { operationId: committed.operationId, publicationId: committed.publicationId,
      requestFingerprint: await sha256OperationsPortalWorkspacePublication(committed), targetId: committed.target.targetId,
      resultingRevision: "1", sourceSequence: "1", snapshotId: committed.snapshot.snapshotId,
      snapshotSha256: committed.snapshot.snapshotSha256, replayed: false };
    expect(await first.json()).toEqual({ ok: true, receipt });
    expect(await (await call("enabled", "publish", committed)).json())
      .toEqual({ ok: true, receipt: { ...receipt, replayed: true } });
    expect(await (await call("enabled", "status", committed)).json())
      .toEqual({ ok: true, receipt: { ...receipt, replayed: true } });
    expect(await (await call("enabled", "disposition", committed)).json())
      .toEqual({ ok: true, disposition: "committed", receipt: { ...receipt, replayed: true } });

    const lostPublish = await publication();
    expect((await call("enabled", "discard-publish", lostPublish)).status).toBe(502);
    expect(await (await call("enabled", "disposition", lostPublish)).json())
      .toEqual({ ok: true, disposition: "committed", receipt: { operationId: lostPublish.operationId,
        publicationId: lostPublish.publicationId,
        requestFingerprint: await sha256OperationsPortalWorkspacePublication(lostPublish),
        targetId: lostPublish.target.targetId, resultingRevision: "1", sourceSequence: "1",
        snapshotId: lostPublish.snapshot.snapshotId, snapshotSha256: lostPublish.snapshot.snapshotSha256,
        replayed: true } });

    const cancelled = await publication();
    expect((await call("enabled", "discard-cancel", cancelled)).status).toBe(502);
    const cancellation = await (await call("enabled", "disposition", cancelled)).json();
    expect(cancellation).toEqual({ ok: true, disposition: "cancelled", cancellation: {
      operationId: cancelled.operationId, publicationId: cancelled.publicationId,
      requestFingerprint: await sha256OperationsPortalWorkspacePublication(cancelled),
      targetId: cancelled.target.targetId, targetRevision: "4", clientAuthorityId: cancelled.target.clientAuthorityId,
      workspaceId: cancelled.target.workspaceId, rootKind: "organization", rootRecordId: cancelled.target.rootRecordId,
      expectedRevision: "0", resultingRevision: "1", sourceSequence: "1", snapshotId: cancelled.snapshot.snapshotId,
      checkpointId: cancelled.snapshot.checkpointId, snapshotSha256: cancelled.snapshot.snapshotSha256,
      cancelledAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), replayed: true } });
    expect(await (await call("enabled", "publish", cancelled)).json()).toEqual(cancellation);
    expect(await (await call("enabled", "cancel", cancelled)).json()).toEqual(cancellation);

    const publicResponse = await call("enabled", "http", { ignored: true });
    expect(publicResponse.status).toBe(404);
    expect(publicResponse.headers.get("cache-control")).toBe("no-store");
    const database = await runtime.getD1Database("DELIVERY_DB", "publication-enabled");
    expect(await database.prepare(`SELECT head.latest_operation_id operationId,head.snapshot_id snapshotId,
      receipt.request_fingerprint requestFingerprint FROM operations_portal_workspace_publication_heads head
      JOIN operations_portal_workspace_publication_receipts receipt ON receipt.operation_id=head.latest_operation_id
      WHERE head.target_id=?`).bind(committed.target.targetId).first()).toEqual({ operationId: committed.operationId,
        snapshotId: committed.snapshot.snapshotId, requestFingerprint: receipt.requestFingerprint });
    expect(await database.prepare(`SELECT operation_id operationId,snapshot_sha256 snapshotSha256
      FROM operations_portal_workspace_publication_snapshots WHERE snapshot_id=?`)
      .bind(committed.snapshot.snapshotId).first()).toEqual({ operationId: committed.operationId,
        snapshotSha256: committed.snapshot.snapshotSha256 });
    expect(await database.prepare("SELECT count(*) FROM portal_operations_principal_grant_heads").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM portal_operations_workspace_authority_heads").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM portal_v2_entitlements").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT name FROM sqlite_schema WHERE name='operations_portal_native_authority_commands'").first()).toBeNull();
  });
});
