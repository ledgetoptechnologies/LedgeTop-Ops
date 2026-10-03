import type { Env } from "./types";
import { readClientHubSourcePublicId, validatedUniquePublicIdExpression, type ClientHubMappingStatus } from "./client-hub-source";
import { resolveClientHubWorkspaces } from "./client-hub-workspace";

// This is a rebuildable staff search index, never an identity/access authority.
// A future connector must first isolate the authoritative projection producers.
const PA = "project-alpha:primary";
const LOCAL = "delivery:local";
const PAGE_SIZE = 20;
// Count statements, including statements within D1 batches. A contact page can
// write three fields per record; a page count alone cannot bound subrequests.
const QUERY_BUDGET = 800;
const PHASES = ["canonical_organizations", "canonical_standalone", "organizations", "standalone", "reviewed", "workspaces", "accounts",
  "canonical_contacts", "contacts", "reviewed_contacts", "principals", "projects", "sweep"] as const;
type Phase = typeof PHASES[number];
const PAGE_QUERY_COST: Record<Phase, number> = {
  canonical_organizations: 48, canonical_standalone: 48, organizations: 45, standalone: 45, workspaces: 46, accounts: 45,
  reviewed: 45, canonical_contacts: 123, contacts: 123, reviewed_contacts: 85, principals: 84, projects: 44, sweep: 4,
};
type Kind = "organization" | "standalone_client";
type Namespace = "business" | "portal" | "account" | "review";
type IndexEnv = Pick<Env, "OPS_DB" | "DELIVERY_DB">
  & Partial<Pick<Env, "ENVIRONMENT" | "PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED">>;
interface State { generation: number; backfill_phase: string | null; backfill_cursor: string | null }
interface Root {
  source_id: string; root_namespace: Namespace; kind: Kind; public_id: string; display_name: string;
  pa_public_id: string | null; mapping_status: ClientHubMappingStatus;
  status: string; contact_count: number;
}
interface Facts {
  source_id: string; root_namespace: Namespace; kind: Kind; public_id: string; workspace_id: string | null;
  legacy_account_id: string | null; portal_status: string | null;
  account_count: number; project_count: number; request_count: number; principal_count: number;
}
interface SearchValue {
  source?: string;
  namespace: Namespace; kind: Kind; root: string; type: string; id: string;
  field: "contact" | "email" | "phone" | "project";
  value: string; project?: string;
}
const normalize = (value: string) => value.normalize("NFC").toLocaleLowerCase("en-US").trim();
const leaseGuard = "EXISTS(SELECT 1 FROM client_hub_directory_state WHERE id='directory' AND lease_token=? AND lease_until>datetime('now'))";
const currentCanonicalMapping = (mapping: string, observation: string) => `
  ${observation}.source_id=${mapping}.source_id
  AND ${observation}.source_instance_id=${mapping}.source_instance_id
  AND ${observation}.application_id=${mapping}.application_id
  AND ${observation}.history_epoch_id=${mapping}.history_epoch_id
  AND ${observation}.resource_type=${mapping}.resource_type
  AND ${observation}.project_alpha_public_id=${mapping}.project_alpha_public_id
  AND ${observation}.present=1 AND ${observation}.last_action='upsert' AND ${observation}.has_conflict=0
  AND ${observation}.binding_external_id=${mapping}.external_id
  AND ${observation}.binding_status='active'
  AND ${observation}.binding_resource_revision=${observation}.resource_revision`;
const uniqueCurrentCanonicalMapping = (mapping: string) => `1=(SELECT count(*)
  FROM project_alpha_active_directory_mappings candidate
  JOIN project_alpha_api_v2_directory_observations_current candidate_observation
    ON ${currentCanonicalMapping("candidate", "candidate_observation")}
  WHERE candidate.source_id=${mapping}.source_id
    AND candidate.resource_type=${mapping}.resource_type
    AND (candidate.project_alpha_public_id=${mapping}.project_alpha_public_id
      OR candidate.external_id=${mapping}.external_id))`;

function tupleCursor(cursor: string): [string, string] {
  if (!cursor) return ["", ""];
  try {
    const parsed: unknown = JSON.parse(cursor);
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every(value => typeof value === "string")
      ? parsed as [string, string] : ["", ""];
  } catch { return ["", ""]; }
}

function nextPhase(phase: Phase): Phase | null { return PHASES[PHASES.indexOf(phase) + 1] || null; }

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

// Extract only documented contact-shaped scalar fields. Never index the entire
// source payload, which can contain private pricing, notes, or unrelated data.
function contactFields(payload: string): { email?: string; phone?: string } {
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const email = typeof record.email === "string" && Array.from(record.email).length <= 320 ? record.email : undefined;
  const rawPhone = record.phone ?? record.phone_number;
  const phone = typeof rawPhone === "string" && Array.from(rawPhone).length <= 80 ? rawPhone.replace(/\D/g, "") : undefined;
  return { email, phone };
}

