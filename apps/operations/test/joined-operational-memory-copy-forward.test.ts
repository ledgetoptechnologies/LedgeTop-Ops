import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { saveOrganizationOperationalContacts } from "../src/worker/organization-operational-contacts";
import { readProjectMemoryRevision, readProjectOperationalWorkspace, saveProjectMemory, saveProjectOperationalContacts,
  type ProjectMemorySnapshot } from "../src/worker/project-operational-memory";
import { commitRecurringProjectCopy, previewRecurringProjectCopy,
  type PreviewRecurringProjectCopyInput } from "../src/worker/project-recurring-copy-forward";
import { uploadProjectMemoryAttachment } from "../src/worker/project-memory-attachments";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const SOURCE = "project-alpha:primary", TIMEOUT = 60_000;
const owner: StaffPrincipal = { id: "staff-beau-koltz", email: "beaukoltz@ledgetopdroneservices.com",
  displayName: "Beau Koltz", accessSubject: "owner", projectAlphaUserId: null };
class Bucket {
  objects = new Map<string, { bytes: Uint8Array; etag: string; size: number; customMetadata: Record<string, string>; httpMetadata: R2HTTPMetadata | Headers }>();
  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, options?: R2PutOptions) {
    const bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value)
      : new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
    const item = { bytes, etag: `etag-${crypto.randomUUID()}`, size: bytes.byteLength,
      customMetadata: options?.customMetadata ?? {}, httpMetadata: options?.httpMetadata ?? {} };
    this.objects.set(key, item); return item as unknown as R2Object;
  }
  async head(key: string) { return (this.objects.get(key) ?? null) as unknown as R2Object | null; }
  async delete(key: string) { this.objects.delete(key); }
}
let runtime: Miniflare, db: D1Database, env: Pick<Env, "OPS_DB" | "DATA_BUCKET">, sequence = 0;
const key = () => `joined_j3_${crypto.randomUUID()}`;
const memory = (values: Partial<ProjectMemorySnapshot> = {}): ProjectMemorySnapshot => ({ plan: "", actualOutcome: "",
  deviationsAndReasons: "", observations: "", problems: "", successes: "", recommendations: "", nextTimeRequests: "", ...values });

interface Fixture { context: ClientHubCollectionContext; rootId: string; contactId: string; sourceProjectId: string; destinationProjectId: string }
async function fixture(): Promise<Fixture> {
  const n = ++sequence, rootId = `joined-org-${n}`, contactId = `joined-contact-${n}`,
    sourceProjectId = `joined-source-${n}`, destinationProjectId = `joined-destination-${n}`;
  for (const [kind, id] of [["organization", rootId], ["client", contactId], ["project", sourceProjectId], ["project", destinationProjectId]])
    await db.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,?,?,?)")
      .bind(SOURCE, kind, id, id).run();
  await db.batch([
    db.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,1,'{}',?,?)")
      .bind(rootId, `Joined Organization ${n}`, `root-sync-${n}`, SOURCE),
    db.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,1,?,?,?)")
      .bind(contactId, `Joined Contact ${n}`, rootId, JSON.stringify({ email: `contact-${n}@example.test` }), `contact-sync-${n}`, SOURCE),
    db.prepare(`INSERT INTO pa_projects(id,organization_id,name,status,active,payload_json,last_sync_id,projection_source_id)
      VALUES(?,?,'Prior project','completed',1,?, ?, ?)`).bind(sourceProjectId, rootId,
        JSON.stringify({ billing: { rate: 125, invoiceStatus: "paid" } }), `source-sync-${n}`, SOURCE),
    db.prepare(`INSERT INTO pa_projects(id,organization_id,name,status,active,payload_json,last_sync_id,projection_source_id)
      VALUES(?,?,'Already created next project','not_started',1,?, ?, ?)`).bind(destinationProjectId, rootId,
        JSON.stringify({ billing: { rate: 150, invoiceStatus: "draft" } }), `destination-sync-${n}`, SOURCE),
  ]);
  return { rootId, contactId, sourceProjectId, destinationProjectId,
    context: { root: { source_id: SOURCE, root_namespace: "business", kind: "organization", public_id: rootId,
      pa_public_id: rootId, mapping_status: "mapped", display_name: `Joined Organization ${n}`, source_name: "Project Alpha",
      sort_name: `joined organization ${n}`, status: "active", portal_status: "none", workspace_id: null, legacy_account_id: null,
      account_count: 0, project_count: 2, request_count: 0, contact_count: 1, meaningful_activity_at: null,
      source_version: `root-sync-${n}`, indexed_at: "2026-09-02T00:00:00.000Z", scan_generation: 1 },
      access: { directory: true, requests: false, delivery: false, viewer: false }, contextVersion: "j".repeat(43),
      canonicalRoot: { sourceId: SOURCE, rootNamespace: "business", kind: "organization", publicId: rootId } } };
}

