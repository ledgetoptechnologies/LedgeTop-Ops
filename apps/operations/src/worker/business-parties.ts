import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import type { Env, StaffPrincipal } from "./types";

type Environment = Pick<Env, "OPS_DB">;
type Database = Pick<D1Database, "prepare" | "batch">;
const scalar = (maximum: number) => z.string().min(1).max(maximum).regex(/^[^\u0000-\u001f\u007f]+$/);
const identifier = scalar(128);
export const businessPartyRootSchema = z.object({ sourceId: z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/),
  kind: z.enum(["organization", "standalone_client"]), recordId: scalar(512) }).strict();
const displayName = scalar(160).transform(value => value.normalize("NFC").trim()).refine(value => value.length > 0);
export const businessPartyOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), displayName, roots: z.array(businessPartyRootSchema).min(2).max(32) }).strict(),
  z.object({ action: z.literal("add"), partyId: identifier, expectedVersion: z.number().int().positive().safe(), root: businessPartyRootSchema }).strict(),
  z.object({ action: z.literal("unlink"), partyId: identifier, expectedVersion: z.number().int().positive().safe(), linkId: identifier }).strict(),
]);
export const businessPartyMutationSchema = z.object({ operation: businessPartyOperationSchema,
  previewContextVersion: z.string().regex(/^[0-9a-f]{64}$/), idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict();
export type BusinessPartyRoot = z.infer<typeof businessPartyRootSchema>;
export type BusinessPartyOperation = z.infer<typeof businessPartyOperationSchema>;
export interface BusinessPartyMember {
  linkId: string | null; root: BusinessPartyRoot; displayName: string; sourceName: string;
  detailPath: string | null; availability: "available" | "unavailable";
}
export interface BusinessPartyPreview {
  action: BusinessPartyOperation["action"]; partyId: string | null; partyVersion: number | null;
  displayName: string; kind: BusinessPartyRoot["kind"]; members: BusinessPartyMember[];
  removedMember: BusinessPartyMember | null; contextVersion: string;
}
interface PartyRow { id: string; kind: BusinessPartyRoot["kind"]; display_name: string; sort_name: string; status: "active" | "closed"; version: number }
interface LinkRow { id: string; party_id: string; source_id: string; record_kind: "organization" | "client"; record_id: string; unlinked_at: string | null }
interface RootFact {
  root: BusinessPartyRoot; externalId: string; name: string | null; sourceName: string;
  requireLive: boolean; linkId: string | null;
}
interface Policy { canRead: boolean; canManage: boolean; actorId: string }
interface Prepared {
  operation: BusinessPartyOperation; party: PartyRow | null; links: LinkRow[]; facts: RootFact[];
  epoch: number; policy: Policy; preview: BusinessPartyPreview;
}
const unavailable = (): never => { throw new HTTPException(404, { message: "Business party or source record is unavailable" }); };
const changed = (): never => { throw new HTTPException(409, { message: "Business links changed. Refresh and review the preview again." }); };
const rootKey = (root: BusinessPartyRoot) => JSON.stringify([root.sourceId, root.kind, root.recordId]);
const recordKind = (kind: BusinessPartyRoot["kind"]) => kind === "organization" ? "organization" : "client";
const linkRoot = (link: LinkRow): BusinessPartyRoot => ({ sourceId: link.source_id,
  kind: link.record_kind === "organization" ? "organization" : "standalone_client", recordId: link.record_id });
const sourcePath = (root: BusinessPartyRoot) => `/clients/sources/${encodeURIComponent(root.sourceId)}/business/${root.kind === "organization" ? "organizations" : "standalone"}/${encodeURIComponent(root.recordId)}`;
function db(env: Environment): Database { return env.OPS_DB.withSession("first-primary"); }
async function digest(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function globalPermission(permission: "team.view" | "team.manage"): string {
  return `((EXISTS(SELECT 1 FROM staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
      WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key='${permission}')
    OR EXISTS(SELECT 1 FROM local_staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
      WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key='${permission}')
    OR EXISTS(SELECT 1 FROM staff_permission_overrides permission WHERE permission.staff_id=actor.id
      AND permission.permission_key='${permission}' AND permission.scope='global' AND permission.effect='allow'))
    AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides permission WHERE permission.staff_id=actor.id
      AND permission.permission_key='${permission}' AND permission.scope='global' AND permission.effect='deny'))`;
}
const adminSql = `EXISTS(SELECT 1 FROM staff_role_assignments assignment WHERE assignment.staff_id=actor.id
  AND assignment.scope='global' AND assignment.role_id IN ('role-owner','role-admin'))`;
const manageSql = `${globalPermission("team.view")} AND ${globalPermission("team.manage")} AND ${adminSql}`;
async function policy(database: Database, principal: StaffPrincipal, manage = false): Promise<Policy> {
  const row = await database.prepare(`SELECT ${globalPermission("team.view")} can_read,(${manageSql}) can_manage
    FROM staff_users actor WHERE actor.id=? AND actor.status='active'`).bind(principal.id).first<{ can_read: number; can_manage: number }>();
  if (!row?.can_read || (manage && !row.can_manage)) throw new HTTPException(403, { message: manage
    ? "Administrator and global team.manage/team.view permissions required" : "Global team.view permission required" });
  return { canRead: true, canManage: row.can_manage === 1, actorId: principal.id };
}

/** Readability only, never a grant. Callers separately enforce current staff ACL.
 * Fixed identifiers only; no dependency on the rebuildable directory cache. */
export function readableBusinessPartySql(partyIdSql: string): string {
  if (!/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/.test(partyIdSql)) throw new Error("invalid-business-party-column");
  return `EXISTS(SELECT 1 FROM business_parties readable_party WHERE readable_party.id=${partyIdSql} AND readable_party.status='active'
    AND EXISTS(SELECT 1 FROM business_party_links member WHERE member.party_id=readable_party.id AND member.unlinked_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM business_party_links member WHERE member.party_id=readable_party.id AND member.unlinked_at IS NULL
      AND (NOT ${projectAlphaReadVisibleSql("member.source_id")} OR NOT (
        (member.record_kind='organization' AND EXISTS(SELECT 1 FROM pa_organizations organization WHERE organization.id=member.record_id
          AND organization.projection_source_id=member.source_id AND organization.active=1))
        OR (member.record_kind='client' AND EXISTS(SELECT 1 FROM pa_clients client WHERE client.id=member.record_id
          AND client.projection_source_id=member.source_id AND client.active=1 AND client.organization_id IS NULL))))))`;
}
async function epoch(database: Database): Promise<number> {
  const value = await database.prepare("SELECT read_revision FROM pa_connector_directory_state WHERE id='directory'").first<number>("read_revision");
  if (value === null || !Number.isSafeInteger(value) || value < 1) throw new HTTPException(503, { message: "Business source visibility is not ready" });
  return value;
}
async function partyRows(database: Database, id: string): Promise<{ party: PartyRow; links: LinkRow[] }> {
  if (!identifier.safeParse(id).success) return unavailable();
  const party = await database.prepare("SELECT id,kind,display_name,sort_name,status,version FROM business_parties WHERE id=?").bind(id).first<PartyRow>();
  if (!party) return unavailable();
  const links = (await database.prepare(`SELECT id,party_id,source_id,record_kind,record_id,unlinked_at FROM business_party_links
    WHERE party_id=? AND unlinked_at IS NULL ORDER BY source_id,record_kind,record_id LIMIT 33`).bind(id).all<LinkRow>()).results;
  if (links.length > 32) throw new HTTPException(503, { message: "Business party requires administrative review" });
  return { party, links };
}
async function rootFacts(database: Database, roots: BusinessPartyRoot[], links: LinkRow[], allowUnavailable?: string | ReadonlySet<string>): Promise<RootFact[]> {
  if (!roots.length) return [];
  const rows = (await database.prepare(`WITH wanted AS (SELECT json_extract(value,'$.sourceId') source_id,
    json_extract(value,'$.kind') kind,json_extract(value,'$.recordId') record_id FROM json_each(?))
    SELECT wanted.source_id,wanted.kind,wanted.record_id,mapping.external_id,
      CASE WHEN wanted.kind='organization' AND organization.active=1 THEN organization.name
        WHEN wanted.kind='standalone_client' AND client.active=1 AND client.organization_id IS NULL THEN client.name END name,
      COALESCE(connector.display_name,'Project Alpha') source_name
    FROM wanted JOIN pa_projection_record_ids mapping ON mapping.projection_source_id=wanted.source_id
      AND mapping.local_id=wanted.record_id AND mapping.record_kind=CASE wanted.kind WHEN 'organization' THEN 'organization' ELSE 'client' END
    LEFT JOIN pa_organizations organization ON wanted.kind='organization' AND organization.id=wanted.record_id AND organization.projection_source_id=wanted.source_id
    LEFT JOIN pa_clients client ON wanted.kind='standalone_client' AND client.id=wanted.record_id AND client.projection_source_id=wanted.source_id
    LEFT JOIN pa_connectors connector ON connector.source_id=wanted.source_id
    WHERE ${projectAlphaReadVisibleSql("wanted.source_id")}
    ORDER BY wanted.source_id,wanted.kind,wanted.record_id`).bind(JSON.stringify(roots))
    .all<{ source_id: string; kind: BusinessPartyRoot["kind"]; record_id: string; external_id: string; name: string | null; source_name: string }>()).results;
  if (rows.length !== roots.length) return unavailable();
  return rows.map(row => {
    const root = { sourceId: row.source_id, kind: row.kind, recordId: row.record_id };
    const link = links.find(candidate => rootKey(linkRoot(candidate)) === rootKey(root));
    const requireLive = !(link && (typeof allowUnavailable === "string" ? link.id === allowUnavailable : allowUnavailable?.has(link.id)));
    if (requireLive && row.name === null) return unavailable();
    return { root, externalId: row.external_id, name: row.name, sourceName: row.source_name, requireLive, linkId: link?.id ?? null };
  });
}
function member(fact: RootFact): BusinessPartyMember {
  return { linkId: fact.linkId, root: fact.root, displayName: fact.name ?? "Unavailable source record", sourceName: fact.sourceName,
    detailPath: fact.name === null ? null : sourcePath(fact.root), availability: fact.name === null ? "unavailable" : "available" };
}
function canonical(operation: BusinessPartyOperation): BusinessPartyOperation {
  if (operation.action !== "create") return operation;
  return { ...operation, roots: [...operation.roots].sort((a, b) => rootKey(a).localeCompare(rootKey(b), "en")) };
}
async function prepare(database: Database, principal: StaffPrincipal, raw: unknown): Promise<Prepared> {
  const parsed = businessPartyOperationSchema.safeParse(raw);
  if (!parsed.success) throw new HTTPException(400, { message: "Business link operation is invalid" });
  const operation = canonical(parsed.data), currentPolicy = await policy(database, principal, true), currentEpoch = await epoch(database);
  let party: PartyRow | null = null, links: LinkRow[] = [], roots: BusinessPartyRoot[], removedId: string | undefined;
  if (operation.action === "create") roots = operation.roots;
  else {
    ({ party, links } = await partyRows(database, operation.partyId));
    if (party.status !== "active" || party.version !== operation.expectedVersion) return changed();
    roots = links.map(linkRoot);
    if (operation.action === "add") roots.push(operation.root);
    else {
      if (!links.some(link => link.id === operation.linkId)) return changed();
      removedId = operation.linkId;
    }
  }
  if (!roots.length || roots.length > 32) throw new HTTPException(409, { message: "A business party supports up to 32 source records" });
  if (new Set(roots.map(root => root.kind)).size !== 1 || (party && roots[0]?.kind !== party.kind))
    throw new HTTPException(409, { message: "Only source records of the same business kind can be linked" });
  if (new Set(roots.map(root => root.sourceId)).size !== roots.length)
    throw new HTTPException(409, { message: "Only one record from each producer can be linked to a business party" });
  const facts = await rootFacts(database, roots, links, operation.action === "unlink" ? new Set(links.map(link => link.id)) : undefined);
  // Repair only relaxes records already unavailable in this reviewed snapshot.
  // Any currently available member still must retain its live owner and name.
  for (const fact of facts) if (fact.name !== null) fact.requireLive = true;
  if (operation.action !== "unlink") {
    const additions = facts.filter(fact => fact.linkId === null).map(fact => fact.root);
    const existing = await database.prepare(`SELECT 1 found FROM business_party_links link JOIN json_each(?) wanted
      ON link.source_id=json_extract(wanted.value,'$.sourceId') AND link.record_id=json_extract(wanted.value,'$.recordId')
      AND link.record_kind=CASE json_extract(wanted.value,'$.kind') WHEN 'organization' THEN 'organization' ELSE 'client' END
      WHERE link.unlinked_at IS NULL LIMIT 1`).bind(JSON.stringify(additions)).first();
    if (existing) throw new HTTPException(409, { message: "A source record is already linked. Review its existing business party first." });
  }
  const preview: BusinessPartyPreview = { action: operation.action, partyId: party?.id ?? null, partyVersion: party?.version ?? null,
    displayName: party?.display_name ?? (operation.action === "create" ? operation.displayName : ""), kind: roots[0]!.kind,
    members: facts.filter(fact => fact.linkId !== removedId).map(member),
    removedMember: facts.find(fact => fact.linkId === removedId) ? member(facts.find(fact => fact.linkId === removedId)!) : null,
    contextVersion: await digest({ operation, party, links, facts, epoch: currentEpoch, policy: currentPolicy }) };
  return { operation, party, links, facts, epoch: currentEpoch, policy: currentPolicy, preview };
}
function currentGuard(prepared: Pick<Prepared, "facts" | "party" | "links" | "epoch" | "policy" | "operation">,
  requireManage = true): { sql: string; values: (string | number)[] } {
  const { facts, party, links, epoch: revision, policy: currentPolicy, operation } = prepared;
  const values: (string | number)[] = [currentPolicy.actorId, revision, JSON.stringify(facts)];
  let sql = `EXISTS(SELECT 1 FROM staff_users actor WHERE actor.id=? AND actor.status='active'
      AND ${requireManage ? manageSql : `${globalPermission("team.view")} AND (${manageSql})=${currentPolicy.canManage ? 1 : 0}`})
    AND EXISTS(SELECT 1 FROM pa_connector_directory_state WHERE id='directory' AND read_revision=?)
    AND NOT EXISTS(SELECT 1 FROM json_each(?) fact WHERE NOT EXISTS(
      SELECT 1 FROM pa_projection_record_ids mapping WHERE mapping.projection_source_id=json_extract(fact.value,'$.root.sourceId')
        AND mapping.record_kind=CASE json_extract(fact.value,'$.root.kind') WHEN 'organization' THEN 'organization' ELSE 'client' END
        AND mapping.local_id=json_extract(fact.value,'$.root.recordId') AND mapping.external_id=json_extract(fact.value,'$.externalId')
        AND ${projectAlphaReadVisibleSql("mapping.projection_source_id")}
        AND (json_extract(fact.value,'$.requireLive')=0 OR (
          (mapping.record_kind='organization' AND EXISTS(SELECT 1 FROM pa_organizations organization WHERE organization.id=mapping.local_id
            AND organization.projection_source_id=mapping.projection_source_id AND organization.active=1 AND organization.name=json_extract(fact.value,'$.name')))
          OR (mapping.record_kind='client' AND EXISTS(SELECT 1 FROM pa_clients client WHERE client.id=mapping.local_id
            AND client.projection_source_id=mapping.projection_source_id AND client.active=1 AND client.organization_id IS NULL AND client.name=json_extract(fact.value,'$.name')))))))`;
  if (party) {
    sql += ` AND EXISTS(SELECT 1 FROM business_parties WHERE id=? AND version=? AND status=? AND display_name=? AND sort_name=? AND kind=?)
      AND (SELECT count(*) FROM business_party_links WHERE party_id=? AND unlinked_at IS NULL)=?
      AND NOT EXISTS(SELECT 1 FROM business_party_links link WHERE link.party_id=? AND link.unlinked_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE json_extract(expected.value,'$.id')=link.id))`;
    values.push(party.id, party.version, party.status, party.display_name, party.sort_name, party.kind, party.id, links.length, party.id, JSON.stringify(links));
  }
  if (operation.action !== "unlink") {
    sql += ` AND NOT EXISTS(SELECT 1 FROM business_party_links link JOIN json_each(?) added ON link.source_id=json_extract(added.value,'$.sourceId')
      AND link.record_id=json_extract(added.value,'$.recordId') AND link.record_kind=CASE json_extract(added.value,'$.kind')
        WHEN 'organization' THEN 'organization' ELSE 'client' END WHERE link.unlinked_at IS NULL)`;
    values.push(JSON.stringify(facts.filter(fact => fact.linkId === null).map(fact => fact.root)));
  }
  return { sql, values };
}
async function verifyPrepared(database: Database, prepared: Prepared): Promise<void> {
  const guard = currentGuard(prepared);
  if (!await database.prepare(`SELECT 1 current WHERE ${guard.sql}`).bind(...guard.values).first()) return changed();
}
export async function previewBusinessParty(env: Environment, principal: StaffPrincipal, operation: unknown): Promise<BusinessPartyPreview> {
  const database = db(env), prepared = await prepare(database, principal, operation);
  await verifyPrepared(database, prepared); return prepared.preview;
}

export async function readBusinessParty(env: Environment, principal: StaffPrincipal, partyId: string) {
  const database = db(env), currentPolicy = await policy(database, principal), currentEpoch = await epoch(database);
  const { party, links } = await partyRows(database, partyId);
  if (party.status !== "active" || !links.length) return unavailable();
  const facts = await rootFacts(database, links.map(linkRoot), links, currentPolicy.canManage ? new Set(links.map(link => link.id)) : undefined);
  // Available members remain name/ownership-fenced even in repair mode. Only
  // already-unavailable members may use the redacted immutable-map proof.
  for (const fact of facts) if (fact.name !== null) fact.requireLive = true;
  const guard = currentGuard({ party, links, facts, epoch: currentEpoch, policy: currentPolicy,
    operation: { action: "unlink", partyId: party.id, expectedVersion: party.version, linkId: "read-only" } }, false);
  const stillCurrent = await database.prepare(`SELECT 1 current WHERE ${guard.sql}`).bind(...guard.values).first();
  if (!stillCurrent) return changed();
  return { id: party.id, kind: party.kind, displayName: party.display_name, version: party.version,
    status: "active" as const, members: facts.map(member), canManage: currentPolicy.canManage, needsReview: facts.some(fact => fact.name === null) };
}
export async function readBusinessPartyForRoot(env: Environment, principal: StaffPrincipal, root: BusinessPartyRoot) {
  const database = db(env); await policy(database, principal);
  const row = await database.prepare(`SELECT party.id FROM business_party_links link JOIN business_parties party ON party.id=link.party_id
    WHERE link.source_id=? AND link.record_kind=? AND link.record_id=? AND link.unlinked_at IS NULL AND party.status='active'`)
    .bind(root.sourceId, recordKind(root.kind), root.recordId).first<{ id: string }>();
  if (!row) return { businessParty: null, canManageBusinessParties: (await policy(database, principal)).canManage };
  try {
    const party = await readBusinessParty(env, principal, row.id);
    if (!party.members.some(member => rootKey(member.root) === rootKey(root) && member.availability === "available")) return changed();
    return { businessParty: { id: party.id, displayName: party.displayName, version: party.version, canManage: party.canManage, needsReview: party.needsReview },
      canManageBusinessParties: party.canManage };
  } catch (error) { if (error instanceof HTTPException && error.status === 404) return { businessParty: null,
    canManageBusinessParties: (await policy(database, principal)).canManage }; throw error; }
}
interface Receipt { fingerprint: string; party_id: string; result_version: number; result_status: "active" | "closed" }
async function receipt(database: Database, actorId: string, key: string): Promise<Receipt | null> {
  return database.prepare("SELECT fingerprint,party_id,result_version,result_status FROM business_party_mutations WHERE actor_id=? AND idempotency_key=?")
    .bind(actorId, key).first<Receipt>();
}
async function replay(database: Database, principal: StaffPrincipal, operation: BusinessPartyOperation, saved: Receipt, fingerprint: string) {
  if (saved.fingerprint !== fingerprint) throw new HTTPException(409, { message: "This operation key was already used for different business links" });
  const currentPolicy = await policy(database, principal, true), currentEpoch = await epoch(database);
  const { party, links } = await partyRows(database, saved.party_id);
  if (party.version !== saved.result_version || party.status !== saved.result_status) return changed();
  const facts = await rootFacts(database, links.map(linkRoot), links, operation.action === "unlink" ? new Set(links.map(link => link.id)) : undefined);
  if (operation.action === "unlink") {
    const removed = await database.prepare(`SELECT id,party_id,source_id,record_kind,record_id,unlinked_at FROM business_party_links
      WHERE id=? AND party_id=? AND unlinked_at IS NOT NULL`).bind(operation.linkId, saved.party_id).first<LinkRow>();
    if (!removed) return changed();
    facts.push(...await rootFacts(database, [linkRoot(removed)], [removed], removed.id));
  }
  for (const fact of facts) if (fact.name !== null) fact.requireLive = true;
  const guard = currentGuard({ operation, party, links, facts, epoch: currentEpoch, policy: currentPolicy });
  if (!await database.prepare(`SELECT 1 current WHERE ${guard.sql}`).bind(...guard.values).first()) return changed();
  return { partyId: saved.party_id, version: saved.result_version, status: saved.result_status, replayed: true };
}
export async function mutateBusinessParty(env: Environment, principal: StaffPrincipal, raw: unknown) {
  const parsed = businessPartyMutationSchema.safeParse(raw);
  if (!parsed.success) throw new HTTPException(400, { message: "Business link operation is invalid" });
  const input = parsed.data, operation = canonical(input.operation), fingerprint = await digest(operation), database = db(env);
  await policy(database, principal, true);
  const previous = await receipt(database, principal.id, input.idempotencyKey);
  if (previous) return replay(database, principal, operation, previous, fingerprint);
  let prepared: Prepared;
  try {
    prepared = await prepare(database, principal, operation);
    if (prepared.preview.contextVersion !== input.previewContextVersion) return changed();
  } catch (error) {
    // An identical concurrent request can commit after the first receipt read
    // but before preflight sees its now-linked roots or advanced party version.
    const winner = await receipt(database, principal.id, input.idempotencyKey);
    if (winner) return replay(database, principal, operation, winner, fingerprint);
    throw error;
  }
  const partyId = prepared.party?.id ?? crypto.randomUUID(), version = (prepared.party?.version ?? 0) + 1;
  const status = operation.action === "unlink" && prepared.links.length === 1 ? "closed" : "active";
  const guard = currentGuard(prepared);
  const statements = [database.prepare(`INSERT INTO business_party_write_fences(party_id,write_guard)
    VALUES(?,CASE WHEN ${guard.sql} THEN 1 ELSE 0 END) ON CONFLICT(party_id) DO UPDATE SET write_guard=excluded.write_guard`)
    .bind(partyId, ...guard.values)];
  if (operation.action === "create") statements.push(database.prepare(`INSERT INTO business_parties(id,kind,display_name,sort_name,created_by,updated_by)
    VALUES(?,?,?,?,?,?)`).bind(partyId, prepared.preview.kind, operation.displayName, operation.displayName.toLocaleLowerCase("en-US"), principal.id, principal.id));
  if (operation.action === "unlink") statements.push(database.prepare(`UPDATE business_party_links SET unlinked_at=datetime('now'),unlinked_by=?
    WHERE id=? AND party_id=? AND unlinked_at IS NULL`).bind(principal.id, operation.linkId, partyId));
  else for (const fact of prepared.facts.filter(fact => fact.linkId === null)) statements.push(database.prepare(`INSERT INTO business_party_links
    (id,party_id,source_id,record_kind,record_id,linked_by) VALUES(?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), partyId, fact.root.sourceId, recordKind(fact.root.kind), fact.root.recordId, principal.id));
  if (operation.action !== "create") statements.push(database.prepare(`UPDATE business_parties SET version=version+1,status=?,updated_by=?,updated_at=datetime('now')
    WHERE id=? AND version=?`).bind(status, principal.id, partyId, operation.expectedVersion));
  statements.push(database.prepare(`INSERT INTO business_party_events(id,party_id,version,actor_id,action,details_json) VALUES(?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), partyId, version, principal.id, operation.action, JSON.stringify({ operation })),
  database.prepare(`INSERT INTO business_party_mutations(actor_id,idempotency_key,fingerprint,party_id,result_version,result_status) VALUES(?,?,?,?,?,?)`)
    .bind(principal.id, input.idempotencyKey, fingerprint, partyId, version, status));
  try { await database.batch(statements); }
  catch (error) {
    const winner = await receipt(database, principal.id, input.idempotencyKey);
    if (winner) return replay(database, principal, operation, winner, fingerprint);
    if (error instanceof Error && /business.party|UNIQUE constraint|FOREIGN KEY constraint/i.test(error.message)) return changed();
    throw new HTTPException(503, { message: "Business links could not be saved. Retry with the same operation key." });
  }
  const result = await replay(database, principal, operation, { fingerprint, party_id: partyId, result_version: version, result_status: status }, fingerprint);
  return { ...result, replayed: false };
}