async function rootFacts(env: IndexEnv, roots: Root[]): Promise<Facts[]> {
  if (!roots.length) return [];
  const key = (root: Pick<Root, "source_id" | "root_namespace" | "kind" | "public_id">) => JSON.stringify([root.source_id, root.root_namespace, root.kind, root.public_id]);
  const linked = await resolveClientHubWorkspaces(env, roots.filter(root => root.root_namespace === "business" || root.root_namespace === "portal").map(root => ({
    key: key(root), source_id: root.source_id, kind: root.kind, business_id: root.root_namespace === "business" ? root.public_id : null,
    pa_public_id: root.pa_public_id, workspace_id: root.root_namespace === "portal" ? root.public_id : null,
  })));
  const values = roots.flatMap(root => [root.source_id, root.root_namespace, root.kind, root.public_id, linked.get(key(root))?.workspace?.id ?? null]);
  const accountMatch = `(CASE WHEN wanted.root_namespace='account' THEN account.id=wanted.public_id
      AND account.project_alpha_source_id IS NULL AND account.project_alpha_client_id IS NULL AND account.project_alpha_organization_id IS NULL
    WHEN wanted.root_namespace='business' AND wanted.source_id='${PA}' THEN account.project_alpha_source_id=wanted.source_id AND ((wanted.kind='organization' AND account.project_alpha_organization_id=wanted.public_id)
      OR (wanted.kind='standalone_client' AND account.project_alpha_client_id=wanted.public_id AND account.project_alpha_organization_id IS NULL))
    ELSE 0 END)`;
  const counts = (await env.DELIVERY_DB.withSession("first-primary").prepare(`
    WITH wanted(source_id,root_namespace,kind,public_id,workspace_id) AS (VALUES ${roots.map(() => "(?,?,?,?,?)").join(",")})
    SELECT wanted.*,
      (SELECT count(*) FROM client_accounts account WHERE ${accountMatch}) account_count,
      (SELECT count(DISTINCT grant_row.project_id) FROM client_project_grants grant_row
        JOIN client_accounts account ON account.id=grant_row.account_id
        WHERE grant_row.revoked_at IS NULL AND ${accountMatch}) project_count,
      (SELECT count(*) FROM client_service_requests request JOIN client_accounts account ON account.id=request.account_id
        WHERE ${accountMatch}) request_count,
      (SELECT count(*) FROM pa_portal_principals principal WHERE principal.workspace_id=wanted.workspace_id AND principal.status='active') principal_count
    FROM wanted
  `).bind(...values).all<Omit<Facts, "portal_status" | "legacy_account_id">>()).results;
  return counts.map(fact => {
    const link = linked.get(key(fact));
    const root = roots.find(root => key(root) === key(fact))!;
    return { ...fact, legacy_account_id: root.root_namespace === "account" ? root.public_id
      : root.source_id === PA ? link?.workspace?.legacy_account_id ?? null : null,
      portal_status: root.root_namespace === "review" ? "review_only" : link?.workspace?.status ?? (link?.status === "conflict" ? "mapping_conflict" : link?.status === "pending" ? "projection_pending"
        : root.root_namespace === "business" && root.mapping_status !== "mapped" ? "mapping_unavailable"
          : root.source_id === PA ? "not_provisioned" : "not_supported") };
  });
}

