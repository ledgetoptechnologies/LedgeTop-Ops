import { CLIENT_PORTAL_SERVICE_METADATA_MAX_RESPONSE_BYTES,
  type ClientPortalServiceMetadataRequestV1, type ClientPortalServiceMetadataV1 } from "../../../../../packages/shared/src/client-portal-service-metadata";
import type { Env } from "../types";
import type { VerifiedClientPrincipal } from "./types";
import { readNativeOperationsPortalHomes } from "./operations-native-recipient-read";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMEOUT_MS = 1_500;
const MAX_HOMES = 20;
const responseKeys = ["ok", "protocolVersion", "authorityId", "workspaceId", "ownershipEpoch", "grantRevision", "issuer", "subject", "services"] as const;
const serviceKeys = ["serviceId", "providerId", "displayLabel", "revision"] as const;

export interface OperationsServiceMetadataBinding {
  readServiceMetadata(input: ClientPortalServiceMetadataRequestV1): Promise<string>;
}
export type OperationsServiceHomeEnv = Pick<Env, "DELIVERY_DB"> & {
  CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED?: string;
  CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED?: string;
  CLIENT_PORTAL_SERVICE_METADATA_READER?: OperationsServiceMetadataBinding;
};
export type OperationsServiceHomeResult = Readonly<{ ok: true; authorityId: string; workspaceId: string;
  ownershipEpoch: number; grantRevision: number; services: readonly ClientPortalServiceMetadataV1[] }>
  | Readonly<{ ok: false; code: "disabled" | "denied" | "unavailable" }>;

type AuthorityRow = { authority_id: string; workspace_id: string; ownership_epoch: number; grant_revision: number };
function validAuthority(row: AuthorityRow): boolean {
  return UUID.test(row.authority_id) && typeof row.workspace_id === "string" && row.workspace_id.length >= 1
    && row.workspace_id.length <= 200 && row.workspace_id.trim() === row.workspace_id
    && Number.isSafeInteger(row.ownership_epoch) && row.ownership_epoch >= 1
    && Number.isSafeInteger(row.grant_revision) && row.grant_revision >= 1;
}
async function currentAuthorities(env: OperationsServiceHomeEnv, principal: Pick<VerifiedClientPrincipal, "issuer" | "subject">,
  authorityId?: string): Promise<AuthorityRow[] | null> {
  if ((authorityId !== undefined && !UUID.test(authorityId)) || principal.issuer.length < 1 || principal.issuer.length > 512 || principal.issuer.trim() !== principal.issuer
    || principal.subject.length < 1 || principal.subject.length > 512 || principal.subject.trim() !== principal.subject) return [];
  // Select one authority protocol explicitly. A missing native grant or schema
  // must never fall back to a historical PA-backed recipient grant.
  if (env.CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED === "true") {
    const homes = await readNativeOperationsPortalHomes(env.DELIVERY_DB, principal, true);
    if (homes === null) return null;
    return homes.filter(home => authorityId === undefined || home.authorityId === authorityId)
      .map(home => ({ authority_id: home.authorityId, workspace_id: home.workspaceId,
        ownership_epoch: home.ownershipEpoch, grant_revision: home.grantRevision }));
  }
  try {
    const db = env.DELIVERY_DB.withSession?.("first-primary") ?? env.DELIVERY_DB;
    const result = await db.prepare(`SELECT binding.client_authority_id authority_id,binding.workspace_id,
        workspace_head.ownership_epoch,grant_head.grant_revision
      FROM portal_operations_principal_grant_heads grant_head
      JOIN portal_operations_workspace_authority_heads workspace_head
        ON workspace_head.workspace_id=grant_head.workspace_id
          AND workspace_head.client_authority_id=grant_head.client_authority_id
          AND workspace_head.ownership_epoch=grant_head.ownership_epoch AND workspace_head.state='active'
      JOIN portal_client_authority_workspace_bindings binding
        ON binding.client_authority_id=workspace_head.client_authority_id
          AND binding.workspace_id=workspace_head.workspace_id
          AND binding.operation_id=workspace_head.binding_operation_id
          AND binding.state='inactive' AND binding.revision=1
      JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.status='active'
      JOIN portal_operations_authority_v2_receipts receipt
        ON receipt.operation_id=grant_head.last_operation_id
          AND receipt.client_authority_id=grant_head.client_authority_id
          AND receipt.workspace_id=grant_head.workspace_id
          AND receipt.issuer=grant_head.issuer AND receipt.subject=grant_head.subject
          AND receipt.ownership_epoch=grant_head.ownership_epoch
          AND receipt.grant_revision=grant_head.grant_revision
          AND receipt.resulting_state='active' AND receipt.protocol_version=3
          AND receipt.permissions_json=grant_head.permissions_json
      WHERE ${authorityId === undefined ? "" : "binding.client_authority_id=? AND "}grant_head.issuer=? AND grant_head.subject=?
        AND grant_head.state='active' AND grant_head.protocol_version=3
        AND grant_head.permissions_json='["operations.service_home.read"]'
      ORDER BY binding.client_authority_id
      LIMIT ${authorityId === undefined ? MAX_HOMES + 1 : 2}`).bind(...(authorityId === undefined
        ? [principal.issuer, principal.subject] : [authorityId, principal.issuer, principal.subject])).all<AuthorityRow>();
    if (!result.success || result.results.length > MAX_HOMES || result.results.some(row => !validAuthority(row))
      || new Set(result.results.map(row => row.authority_id)).size !== result.results.length) return null;
    return result.results;
  } catch { return null; }
}
async function currentAuthority(env: OperationsServiceHomeEnv, principal: Pick<VerifiedClientPrincipal, "issuer" | "subject">,
  authorityId: string): Promise<AuthorityRow | null> {
  const rows = await currentAuthorities(env, principal, authorityId);
  return rows?.length === 1 ? rows[0]! : null;
}

