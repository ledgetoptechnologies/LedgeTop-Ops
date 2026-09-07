import { HTTPException } from "hono/http-exception";
import { isAdministrator } from "./acl";
import { portalDenyPolicyManagementEnabled } from "./client-portal-deny-policies";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { isBusinessProjectionSource } from "./client-hub-source";
import type { Env, StaffPrincipal } from "./types";

const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const REASON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

async function fingerprint(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export interface PortalRootAccessView {
  available: boolean;
  state: "active" | "revoked";
  version: number;
  reasonCode: string | null;
  updatedAt: string | null;
  canRevoke: boolean;
  canRestore: boolean;
}

/**
 * Fail-closed authorization predicate for projected portal workspaces.
 *
 * Keep this out of staff/audit reads so a revoked root remains visible and can
 * be restored. Runtime access, recipient discovery, grant issuance, and
 * notifications should include it whenever the coordinated policy flag is on.
 */
export function portalRootAccessAllowedSql(env: Pick<Env, "CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED">,
  workspaceAlias = "workspace"): string {
  if (env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED !== "true") return "1=1";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(workspaceAlias))
    throw new Error("Invalid portal workspace SQL alias");
  return `NOT EXISTS (SELECT 1 FROM portal_v2_root_access_policies root_policy
    WHERE root_policy.projection_source_id=${workspaceAlias}.project_alpha_source_id
      AND root_policy.root_type=${workspaceAlias}.root_type
      AND root_policy.root_public_id=COALESCE(${workspaceAlias}.pa_organization_public_id,${workspaceAlias}.pa_client_public_id)
      AND root_policy.state='revoked')`;
}

function tuple(context: ClientHubCollectionContext) {
  if (context.root.root_namespace !== "business" || !context.root.pa_public_id
    || !isBusinessProjectionSource(context.root.source_id)) return null;
  return { sourceId: context.root.source_id, rootType: context.root.kind, rootPublicId: context.root.pa_public_id };
}