async function writeRoots(env: IndexEnv, roots: Root[], generation: number, token: string): Promise<void> {
  const facts = await rootFacts(env, roots);
  const statements: D1PreparedStatement[] = [];
  for (const root of roots) {
    const fact = facts.find(row => row.source_id === root.source_id && row.root_namespace === root.root_namespace && row.kind === root.kind && row.public_id === root.public_id);
    if (!fact) throw new Error("client-hub-index-missing-facts");
    const record = { ...root, ...fact, portal_status: fact.portal_status || "not_provisioned",
      contact_count: root.contact_count + fact.principal_count, sort_name: normalize(root.display_name) };
    const version = await digest(record);
    statements.push(env.OPS_DB.prepare(`INSERT INTO client_hub_roots
      (source_id,root_namespace,kind,public_id,pa_public_id,mapping_status,display_name,sort_name,status,portal_status,workspace_id,legacy_account_id,
       account_count,project_count,request_count,contact_count,source_version,scan_generation)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${leaseGuard}
      ON CONFLICT(source_id,root_namespace,kind,public_id) DO UPDATE SET display_name=excluded.display_name,sort_name=excluded.sort_name,
        pa_public_id=excluded.pa_public_id,mapping_status=excluded.mapping_status,
        status=excluded.status,portal_status=excluded.portal_status,workspace_id=excluded.workspace_id,
        legacy_account_id=excluded.legacy_account_id,account_count=excluded.account_count,project_count=excluded.project_count,
        request_count=excluded.request_count,contact_count=excluded.contact_count,source_version=excluded.source_version,
        scan_generation=excluded.scan_generation,indexed_at=datetime('now')
      WHERE client_hub_roots.source_version IS NOT excluded.source_version OR client_hub_roots.status IS NOT excluded.status`)
      .bind(root.source_id, root.root_namespace, root.kind, root.public_id, root.pa_public_id, root.mapping_status, root.display_name, record.sort_name, root.status, record.portal_status,
        fact.workspace_id, fact.legacy_account_id, fact.account_count, fact.project_count, fact.request_count,
        record.contact_count, version, generation, token));
    statements.push(env.OPS_DB.prepare(`UPDATE client_hub_roots SET scan_generation=?
      WHERE source_id=? AND root_namespace=? AND kind=? AND public_id=? AND ${leaseGuard}`)
      .bind(generation, root.source_id, root.root_namespace, root.kind, root.public_id, token));
  }
  if (statements.length) await env.OPS_DB.batch(statements);
}

async function writeSearch(env: IndexEnv, values: SearchValue[], generation: number, token: string): Promise<void> {
  // Keep each batch under the runtime's bound; a page can produce 3 fields/record.
  for (let offset = 0; offset < values.length; offset += 20) {
    const statements = values.slice(offset, offset + 20).flatMap(row => {
      const value = normalize(row.value);
      if (!value) return [];
      const source = row.source ?? PA;
      const keys = [source, row.namespace, row.kind, row.root, row.type, row.id, row.field];
      return [
        env.OPS_DB.prepare(`INSERT INTO client_hub_search_values
          (source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value,project_id,scan_generation)
          SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${leaseGuard} AND EXISTS
            (SELECT 1 FROM client_hub_roots WHERE source_id=? AND root_namespace=? AND kind=? AND public_id=? AND status NOT IN ('inactive','closed'))
          ON CONFLICT(source_id,root_namespace,kind,root_public_id,record_type,record_id,field) DO UPDATE SET
            normalized_value=excluded.normalized_value,project_id=excluded.project_id,scan_generation=excluded.scan_generation
          WHERE client_hub_search_values.normalized_value IS NOT excluded.normalized_value
            OR client_hub_search_values.project_id IS NOT excluded.project_id`)
          .bind(...keys, value, row.project || null, generation, token, source, row.namespace, row.kind, row.root),
        env.OPS_DB.prepare(`UPDATE client_hub_search_values SET scan_generation=?
          WHERE source_id=? AND root_namespace=? AND kind=? AND root_public_id=? AND record_type=? AND record_id=? AND field=? AND ${leaseGuard}`)
          .bind(generation, ...keys, token),
      ];
    });
    if (statements.length) await env.OPS_DB.batch(statements);
  }
}