export type OperationsServiceHome = Omit<Extract<OperationsServiceHomeResult, { ok: true }>, "ok">;
export type OperationsServiceHomesResult = Readonly<{ ok: true; homes: readonly OperationsServiceHome[] }>
  | Readonly<{ ok: false; code: "disabled" | "denied" | "unavailable" }>;

/** Discovery exposes only homes explicitly permitted to this verified person.
 * Recheck the entire snapshot after all RPCs: a revoked earlier home must not
 * survive while another home's read is in flight. No PA or email fallback. */
export async function readOperationsServiceHomes(env: OperationsServiceHomeEnv,
  principal: Pick<VerifiedClientPrincipal, "issuer" | "subject">): Promise<OperationsServiceHomesResult> {
  if (env.CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED !== "true") return { ok: false, code: "disabled" };
  if (!env.CLIENT_PORTAL_SERVICE_METADATA_READER) return { ok: false, code: "unavailable" };
  const before = await currentAuthorities(env, principal);
  if (!before) return { ok: false, code: "unavailable" };
  if (!before.length) return { ok: false, code: "denied" };
  // At most twenty private calls; each has its own bounded timeout.
  const results = await Promise.all(before.map(row => readOperationsServiceHome(env, principal, row.authority_id)));
  const homes: OperationsServiceHome[] = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!, expected = before[index]!;
    if (!result.ok) return result;
    if (result.authorityId !== expected.authority_id || result.workspaceId !== expected.workspace_id
      || result.ownershipEpoch !== expected.ownership_epoch || result.grantRevision !== expected.grant_revision)
      return { ok: false, code: "denied" };
    const { ok: _ok, ...home } = result;
    homes.push(home);
  }
  const after = await currentAuthorities(env, principal);
  if (!after) return { ok: false, code: "unavailable" };
  if (after.length !== before.length || after.some((row, index) => {
    const expected = before[index]!;
    return row.authority_id !== expected.authority_id || row.workspace_id !== expected.workspace_id
      || row.ownership_epoch !== expected.ownership_epoch || row.grant_revision !== expected.grant_revision;
  })) return { ok: false, code: "denied" };
  return { ok: true, homes };
}