async function protectedRows() {
  const result: Record<string, unknown> = {};
  for (const table of ["pa_application_entitlements", "invitation_review_authorizations", "viewer_processing_notification_outbox"])
    result[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  return result;
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
    script: "export default {fetch(){return new Response('joined-j3')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database; env = { OPS_DB: db, DATA_BUCKET: new Bucket() as unknown as R2Bucket };
  const migrations = new URL("../migrations/", import.meta.url);
  // The operational reader is deployed only after the reassignment recovery
  // boundary, so this joined fixture must exercise that same schema rather
  // than an obsolete pre-0052 partial database.
  for (const filename of readdirSync(migrations).filter(name => name.endsWith(".sql") && name <= "0052_project_operational_reassignment_recovery.sql").sort())
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(filename, migrations), "utf8")).map(sql => db.prepare(sql)));
}, 120_000);
afterAll(async () => runtime?.dispose());

describe("J3 joined operational history and recurring copy-forward", () => {
  it("copies only reviewed contacts and memory while all authority and nonselected state remain fixed", async () => {
    const item = await fixture();
    await saveOrganizationOperationalContacts(env, owner, item.context, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 0, idempotencyKey: key(), assignments: [{ contactId: item.contactId, role: "primary_operational" }] });
    await saveProjectOperationalContacts(env, owner, item.context, item.sourceProjectId, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 0, idempotencyKey: key(), assignments: [{ contactId: item.contactId, role: "project_contact",
        preferredContactMethod: "email", instructions: "Use the east entrance" }] });
    await saveProjectMemory(env, owner, item.context, item.sourceProjectId, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 0, idempotencyKey: key(), memory: memory({ plan: "Original recurring plan", observations: "Original observation" }),
      amendmentReason: "Seed the completed project's reviewed record" });
    await saveProjectMemory(env, owner, item.context, item.sourceProjectId, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 1, idempotencyKey: key(), memory: memory({ plan: "Final recurring plan", observations: "Keep this observation",
        actualOutcome: "Completed successfully", recommendations: "Use this setup next month" }),
      amendmentReason: "Client confirmed the final recurring procedure" });
    await expect(saveProjectMemory(env, owner, item.context, item.sourceProjectId, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 1, idempotencyKey: key(), memory: memory({ plan: "Stale overwrite" }), amendmentReason: "Late stale edit" }))
      .rejects.toMatchObject({ status: 409 });

    expect((await readProjectMemoryRevision(env, owner, item.context, item.sourceProjectId, 1, item.context.contextVersion)).revision)
      .toMatchObject({ version: 1, snapshot: { plan: "Original recurring plan" } });
    expect((await readProjectMemoryRevision(env, owner, item.context, item.sourceProjectId, 2, item.context.contextVersion)).revision)
      .toMatchObject({ version: 2, changeKind: "post_completion_amendment", snapshot: { plan: "Final recurring plan" } });

    const attachmentBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd9]);
    await uploadProjectMemoryAttachment(env, owner, item.context, item.sourceProjectId,
      new Request("https://ops.example.test/upload", { method: "POST", headers: { "Content-Type": "image/jpeg",
        "X-Expected-Context-Version": item.context.contextVersion, "X-Expected-Version": "2", "X-Idempotency-Key": key(),
        "X-File-Name": encodeURIComponent("source-only.jpg"), "X-Amendment-Reason": "Attach final field evidence" }, body: attachmentBytes }));
    const projectRowsBefore = (await db.prepare("SELECT id,organization_id,status,active,payload_json,last_sync_id FROM pa_projects WHERE id IN (?,?) ORDER BY id")
      .bind(item.sourceProjectId, item.destinationProjectId).all()).results;
    const protectedBefore = await protectedRows();
    const organizationContactsBefore = (await db.prepare("SELECT * FROM organization_operational_contact_assignments ORDER BY rowid").all()).results;
    const sourceWorkspace = await readProjectOperationalWorkspace(env, owner, item.context, item.sourceProjectId);
    const destinationWorkspace = await readProjectOperationalWorkspace(env, owner, item.context, item.destinationProjectId);

    const input: PreviewRecurringProjectCopyInput = { expectedContextVersion: item.context.contextVersion,
      sourceProjectId: item.sourceProjectId, destinationProjectId: item.destinationProjectId,
      selectedContactRoles: ["project_contact"], selectedMemorySections: ["plan", "observations"], conflictPolicy: "keep_destination",
      expected: { sourceProjectRevision: sourceWorkspace.project.revision, destinationProjectRevision: destinationWorkspace.project.revision,
        sourceContactsVersion: sourceWorkspace.contacts.version, destinationContactsVersion: destinationWorkspace.contacts.version,
        sourceMemoryVersion: sourceWorkspace.memory.version, destinationMemoryVersion: destinationWorkspace.memory.version } };
    const preview = await previewRecurringProjectCopy(env, owner, item.context, input);
    expect(preview.changes).toMatchObject({ copiedContacts: 1, copiedMemorySections: ["observations", "plan"] });
    await commitRecurringProjectCopy(env, owner, item.context, { ...input, previewFingerprint: preview.fingerprint, idempotencyKey: key() });

    const destination = await readProjectOperationalWorkspace(env, owner, item.context, item.destinationProjectId);
    expect(destination.contacts.assignments).toHaveLength(1);
    expect(destination.contacts.assignments[0]).toMatchObject({ contact: { id: item.contactId }, role: "project_contact", instructions: "Use the east entrance" });
    expect(destination.memory.snapshot).toMatchObject({ plan: "Final recurring plan", observations: "Keep this observation",
      actualOutcome: "", recommendations: "" });
    expect(destination.memory.attachments).toEqual([]);
    expect(await db.prepare("SELECT count(*) count FROM project_memory_attachments WHERE project_id=?").bind(item.destinationProjectId).first("count")).toBe(0);
    expect(await protectedRows()).toEqual(protectedBefore);
    expect((await db.prepare("SELECT * FROM organization_operational_contact_assignments ORDER BY rowid").all()).results).toEqual(organizationContactsBefore);
    expect((await db.prepare("SELECT id,organization_id,status,active,payload_json,last_sync_id FROM pa_projects WHERE id IN (?,?) ORDER BY id")
      .bind(item.sourceProjectId, item.destinationProjectId).all()).results).toEqual(projectRowsBefore);

    const reassigned = await fixture();
    await saveProjectMemory(env, owner, reassigned.context, reassigned.sourceProjectId, { expectedContextVersion: reassigned.context.contextVersion,
      expectedVersion: 0, idempotencyKey: key(), memory: memory({ plan: "Must not cross owners" }), amendmentReason: "Seed terminal source" });
    const raceInput: PreviewRecurringProjectCopyInput = { expectedContextVersion: reassigned.context.contextVersion,
      sourceProjectId: reassigned.sourceProjectId, destinationProjectId: reassigned.destinationProjectId,
      selectedContactRoles: [], selectedMemorySections: ["plan"], conflictPolicy: "keep_destination",
      expected: { sourceProjectRevision: `source-sync-${sequence}`, destinationProjectRevision: `destination-sync-${sequence}`,
        sourceContactsVersion: 0, destinationContactsVersion: 0, sourceMemoryVersion: 1, destinationMemoryVersion: 0 } };
    const racePreview = await previewRecurringProjectCopy(env, owner, reassigned.context, raceInput);
    await db.prepare("UPDATE pa_projects SET organization_id=?,last_sync_id=last_sync_id||'-reassigned' WHERE id=?")
      .bind(item.rootId, reassigned.destinationProjectId).run();
    await expect(commitRecurringProjectCopy(env, owner, reassigned.context, { ...raceInput,
      previewFingerprint: racePreview.fingerprint, idempotencyKey: key() })).rejects.toMatchObject({ status: 404 });
    expect(await db.prepare("SELECT count(*) count FROM project_operational_copy_receipts WHERE destination_project_id=?")
      .bind(reassigned.destinationProjectId).first("count")).toBe(0);
  }, TIMEOUT);
});