async function rootPage(env: IndexEnv, phase: Phase, cursor: string, generation: number, token: string) {
  let rows: Array<Root & { cursor: string }>;
  const ops = env.OPS_DB.withSession("first-primary"), delivery = env.DELIVERY_DB.withSession("first-primary");
  if (phase === "canonical_organizations" || phase === "canonical_standalone") {
    const organizations = phase === "canonical_organizations", key = tupleCursor(cursor);
    const sources = (await ops.prepare(`SELECT mapping.source_id,'business' root_namespace,
      '${organizations ? "organization" : "standalone_client"}' kind,
      mapping.external_id public_id,mapping.project_alpha_public_id pa_public_id,'mapped' mapping_status,
      json_extract(revision.profile_json,'$.name') display_name,'active' status,
      revision.profile_json,mapping.source_id cursor_source,mapping.external_id cursor_public,
      ${organizations ? `(SELECT count(*) FROM operations_directory_client_organizations relationship
        JOIN project_alpha_active_directory_mappings child ON child.external_id=relationship.client_record_id
          AND child.source_id=mapping.source_id AND child.source_instance_id=mapping.source_instance_id
          AND child.application_id=mapping.application_id AND child.history_epoch_id=mapping.history_epoch_id
          AND child.resource_type='client'
        JOIN operations_directory_records child_record ON child_record.record_id=child.external_id AND child_record.record_kind='client'
        JOIN operations_directory_revisions child_revision ON child_revision.record_id=child_record.record_id
          AND child_revision.version=child_record.current_version
        JOIN project_alpha_api_v2_directory_observations_current child_observation
          ON ${currentCanonicalMapping("child", "child_observation")}
        WHERE relationship.organization_record_id=mapping.external_id
          AND ${uniqueCurrentCanonicalMapping("child")})` : "1"} contact_count
      FROM project_alpha_active_directory_mappings mapping
      JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind=mapping.resource_type
      JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
      JOIN project_alpha_api_v2_directory_observations_current observation
        ON ${currentCanonicalMapping("mapping", "observation")}
      JOIN pa_connectors connector ON connector.source_id=mapping.source_id AND connector.state='active' AND connector.read_visible=1
      ${organizations ? "" : `LEFT JOIN operations_directory_client_organizations relationship ON relationship.client_record_id=mapping.external_id`}
      WHERE mapping.resource_type='${organizations ? "organization" : "client"}'
        AND ${uniqueCurrentCanonicalMapping("mapping")}
        ${organizations ? "" : "AND relationship.organization_record_id IS NULL"}
        AND json_type(revision.profile_json,'$.name')='text'
        AND length(trim(json_extract(revision.profile_json,'$.name'))) BETWEEN 1 AND 150
        AND (mapping.source_id,mapping.external_id)>(?,?)
      ORDER BY mapping.source_id COLLATE BINARY,mapping.external_id COLLATE BINARY LIMIT ?`)
      .bind(key[0], key[1], PAGE_SIZE).all<Omit<Root, "cursor"> & {
        profile_json: string; cursor_source: string; cursor_public: string;
      }>()).results;
    rows = sources.map(({ profile_json: _profile, cursor_source, cursor_public, ...source }) => ({
      ...source, cursor: JSON.stringify([cursor_source, cursor_public]),
    }));
  } else if (phase === "organizations" || phase === "standalone") {
    const organizations = phase === "organizations";
    const table = organizations ? "pa_organizations" : "pa_clients";
    const sources = (await ops.prepare(`SELECT source.projection_source_id source_id,'business' root_namespace,
      '${organizations ? "organization" : "standalone_client"}' kind,
      source.id public_id,source.name display_name,'active' status,source.id cursor,source.payload_json,
      ${validatedUniquePublicIdExpression(table, "source")} pa_public_id,
      ${organizations ? "(SELECT count(*) FROM pa_clients contact WHERE contact.organization_id=source.id AND contact.projection_source_id=source.projection_source_id AND contact.active=1)" : "1"} contact_count
      FROM ${table} source WHERE source.active=1 ${organizations ? "" : "AND source.organization_id IS NULL"}
        AND NOT EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
          WHERE mapping.source_id=source.projection_source_id
            AND mapping.resource_type='${organizations ? "organization" : "client"}'
            AND mapping.project_alpha_public_id=${validatedUniquePublicIdExpression(table, "source")})
        AND source.id>? ORDER BY source.id COLLATE BINARY LIMIT ?`)
      .bind(cursor, PAGE_SIZE).all<Omit<Root, "mapping_status"> & { cursor: string; payload_json: string }>()).results;
    rows = sources.map(({ payload_json, ...source }) => {
      const parsed = readClientHubSourcePublicId(payload_json);
      return { ...source, mapping_status: parsed.pa_public_id && !source.pa_public_id ? "ambiguous" : parsed.mapping_status };
    });
  } else if (phase === "reviewed") {
    if (env.ENVIRONMENT !== "staging" || env.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED !== "true") rows = [];
    else rows = (await ops.prepare(`SELECT display.source_id,'review' root_namespace,'standalone_client' kind,
      display.projection_id public_id,display.project_alpha_public_id pa_public_id,'not_applicable' mapping_status,
      display.display_name,'reviewed_display_only' status,1 contact_count,display.projection_id cursor
      FROM project_alpha_reviewed_standalone_client_displays display
      JOIN project_alpha_api_v2_directory_observations_current observation
        ON observation.source_id=display.source_id AND observation.source_instance_id=display.source_instance_id
       AND observation.application_id=display.application_id AND observation.history_epoch_id=display.history_epoch_id
       AND observation.resource_type='client' AND observation.project_alpha_public_id=display.project_alpha_public_id
      JOIN project_alpha_api_v2_inventory_receipts inventory
        ON inventory.source_id=observation.source_id AND inventory.source_instance_id=observation.source_instance_id
       AND inventory.application_id=observation.application_id AND inventory.history_epoch_id=observation.history_epoch_id
       AND inventory.inventory_kind='directory' AND inventory.request_id=observation.request_id
      WHERE display.state='display_only' AND display.projection_id>?
        AND observation.present=1 AND observation.last_action='upsert' AND observation.has_conflict=0
        AND observation.resource_revision=display.project_alpha_revision
        AND observation.binding_external_id=display.external_id AND observation.binding_status='active'
        AND observation.binding_resource_revision=observation.resource_revision
        AND inventory.authorization_generation=display.authorization_generation
        AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_mappings mapping
          WHERE mapping.source_id=display.source_id AND mapping.source_instance_id=display.source_instance_id
            AND mapping.application_id=display.application_id AND mapping.resource_type='client'
            AND (mapping.external_id=display.external_id OR mapping.project_alpha_public_id=display.project_alpha_public_id))
        AND NOT EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings mapping
          WHERE mapping.source_id=display.source_id AND mapping.source_instance_id=display.source_instance_id
            AND mapping.application_id=display.application_id AND mapping.resource_type='client'
            AND (mapping.record_id=display.record_id OR mapping.external_id=display.external_id
              OR mapping.project_alpha_public_id=display.project_alpha_public_id))
      ORDER BY display.projection_id COLLATE BINARY LIMIT ?`).bind(cursor, PAGE_SIZE)
      .all<Root & { cursor: string }>()).results;
  } else if (phase === "accounts") {
    rows = (await delivery.prepare(`SELECT '${LOCAL}' source_id,'account' root_namespace,'standalone_client' kind,
      id public_id,NULL pa_public_id,'not_applicable' mapping_status,display_name,status,0 contact_count,id cursor
      FROM client_accounts WHERE project_alpha_source_id IS NULL AND project_alpha_client_id IS NULL AND project_alpha_organization_id IS NULL
        AND status<>'closed' AND id>? ORDER BY id COLLATE BINARY LIMIT ?`).bind(cursor, PAGE_SIZE).all<Root & { cursor: string }>()).results;
  } else {
    rows = (await delivery.prepare(`SELECT '${PA}' source_id,'portal' root_namespace,root_type kind,
      id public_id,NULL pa_public_id,'not_applicable' mapping_status,
      display_name,status,0 contact_count,id cursor FROM portal_v2_workspaces
      WHERE project_alpha_source_id='project-alpha:primary' AND status<>'closed' AND id>? ORDER BY id COLLATE BINARY LIMIT ?`).bind(cursor, PAGE_SIZE).all<Root & { cursor: string }>()).results;
    if (rows.length) {
      // Fold only verified current-generation associations. A portal root with
      // no proven business link remains visible in its own explicit namespace.
      const facts = await ops.prepare(`SELECT workspace_id FROM client_hub_roots
        WHERE source_id=? AND root_namespace='business' AND scan_generation=? AND status='active'
          AND workspace_id IN (${rows.map(() => "?").join(",")})`)
        .bind(PA, generation, ...rows.map(row => row.public_id)).all<{ workspace_id: string }>();
      const fallback = rows.filter(row => !facts.results.some(fact => fact.workspace_id === row.public_id));
      await writeRoots(env, fallback, generation, token);
      return { count: rows.length, cursor: rows.at(-1)?.cursor || cursor };
    }
  }
  await writeRoots(env, rows, generation, token);
  return { count: rows.length, cursor: rows.at(-1)?.cursor || cursor };
}