function exactObject(value: unknown, wanted: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  try {
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).some(key => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Object.keys(descriptors);
    if (names.length !== wanted.length || names.some(key => !wanted.includes(key) || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(names.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}

function validateResponse(value: unknown, request: ClientPortalServiceMetadataRequestV1): readonly ClientPortalServiceMetadataV1[] | null {
  const response = exactObject(value, responseKeys);
  if (!response || response.ok !== true || response.protocolVersion !== 1 || response.authorityId !== request.authorityId
    || response.workspaceId !== request.workspaceId || response.ownershipEpoch !== request.ownershipEpoch
    || response.grantRevision !== request.grantRevision || response.issuer !== request.issuer
    || response.subject !== request.subject || !Array.isArray(response.services) || response.services.length > 100) return null;
  const services: ClientPortalServiceMetadataV1[] = [];
  const serviceIds = new Set<string>();
  for (const value of response.services) {
    const service = exactObject(value, serviceKeys);
    if (!service || typeof service.serviceId !== "string" || service.serviceId.length < 1 || service.serviceId.length > 191
      || service.serviceId.trim() !== service.serviceId || typeof service.providerId !== "string"
      || service.providerId.length < 1 || service.providerId.length > 128 || service.providerId.trim() !== service.providerId
      || typeof service.displayLabel !== "string" || service.displayLabel.length < 1 || service.displayLabel.length > 160
      || service.displayLabel.trim() !== service.displayLabel
      || typeof service.revision !== "number" || !Number.isSafeInteger(service.revision) || service.revision < 1) return null;
    if (serviceIds.has(service.serviceId)) return null;
    serviceIds.add(service.serviceId);
    services.push({ serviceId: service.serviceId, providerId: service.providerId,
      displayLabel: service.displayLabel, revision: service.revision });
  }
  return services;
}

async function boundedRpc(binding: OperationsServiceMetadataBinding, request: ClientPortalServiceMetadataRequestV1): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([binding.readServiceMetadata(request), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error("operations-service-metadata-timeout")), TIMEOUT_MS);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function decodeResponse(wire: unknown): unknown {
  if (typeof wire !== "string" || wire.length > CLIENT_PORTAL_SERVICE_METADATA_MAX_RESPONSE_BYTES
    || new TextEncoder().encode(wire).byteLength > CLIENT_PORTAL_SERVICE_METADATA_MAX_RESPONSE_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(wire);
    return JSON.stringify(parsed) === wire ? parsed : null;
  } catch { return null; }
}

/** Requires explicit home permission; descriptive metadata never authorizes files or financial content. */
export async function readOperationsServiceHome(env: OperationsServiceHomeEnv,
  principal: Pick<VerifiedClientPrincipal, "issuer" | "subject">, authorityId: string): Promise<OperationsServiceHomeResult> {
  if (env.CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED !== "true" || !env.CLIENT_PORTAL_SERVICE_METADATA_READER)
    return { ok: false, code: "disabled" };
  const before = await currentAuthority(env, principal, authorityId);
  if (!before) return { ok: false, code: "denied" };
  const request: ClientPortalServiceMetadataRequestV1 = { protocolVersion: 1, authorityId: before.authority_id,
    workspaceId: before.workspace_id, ownershipEpoch: before.ownership_epoch, grantRevision: before.grant_revision,
    issuer: principal.issuer, subject: principal.subject };
  let raw: unknown;
  try { raw = decodeResponse(await boundedRpc(env.CLIENT_PORTAL_SERVICE_METADATA_READER, request)); }
  catch { return { ok: false, code: "unavailable" }; }
  const services = validateResponse(raw, request);
  if (!services) {
    const denied = exactObject(raw, ["ok", "protocolVersion", "authorityId", "workspaceId", "ownershipEpoch",
      "grantRevision", "issuer", "subject", "code"]);
    return denied?.ok === false && denied.protocolVersion === 1 && denied.authorityId === request.authorityId
      && denied.workspaceId === request.workspaceId && denied.ownershipEpoch === request.ownershipEpoch
      && denied.grantRevision === request.grantRevision && denied.issuer === request.issuer
      && denied.subject === request.subject && (denied.code === "denied" || denied.code === "overflow")
      ? { ok: false, code: "denied" } : { ok: false, code: "unavailable" };
  }
  const after = await currentAuthority(env, principal, authorityId);
  if (!after || after.authority_id !== before.authority_id || after.workspace_id !== before.workspace_id
    || after.ownership_epoch !== before.ownership_epoch || after.grant_revision !== before.grant_revision)
    return { ok: false, code: "denied" };
  return { ok: true, authorityId: before.authority_id, workspaceId: before.workspace_id,
    ownershipEpoch: before.ownership_epoch, grantRevision: before.grant_revision, services };
}