export async function readPortalRootAccess(env: Env, actor: StaffPrincipal,
  context: ClientHubCollectionContext): Promise<PortalRootAccessView> {
  const root = tuple(context);
  const enabled = env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED === "true";
  const manageable = enabled && portalDenyPolicyManagementEnabled(env) && await isAdministrator(env, actor);
  if (!root) return { available: false, state: "active", version: 0, reasonCode: null,
    updatedAt: null, canRevoke: false, canRestore: false };
  if (!enabled) return { available: false, state: "active", version: 0, reasonCode: null,
    updatedAt: null, canRevoke: false, canRestore: false };
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT state,version,reason_code,updated_at
    FROM portal_v2_root_access_policies WHERE projection_source_id=? AND root_type=? AND root_public_id=?`)
    .bind(root.sourceId, root.rootType, root.rootPublicId)
    .first<{ state: "active" | "revoked"; version: number; reason_code: string; updated_at: string }>();
  const state = row?.state ?? "active";
  return { available: true, state, version: row?.version ?? 0, reasonCode: row?.reason_code ?? null,
    updatedAt: row?.updated_at ?? null, canRevoke: manageable && state === "active",
    canRestore: manageable && state === "revoked" };
}

export async function mutatePortalRootAccess(env: Env, actor: StaffPrincipal,
  context: ClientHubCollectionContext, input: { action: "revoke" | "restore"; expectedContextVersion: string;
    expectedVersion: number; reasonCode: string }, idempotencyKey: string,
  assertLiveContext: () => Promise<void>) {
  if (env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED !== "true" || !portalDenyPolicyManagementEnabled(env)
    || !await isAdministrator(env, actor))
    throw new HTTPException(403, { message: "Administrator access is required" });
  const root = tuple(context);
  if (!root) throw new HTTPException(409, { message: "An exact Project Alpha client root is required" });
  if (input.expectedContextVersion !== context.contextVersion || !Number.isSafeInteger(input.expectedVersion)
    || input.expectedVersion < 0 || !REASON.test(input.reasonCode) || !IDEMPOTENCY.test(idempotencyKey))
    throw new HTTPException(400, { message: "Portal root access request is invalid" });
  const normalized = { ...root, action: input.action, expectedVersion: input.expectedVersion, reasonCode: input.reasonCode };
  const requestFingerprint = await fingerprint(JSON.stringify(normalized));
  const db = env.DELIVERY_DB.withSession("first-primary");
  const prior = await db.prepare(`SELECT action,request_fingerprint,result_version FROM portal_v2_root_access_policy_mutations
    WHERE actor_staff_id=? AND idempotency_key=?`).bind(actor.id, idempotencyKey)
    .first<{ action: string; request_fingerprint: string; result_version: number }>();
  const action = input.action === "revoke" ? "root.revoke" : "root.restore";
  if (prior) {
    if (prior.action !== action || prior.request_fingerprint !== requestFingerprint)
      throw new HTTPException(409, { message: "Idempotency-Key was already used for another portal access request" });
    return { outcome: input.action === "revoke" ? "root_access_revoked" : "root_access_restored",
      version: prior.result_version, replayed: true };
  }
  const current = await db.prepare(`SELECT state,version FROM portal_v2_root_access_policies
    WHERE projection_source_id=? AND root_type=? AND root_public_id=?`)
    .bind(root.sourceId, root.rootType, root.rootPublicId).first<{ state: "active" | "revoked"; version: number }>();
  const currentVersion = current?.version ?? 0;
  const desired = input.action === "revoke" ? "revoked" : "active";
  if (currentVersion !== input.expectedVersion)
    throw new HTTPException(409, { message: "Portal access changed. Refresh the client workspace and try again" });
  if (input.action === "restore" && (!current || current.state !== "revoked"))
    throw new HTTPException(409, { message: "Portal access is not revoked for this client root" });
  if (input.action === "revoke" && current?.state === "revoked")
    throw new HTTPException(409, { message: "Portal access is already revoked for this client root" });
  const lock = await db.prepare("SELECT version FROM portal_v2_root_access_policy_lock WHERE id=1")
    .first<number>("version");
  if (lock === null || !Number.isSafeInteger(lock))
    throw new HTTPException(503, { message: "Portal access safety state is unavailable" });
  const resultVersion = currentVersion + 1, operationId = crypto.randomUUID(), nextLock = lock + 1;
  // OPS_DB permissions/source ownership and DELIVERY_DB workspace mapping are
  // independent live inputs. Reuse the canonical Client Hub verifier after all
  // preparatory reads and immediately before the Delivery compare-and-swap.
  // The batch below then fences Delivery policy/version changes at commit; a
  // post-write verification could only detect an unauthorized mutation after
  // its audit and idempotency receipt had already become durable.
  await assertLiveContext();
  try {
    await db.batch([
      db.prepare(`UPDATE portal_v2_root_access_policy_lock SET version=version+1,operation_id=?,updated_at=datetime('now')
        WHERE id=1 AND version=?`).bind(operationId, lock),
      db.prepare(`INSERT INTO portal_v2_root_access_policies
          (projection_source_id,root_type,root_public_id,state,version,reason_code,last_operation_id,created_by_staff_id,updated_by_staff_id)
        SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(
          SELECT 1 FROM portal_v2_root_access_policy_lock WHERE id=1 AND version=? AND operation_id=?
        )
        ON CONFLICT(projection_source_id,root_type,root_public_id) DO UPDATE SET state=excluded.state,
          version=excluded.version,reason_code=excluded.reason_code,last_operation_id=excluded.last_operation_id,
          updated_by_staff_id=excluded.updated_by_staff_id,
          updated_at=datetime('now') WHERE portal_v2_root_access_policies.version=?`)
        .bind(root.sourceId, root.rootType, root.rootPublicId, desired, resultVersion, input.reasonCode,
          operationId, actor.id, actor.id, nextLock, operationId, currentVersion),
      db.prepare(`INSERT INTO portal_v2_root_access_policy_audit
          (operation_id,projection_source_id,root_type,root_public_id,action,version,reason_code,actor_staff_id)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(
          SELECT 1 FROM portal_v2_root_access_policies
          WHERE projection_source_id=? AND root_type=? AND root_public_id=? AND version=? AND state=?
            AND last_operation_id=?
        )`).bind(operationId, root.sourceId, root.rootType,
          root.rootPublicId, input.action === "revoke" ? "root.revoked" : "root.restored", resultVersion,
          input.reasonCode, actor.id, root.sourceId, root.rootType, root.rootPublicId, resultVersion, desired, operationId),
      db.prepare(`INSERT INTO portal_v2_root_access_policy_mutations
          (actor_staff_id,idempotency_key,action,request_fingerprint,projection_source_id,root_type,root_public_id,result_version)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM portal_v2_root_access_policy_audit WHERE operation_id=?)`)
        .bind(actor.id, idempotencyKey, action, requestFingerprint, root.sourceId, root.rootType, root.rootPublicId,
          resultVersion, operationId),
    ]);
  } catch (error) {
    if (/UNIQUE|constraint/i.test(String(error)))
      throw new HTTPException(409, { message: "Portal access changed. Refresh the client workspace and try again" });
    throw error;
  }
  const committed = await db.prepare(`SELECT result_version FROM portal_v2_root_access_policy_mutations
    WHERE actor_staff_id=? AND idempotency_key=? AND request_fingerprint=?`)
    .bind(actor.id, idempotencyKey, requestFingerprint).first<number>("result_version");
  if (committed !== resultVersion)
    throw new HTTPException(409, { message: "Portal access changed. Refresh the client workspace and try again" });
  return { outcome: input.action === "revoke" ? "root_access_revoked" : "root_access_restored",
    version: resultVersion, replayed: false };
}