async function searchPage(env: IndexEnv, phase: Phase, cursor: string, generation: number, token: string) {
  const values: SearchValue[] = [];
  let count = 0, next = cursor;
  if (phase === "canonical_contacts") {
    const key = tupleCursor(cursor);
    const rows = (await env.OPS_DB.withSession("first-primary").prepare(`SELECT child.source_id,
      child.external_id public_id,child.external_id record_id,revision.profile_json,
      CASE WHEN relationship.organization_record_id IS NULL THEN child.external_id
        ELSE parent.external_id END root_public_id,
      CASE WHEN relationship.organization_record_id IS NULL THEN 'standalone_client' ELSE 'organization' END kind
      FROM project_alpha_active_directory_mappings child
      JOIN operations_directory_records record ON record.record_id=child.external_id AND record.record_kind='client'
      JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
      JOIN project_alpha_api_v2_directory_observations_current observation
        ON ${currentCanonicalMapping("child", "observation")}
      JOIN pa_connectors connector ON connector.source_id=child.source_id AND connector.state='active' AND connector.read_visible=1
      LEFT JOIN operations_directory_client_organizations relationship ON relationship.client_record_id=child.external_id
      LEFT JOIN project_alpha_active_directory_mappings parent ON parent.external_id=relationship.organization_record_id
        AND parent.source_id=child.source_id AND parent.source_instance_id=child.source_instance_id
        AND parent.application_id=child.application_id AND parent.history_epoch_id=child.history_epoch_id
        AND parent.resource_type='organization'
      LEFT JOIN project_alpha_api_v2_directory_observations_current parent_observation
        ON ${currentCanonicalMapping("parent", "parent_observation")}
      WHERE child.resource_type='client' AND (relationship.organization_record_id IS NULL OR parent_observation.source_id IS NOT NULL)
        AND ${uniqueCurrentCanonicalMapping("child")}
        AND (relationship.organization_record_id IS NULL OR ${uniqueCurrentCanonicalMapping("parent")})
        AND (child.source_id,child.external_id)>(?,?)
      ORDER BY child.source_id COLLATE BINARY,child.external_id COLLATE BINARY LIMIT ?`)
      .bind(key[0], key[1], PAGE_SIZE).all<{ source_id: string; public_id: string; record_id: string;
        profile_json: string; root_public_id: string; kind: Kind }>()).results;
    count = rows.length;
    if (rows.length) next = JSON.stringify([rows.at(-1)!.source_id, rows.at(-1)!.public_id]);
    for (const row of rows) {
      let profile: unknown;
      try { profile = JSON.parse(row.profile_json); } catch { continue; }
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) continue;
      const name = (profile as Record<string, unknown>).name;
      if (typeof name !== "string" || !name.trim() || Array.from(name).length > 150) continue;
      const base = { source: row.source_id, namespace: "business" as const, kind: row.kind,
        root: row.root_public_id, type: "ops_directory_client", id: row.record_id };
      values.push({ ...base, field: "contact", value: name });
      const fields = contactFields(row.profile_json);
      if (fields.email) values.push({ ...base, field: "email", value: fields.email });
      if (fields.phone) values.push({ ...base, field: "phone", value: fields.phone });
    }
  } else if (phase === "contacts") {
    const rows = (await env.OPS_DB.withSession("first-primary").prepare(`SELECT id,name,organization_id,payload_json,projection_source_id FROM pa_clients
      WHERE active=1 AND NOT EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
        WHERE mapping.source_id=pa_clients.projection_source_id AND mapping.resource_type='client'
          AND mapping.project_alpha_public_id=${validatedUniquePublicIdExpression("pa_clients", "pa_clients")})
        AND id>? ORDER BY id COLLATE BINARY LIMIT ?`).bind(cursor, PAGE_SIZE)
      .all<{ id: string; name: string; organization_id: string | null; payload_json: string; projection_source_id: string }>()).results;
    count = rows.length; next = rows.at(-1)?.id || cursor;
    for (const row of rows) {
      const base = { source: row.projection_source_id, namespace: "business" as const, kind: (row.organization_id ? "organization" : "standalone_client") as Kind,
        root: row.organization_id || row.id, type: "pa_client", id: row.id };
      values.push({ ...base, field: "contact", value: row.name });
      const fields = contactFields(row.payload_json);
      if (fields.email) values.push({ ...base, field: "email", value: fields.email });
      if (fields.phone) values.push({ ...base, field: "phone", value: fields.phone });
    }
  } else if (phase === "reviewed_contacts") {
    if (env.ENVIRONMENT === "staging" && env.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED === "true") {
      const rows = (await env.OPS_DB.withSession("first-primary").prepare(`SELECT projection_id,source_id,display_name,email,phone
        FROM project_alpha_reviewed_standalone_client_displays WHERE state='display_only' AND projection_id>?
        ORDER BY projection_id COLLATE BINARY LIMIT ?`).bind(cursor, PAGE_SIZE)
        .all<{projection_id:string;source_id:string;display_name:string;email:string|null;phone:string|null}>()).results;
      count=rows.length; next=rows.at(-1)?.projection_id||cursor;
      for(const row of rows){
        const base={source:row.source_id,namespace:"review" as const,kind:"standalone_client" as const,
          root:row.projection_id,type:"api_v2_reviewed_client",id:row.projection_id};
        values.push({...base,field:"contact",value:row.display_name});
        if(row.email) values.push({...base,field:"email",value:row.email});
        if(row.phone) values.push({...base,field:"phone",value:row.phone.replace(/\D/g,"")});
      }
    }
  } else if (phase === "principals") {
    const key = cursor ? JSON.parse(cursor) as [string, string] : ["", ""];
    const rows = (await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT principal.workspace_id,principal.public_id,
      principal.display_name,principal.email_hint,workspace.root_type kind,workspace.project_alpha_source_id source_id
      FROM pa_portal_principals principal JOIN portal_v2_workspaces workspace ON workspace.id=principal.workspace_id
      WHERE principal.status='active' AND workspace.status<>'closed' AND (principal.workspace_id,principal.public_id)>(?,?)
      ORDER BY principal.workspace_id COLLATE BINARY,principal.public_id COLLATE BINARY LIMIT ?`)
      .bind(key[0], key[1], PAGE_SIZE).all<{ workspace_id: string; public_id: string; display_name: string; email_hint: string; kind: Kind; source_id: string }>()).results;
    count = rows.length;
    if (rows.length) next = JSON.stringify([rows.at(-1)!.workspace_id, rows.at(-1)!.public_id]);
    const roots = rows.length ? (await env.OPS_DB.withSession("first-primary").prepare(`
      SELECT source_id,root_namespace,kind,public_id,workspace_id FROM client_hub_roots
      WHERE status='active' AND scan_generation=?
        AND (${rows.map(() => "(source_id=? AND workspace_id=?)").join(" OR ")})`)
      .bind(generation, ...rows.flatMap(row => [row.source_id, row.workspace_id]))
      .all<{ source_id: string; root_namespace: Namespace; kind: Kind; public_id: string; workspace_id: string }>()).results : [];
    for (const row of rows) {
      const matches = roots.filter(root => root.source_id === row.source_id && root.workspace_id === row.workspace_id && root.kind === row.kind);
      // No principals from pending/ambiguous projection mappings enter search.
      if (matches.length !== 1) continue;
      const root = matches[0];
      if (!root) continue;
      const base = { source: root.source_id, namespace: root.root_namespace, kind: root.kind, root: root.public_id,
        type: "portal_principal", id: JSON.stringify([row.workspace_id, row.public_id]) };
      values.push({ ...base, field: "contact", value: row.display_name });
      if (row.email_hint) values.push({ ...base, field: "email", value: row.email_hint });
    }
  } else {
    const db = env.OPS_DB.withSession("first-primary");
    const rows = (await db.prepare(`SELECT project.id,project.name,project.projection_source_id,
      COALESCE(project.organization_id,client.organization_id) organization_id,project.client_id,
      ${validatedUniquePublicIdExpression("pa_organizations", "organization")} organization_pa_public_id,
      ${validatedUniquePublicIdExpression("pa_clients", "client")} client_pa_public_id
      FROM pa_projects project LEFT JOIN pa_clients client ON client.id=project.client_id AND client.projection_source_id=project.projection_source_id AND client.active=1
      LEFT JOIN pa_organizations organization ON organization.id=COALESCE(project.organization_id,client.organization_id)
        AND organization.projection_source_id=project.projection_source_id AND organization.active=1
      WHERE project.active=1 AND project.id>? ORDER BY project.id COLLATE BINARY LIMIT ?`)
      .bind(cursor, PAGE_SIZE).all<{ id: string; name: string; organization_id: string | null; client_id: string | null;
        projection_source_id: string; organization_pa_public_id: string | null; client_pa_public_id: string | null }>()).results;
    count = rows.length; next = rows.at(-1)?.id || cursor;
    const identities = [...new Map(rows.flatMap(row => {
      const paPublicId = row.organization_pa_public_id ?? row.client_pa_public_id;
      if (!paPublicId) return [];
      const resourceType = row.organization_pa_public_id ? "organization" : "client";
      const key = JSON.stringify([row.projection_source_id, resourceType, paPublicId]);
      return [[key, { source_id: row.projection_source_id, resource_type: resourceType, pa_public_id: paPublicId }] as const];
    })).values()];
    const mappingRows = identities.length ? (await db.prepare(`SELECT mapping.source_id,mapping.resource_type,
      mapping.project_alpha_public_id pa_public_id,mapping.external_id,
      CASE WHEN observation.source_id IS NOT NULL AND connector.source_id IS NOT NULL THEN 1 ELSE 0 END current
      FROM project_alpha_active_directory_mappings mapping
      LEFT JOIN project_alpha_api_v2_directory_observations_current observation
        ON ${currentCanonicalMapping("mapping", "observation")}
      LEFT JOIN pa_connectors connector ON connector.source_id=mapping.source_id
        AND connector.state='active' AND connector.read_visible=1
      WHERE ${identities.map(() => "(mapping.source_id=? AND mapping.resource_type=? AND mapping.project_alpha_public_id=?)").join(" OR ")}`)
      .bind(...identities.flatMap(identity => [identity.source_id, identity.resource_type, identity.pa_public_id]))
      .all<{ source_id: string; resource_type: string; pa_public_id: string; external_id: string; current: number }>()).results : [];
    for (const row of rows) {
      const resourceType = row.organization_pa_public_id ? "organization" : "client";
      const paPublicId = row.organization_pa_public_id ?? row.client_pa_public_id;
      const mapped = paPublicId ? mappingRows.filter(mapping => mapping.source_id === row.projection_source_id
        && mapping.resource_type === resourceType && mapping.pa_public_id === paPublicId) : [];
      if (mapped.length && (mapped.length !== 1 || mapped[0]!.current !== 1)) continue;
      const root = mapped[0]?.external_id ?? row.organization_id ?? row.client_id;
      if (root) values.push({ source: row.projection_source_id, namespace: "business", kind: row.organization_id ? "organization" : "standalone_client", root,
        type: "pa_project", id: row.id, field: "project", value: `${row.name} ${row.id}`, project: row.id });
    }
  }
  await writeSearch(env, values, generation, token);
  return { count, cursor: next };
}

/** Bounded, restart-safe repair/backfill. All source databases are read-only. */
export async function reconcileClientHubIndex(env: IndexEnv, maxPages = 20): Promise<{ status: "busy" | "progress" | "complete"; pages: number }> {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 40) throw new Error("client-hub-index-invalid-page-budget");
  const token = crypto.randomUUID();
  const state = await env.OPS_DB.prepare(`UPDATE client_hub_directory_state SET lease_token=?,lease_until=datetime('now','+2 minutes')
    WHERE id='directory' AND (lease_until IS NULL OR lease_until<=datetime('now'))
      AND (next_run_at IS NULL OR next_run_at<=datetime('now')) RETURNING generation,backfill_phase,backfill_cursor`)
    .bind(token).first<State>();
  if (!state) return { status: "busy", pages: 0 };
  const started = Date.now();
  let reservedQueries = 2; // Lease acquisition and release.
  let phase = (state.backfill_phase || PHASES[0]) as Phase, cursor = state.backfill_cursor || "", pages = 0;
  try {
    if (!PHASES.includes(phase)) throw new Error("client-hub-index-invalid-phase");
    while (pages < maxPages && Date.now() - started < 20_000) {
      if (reservedQueries + PAGE_QUERY_COST[phase] > QUERY_BUDGET) break;
      reservedQueries += PAGE_QUERY_COST[phase];
      const refreshed = await env.OPS_DB.prepare(`UPDATE client_hub_directory_state SET lease_until=datetime('now','+2 minutes')
        WHERE id='directory' AND ${leaseGuard} RETURNING id`).bind(token).first<{ id: string }>();
      if (!refreshed) throw new Error("client-hub-index-lease-lost");
      if (phase === "sweep") {
        const swept = await env.OPS_DB.batch([
          env.OPS_DB.prepare(`UPDATE client_hub_roots SET status='inactive',indexed_at=datetime('now')
            WHERE rowid IN (SELECT rowid FROM client_hub_roots WHERE scan_generation<>? AND status<>'inactive' LIMIT ?)
              AND ${leaseGuard}`).bind(state.generation, PAGE_SIZE, token),
          env.OPS_DB.prepare(`DELETE FROM client_hub_search_values WHERE rowid IN
            (SELECT rowid FROM client_hub_search_values WHERE scan_generation<>? LIMIT ?) AND ${leaseGuard}`)
            .bind(state.generation, PAGE_SIZE, token),
        ]);
        pages += 1;
        if (swept.some(result => result.meta.changes > 0)) continue;
        const finished = await env.OPS_DB.prepare(`UPDATE client_hub_directory_state SET ready=1,generation=generation+1,backfill_phase=NULL,
          backfill_cursor=NULL,last_success_at=datetime('now'),next_run_at=datetime('now','+5 minutes')
          WHERE id='directory' AND ${leaseGuard} RETURNING id`).bind(token).first<{ id: string }>();
        if (!finished) throw new Error("client-hub-index-lease-lost");
        console.log(JSON.stringify({ event: "client_hub.index.complete", pages }));
        return { status: "complete", pages };
      }
      const result = ["canonical_organizations", "canonical_standalone", "organizations", "standalone", "reviewed", "workspaces", "accounts"].includes(phase)
        ? await rootPage(env, phase, cursor, state.generation, token)
        : await searchPage(env, phase, cursor, state.generation, token);
      if (result.count < PAGE_SIZE) { phase = nextPhase(phase)!; cursor = ""; }
      else cursor = result.cursor;
      const saved = await env.OPS_DB.prepare(`UPDATE client_hub_directory_state SET backfill_phase=?,backfill_cursor=?
        WHERE id='directory' AND ${leaseGuard} RETURNING id`).bind(phase, cursor, token).first<{ id: string }>();
      if (!saved) throw new Error("client-hub-index-lease-lost");
      pages += 1;
    }
    return { status: "progress", pages };
  } finally {
    await env.OPS_DB.prepare("UPDATE client_hub_directory_state SET lease_token=NULL,lease_until=NULL WHERE id='directory' AND lease_token=?")
      .bind(token).run();
  }
}
