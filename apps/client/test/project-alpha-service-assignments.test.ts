import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  handleProjectAlphaServiceAssignmentsRequest,
  parseServiceAssignmentProjectionDelivery,
} from "../src/worker/project-alpha-service-assignments";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const fixture = JSON.parse(readFileSync(new URL("../../../packages/shared/fixtures/project-alpha-service-assignments-v1.json",
  import.meta.url), "utf8")) as {
    schemaVersion: number;
    requiredCapability: string;
    pageHash: string;
    snapshotHash: string;
    snapshotPage: Record<string, unknown> & { items: Array<Record<string, unknown>> };
    snapshotActivate: Record<string, unknown>;
    tombstoneEvent: Record<string, unknown>;
  };
const applicationKey = "alpha_a";
const keyId = "portal-primary-v1";
const secret = "service-assignment-test-secret-at-least-thirty-two-bytes";
const path = "/api/internal/project-alpha/service-assignments-v1";
const sourceId = "project-alpha:primary";
const workspaceId = "service-assignment-workspace";
const access = async () => undefined;

async function digest(body: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function signature(body: string, timestamp: string, deliveryId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = new TextEncoder().encode(`${timestamp}\nPOST\n${path}\n${keyId}\n${deliveryId}\n`);
  const raw = new TextEncoder().encode(body), message = new Uint8Array(prefix.length + raw.length);
  message.set(prefix); message.set(raw, prefix.length);
  return `sha256=${[...new Uint8Array(await crypto.subtle.sign("HMAC", key, message))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
async function snapshotDigest(items: unknown[]): Promise<string> {
  const pageHash = await digest(JSON.stringify({ schemaVersion: 1, items }));
  return digest(JSON.stringify({ schemaVersion: 1, pageCount: 1, itemCount: items.length,
    pages: [{ pageNumber: 1, itemCount: items.length, pageHash }] }));
}
function envelope(kind: string, deliveryId: string, sourceGeneration: string, sourceSequence: number,
  extra: Record<string, unknown>) {
  return { schemaVersion: 1, applicationKey, deliveryId, occurredAt: "2026-08-27T12:00:00.000Z",
    sourceGeneration, sourceSequence, kind, ...extra };
}

describe("Project Alpha service-assignment v1 fixture", () => {
  it("is the exact producer contract and has no receiver-only workspace field", async () => {
    expect(fixture.requiredCapability).toBe("portal.service-assignments.publish");
    expect(await digest(JSON.stringify({ schemaVersion: 1, items: fixture.snapshotPage.items }))).toBe(fixture.pageHash);
    expect(parseServiceAssignmentProjectionDelivery(fixture.snapshotPage, applicationKey)).toEqual(fixture.snapshotPage);
    expect(parseServiceAssignmentProjectionDelivery(fixture.snapshotActivate, applicationKey)).toEqual(fixture.snapshotActivate);
    expect(parseServiceAssignmentProjectionDelivery(fixture.tombstoneEvent, applicationKey)).toEqual(fixture.tombstoneEvent);
    expect(() => parseServiceAssignmentProjectionDelivery({ ...fixture.snapshotPage,
      items: [{ ...fixture.snapshotPage.items[0], workspacePublicId: workspaceId }] }, applicationKey))
      .toThrow("service-assignment-item-fields-invalid");
  });
});

describe("Project Alpha service-assignment receiver", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  let databaseIndex = 0;

  beforeAll(() => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: Object.fromEntries(Array.from({ length: 11 }, (_, index) =>
        [`TEST_DB_${index}`, `service-assignment-test-${index}`])) });
  });

  beforeEach(async () => {
    db = await runtime.getD1Database(`TEST_DB_${databaseIndex++}`) as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)
      && name <= "0168_project_alpha_service_assignments.sql").sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    await seedWorkspace(workspaceId, "project-shared");
    env = { DELIVERY_DB: db, PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED: "true",
      PROJECT_ALPHA_PORTAL_APPLICATION_KEY: applicationKey, PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: keyId,
      PROJECT_ALPHA_PORTAL_HMAC_SECRET: secret } as Env;
  }, 60_000);

  afterAll(async () => runtime.dispose());

  async function seedWorkspace(id: string, projectId: string) {
    const generationId = `directory-${id}`;
    await db.batch([
      db.prepare(`INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
        VALUES(?,?,?)`).bind(id, sourceId, `source-${id}`),
      db.prepare(`INSERT INTO portal_v2_workspaces
        (id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES(?,'organization',?,?, 'active',?)`).bind(id, `organization-${id}`, id, sourceId),
      db.prepare(`INSERT INTO portal_v2_directory_generations
        (id,workspace_id,source_generation,source_sequence,status,complete)
        VALUES(?,?,?,1,'active',1)`).bind(generationId, id, `generation-${id}`),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES(?,?,'project',?,?,'directory-v1',1)`).bind(id, generationId, projectId, projectId),
      db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence)
        VALUES(?,?,1)`).bind(id, generationId),
    ]);
  }

  async function admit(id = workspaceId) {
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO pa_service_assignment_receiver_grants
        (source_id,capability,contract_version,state,created_by)
        VALUES(?,'portal.service-assignments.publish',1,'active','test')`).bind(sourceId),
      db.prepare(`INSERT OR IGNORE INTO pa_service_assignment_receiver_workspaces(source_id,workspace_id,state,created_by)
        VALUES(?,?,'active','test')`).bind(sourceId, id),
    ]);
  }

  async function deliver(payload: Record<string, unknown>, verifier = access, deliveryEnv = env) {
    const body = JSON.stringify(payload), timestamp = new Date().toISOString();
    return handleProjectAlphaServiceAssignmentsRequest(new Request(`https://client.test${path}`, { method: "POST", body,
      headers: { "Content-Type": "application/json", "X-Portal-Integration-Application-Key": applicationKey,
        "X-Portal-Integration-Timestamp": timestamp, "X-Portal-Integration-Body-SHA256": await digest(body),
        "X-Portal-Integration-Key-Id": keyId, "X-Portal-Integration-Delivery-Id": String(payload.deliveryId),
        "X-Portal-Integration-Signature": await signature(body, timestamp, String(payload.deliveryId)) } }), deliveryEnv, verifier);
  }

  function withReceiverBatchInterleaving(hook: () => Promise<void>): Env {
    let sessionNumber = 0;
    const deliveryDatabase = new Proxy(db, {
      get(target, property) {
        if (property !== "withSession") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (constraint?: D1SessionBookmark | D1SessionConstraint) => {
          const session = target.withSession(constraint);
          sessionNumber += 1;
          if (sessionNumber !== 2) return session;
          let interleaved = false;
          return new Proxy(session, {
            get(sessionTarget, sessionProperty) {
              if (sessionProperty !== "batch") {
                const value = Reflect.get(sessionTarget, sessionProperty, sessionTarget);
                return typeof value === "function" ? value.bind(sessionTarget) : value;
              }
              return async (statements: D1PreparedStatement[]) => {
                if (!interleaved) { interleaved = true; await hook(); }
                return sessionTarget.batch(statements);
              };
            },
          });
        };
      },
    });
    return { ...env, DELIVERY_DB: deliveryDatabase };
  }

  async function activateFixture() {
    expect((await deliver(fixture.snapshotPage)).status).toBe(200);
    expect((await deliver(fixture.snapshotActivate)).status).toBe(200);
  }

  it("is default-off and an empty snapshot cannot bypass the default-empty workspace allowlist", async () => {
    env.PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED = "false";
    expect((await deliver(fixture.snapshotPage)).status).toBe(404);
    env.PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED = "true";
    expect((await deliver(fixture.snapshotPage)).status).toBe(404);
    await db.prepare(`INSERT INTO pa_service_assignment_receiver_grants
      (source_id,capability,contract_version,state,created_by)
      VALUES(?,'portal.service-assignments.publish',1,'active','test')`).bind(sourceId).run();
    const snapshotHash = await snapshotDigest([]);
    const empty = envelope("snapshot.page", "empty-without-workspace", "empty-generation", 1,
      { snapshotHash, pageNumber: 1, pageCount: 1, itemCount: 0, items: [] });
    expect((await deliver(empty)).status).toBe(404);
    expect(await db.prepare("SELECT count(*) n FROM pa_service_assignment_generations").first<number>("n")).toBe(0);
  });

  it("rejects an Access assertion without writing capability, receipt, or staging state", async () => {
    await admit();
    const response = await deliver(fixture.snapshotPage, async () => { throw new Error("access assertion rejected"); });
    expect(response.status).toBe(401);
    for (const table of ["pa_service_assignment_source_capabilities", "pa_service_assignment_projection_receipts",
      "pa_service_assignment_generations"]) {
      expect(await db.prepare(`SELECT count(*) n FROM ${table}`).first<number>("n")).toBe(0);
    }
  });

  it("reports a partial receiver schema as unavailable without exposing D1 details", async () => {
    await db.prepare("DROP TABLE pa_service_assignment_receiver_workspaces").run();
    const response = await deliver(fixture.snapshotPage);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service-assignment-internal-error" });
  });

  it("contains each subject and rejects missing or ambiguous allowed-workspace ownership", async () => {
    await admit();
    expect((await deliver(fixture.snapshotPage)).status).toBe(200);
    const disallowedItem = { ...fixture.snapshotPage.items[0], assignmentPublicId: "assignment-outside",
      subjectPublicId: "project-outside" };
    const disallowedHash = await snapshotDigest([disallowedItem]);
    expect((await deliver(envelope("snapshot.page", "outside-page", "outside-generation", 2,
      { snapshotHash: disallowedHash, pageNumber: 1, pageCount: 1, itemCount: 1, items: [disallowedItem] }))).status).toBe(403);
    await seedWorkspace("duplicate-workspace", "project-shared");
    await admit("duplicate-workspace");
    const ambiguousItem = { ...fixture.snapshotPage.items[0], assignmentPublicId: "assignment-ambiguous" };
    const ambiguousHash = await snapshotDigest([ambiguousItem]);
    expect((await deliver(envelope("snapshot.page", "ambiguous-page", "ambiguous-generation", 2,
      { snapshotHash: ambiguousHash, pageNumber: 1, pageCount: 1, itemCount: 1, items: [ambiguousItem] }))).status).toBe(403);
  });

  it("activates the PA fixture, enforces ordering, accepts a valid tombstone, and protects replay", async () => {
    await admit();
    await activateFixture();
    const gapItem = { ...fixture.snapshotPage.items[0], sourceVersion: "assignment-gap-v2" };
    const gap = envelope("event", "gap-event", String(fixture.snapshotPage.sourceGeneration), 4,
      { event: { action: "upsert", item: gapItem } });
    expect((await deliver(gap)).status).toBe(409);
    expect((await deliver(fixture.tombstoneEvent)).status).toBe(200);
    expect(await (await deliver(fixture.tombstoneEvent)).json()).toMatchObject({ status: "duplicate" });
    const conflictingReplay = { ...fixture.tombstoneEvent,
      event: { ...(fixture.tombstoneEvent.event as Record<string, unknown>), sourceVersion: "different-version" } };
    expect((await deliver(conflictingReplay)).status).toBe(409);
    const unknown = envelope("event", "never-seen-tombstone", String(fixture.snapshotPage.sourceGeneration), 3,
      { event: { action: "tombstone", assignmentPublicId: "assignment-never-seen", sourceVersion: "missing-v1" } });
    expect((await deliver(unknown)).status).toBe(422);
    expect(await db.prepare("SELECT source_sequence FROM pa_service_assignment_checkpoints WHERE source_id=?")
      .bind(sourceId).first<number>("source_sequence")).toBe(2);
    expect(await db.prepare(`SELECT active FROM pa_service_assignment_entity_state
      WHERE source_id=? AND assignment_public_id='assignment-shared'`).bind(sourceId).first<number>("active")).toBe(0);
  }, 30_000);

  it("revalidates every staged subject when activation occurs", async () => {
    await admit();
    expect((await deliver(fixture.snapshotPage)).status).toBe(200);
    await db.prepare(`UPDATE pa_service_assignment_receiver_workspaces SET state='suspended'
      WHERE source_id=? AND workspace_id=?`).bind(sourceId, workspaceId).run();
    expect((await deliver(fixture.snapshotActivate)).status).toBe(404);
    expect(await db.prepare(`SELECT status FROM pa_service_assignment_generations
      WHERE source_id=? AND source_generation=?`).bind(sourceId, fixture.snapshotPage.sourceGeneration)
      .first<string>("status")).toBe("staging");
  });

  it.each(["snapshot page", "snapshot activation", "event upsert", "tombstone"] as const)(
    "atomically rolls back %s when a second matching workspace appears after preflight",
    async operation => {
      await admit();
      let payload: Record<string, unknown> = fixture.snapshotPage;
      if (operation === "snapshot activation") {
        expect((await deliver(fixture.snapshotPage)).status).toBe(200);
        payload = fixture.snapshotActivate;
      } else if (operation === "event upsert" || operation === "tombstone") {
        await activateFixture();
        payload = operation === "tombstone" ? fixture.tombstoneEvent
          : envelope("event", "interleaved-upsert", String(fixture.snapshotPage.sourceGeneration), 2, {
            event: { action: "upsert", item: { ...fixture.snapshotPage.items[0],
              assignmentPublicId: "assignment-interleaved", sourceVersion: "assignment-interleaved-v1" } },
          });
      }
      const raceWorkspace = `race-${operation.replaceAll(" ", "-")}`;
      const raceEnv = withReceiverBatchInterleaving(async () => {
        await seedWorkspace(raceWorkspace, "project-shared");
        await admit(raceWorkspace);
      });
      const response = await deliver(payload, access, raceEnv);
      expect(response.status).toBe(409);
      expect(await db.prepare(`SELECT count(*) n FROM pa_service_assignment_projection_receipts
        WHERE source_id=? AND delivery_id=?`).bind(sourceId, payload.deliveryId).first<number>("n")).toBe(0);
      if (operation === "snapshot page") {
        expect(await db.prepare("SELECT count(*) n FROM pa_service_assignment_generations WHERE source_id=?")
          .bind(sourceId).first<number>("n")).toBe(0);
        expect(await db.prepare("SELECT count(*) n FROM pa_service_assignment_source_capabilities WHERE source_id=?")
          .bind(sourceId).first<number>("n")).toBe(0);
      } else if (operation === "snapshot activation") {
        expect(await db.prepare(`SELECT status FROM pa_service_assignment_generations
          WHERE source_id=? AND source_generation=?`).bind(sourceId, fixture.snapshotPage.sourceGeneration)
          .first<string>("status")).toBe("staging");
        expect(await db.prepare("SELECT count(*) n FROM pa_service_assignment_checkpoints WHERE source_id=?")
          .bind(sourceId).first<number>("n")).toBe(0);
      } else {
        expect(await db.prepare("SELECT source_sequence FROM pa_service_assignment_checkpoints WHERE source_id=?")
          .bind(sourceId).first<number>("source_sequence")).toBe(1);
        expect(await db.prepare(`SELECT active FROM pa_service_assignment_entity_state
          WHERE source_id=? AND assignment_public_id='assignment-shared'`).bind(sourceId).first<number>("active")).toBe(1);
        if (operation === "event upsert") {
          expect(await db.prepare(`SELECT count(*) n FROM pa_service_assignment_entity_state
            WHERE source_id=? AND assignment_public_id='assignment-interleaved'`).bind(sourceId).first<number>("n")).toBe(0);
        }
      }
    }, 30_000);

  it("bounds abandoned staged generations per source", async () => {
    const statements = Array.from({ length: 8 }, (_, index) => db.prepare(`INSERT INTO pa_service_assignment_generations
      (id,source_id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status)
      VALUES(?,?,?,?,?,1,0,'staging')`).bind(`staging-${index}`, sourceId, `staging-generation-${index}`,
        index + 1, "a".repeat(64)));
    await db.batch(statements);
    await expect(db.prepare(`INSERT INTO pa_service_assignment_generations
      (id,source_id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status)
      VALUES('staging-9',?,'staging-generation-9',9,?,1,0,'staging')`).bind(sourceId, "b".repeat(64)).run())
      .rejects.toThrow("service-assignment-staging-capacity");
  });
});
