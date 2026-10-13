import type { OperationsPortalNativeRecipientAuthorityDispatchEnv } from "./operations-portal-native-recipient-authority-dispatch";
import { finalizeOperationsPortalNativeWorkspaceCleanup } from "./operations-portal-native-workspace-cleanup";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
const MAX_ATTEMPTS = 8;
const RPC_DEADLINE_MS = 10_000;
type CleanupRow = { operation_id: string; request_fingerprint: string; canonical_wire_json: string;
  target_id: string; resulting_ownership_epoch: number; state: string; lease_token: string | null };
type RpcSuccess = { ok: true; protocolVersion: 1; status: "recorded" | "duplicate"; operationId: string;
  requestFingerprint: string; action: "workspace.revoke"; targetId: string; recipientBindingId: null;
  ownershipEpoch: number; grantRevision: null; state: "revoked"; replayed: boolean };
type RpcFailure = { ok: false; protocolVersion: 1; code: string; retryable: boolean };

function exact(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input), names = Reflect.ownKeys(descriptors);
    if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key)
      || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}
async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function parseRpc(raw: unknown): RpcSuccess | RpcFailure | null {
  if (typeof raw !== "string" || encoder.encode(raw).byteLength > 4096) return null;
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return null; }
  const failure = exact(parsed, ["ok", "protocolVersion", "code", "retryable"]);
  if (failure && failure.ok === false && failure.protocolVersion === 1 && typeof failure.code === "string"
    && typeof failure.retryable === "boolean" && JSON.stringify(parsed) === raw) return parsed as RpcFailure;
  const success = exact(parsed, ["ok", "protocolVersion", "status", "operationId", "requestFingerprint", "action",
    "targetId", "recipientBindingId", "ownershipEpoch", "grantRevision", "state", "replayed"]);
  if (!success || success.ok !== true || success.protocolVersion !== 1
    || (success.status !== "recorded" && success.status !== "duplicate")
    || typeof success.operationId !== "string" || !UUID.test(success.operationId)
    || typeof success.requestFingerprint !== "string" || !SHA256.test(success.requestFingerprint)
    || success.action !== "workspace.revoke" || typeof success.targetId !== "string" || !UUID.test(success.targetId)
    || success.recipientBindingId !== null || !Number.isSafeInteger(success.ownershipEpoch)
    || Number(success.ownershipEpoch) < 2 || success.grantRevision !== null || success.state !== "revoked"
    || typeof success.replayed !== "boolean" || JSON.stringify(parsed) !== raw) return null;
  return parsed as RpcSuccess;
}
function matches(receipt: RpcSuccess, row: CleanupRow) {
  return receipt.operationId === row.operation_id && receipt.requestFingerprint === row.request_fingerprint
    && receipt.targetId === row.target_id && receipt.ownershipEpoch === row.resulting_ownership_epoch;
}
async function withDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("native workspace cleanup rpc deadline exceeded")), RPC_DEADLINE_MS);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function claimRecoveryInvocation(session: D1DatabaseSession, invocationId: string, operationId: string,
  lease: string, now: number) {
  try {
    await session.batch([
      session.prepare(`UPDATE operations_portal_native_workspace_cleanup_outbox SET state='claimed',lease_token=?,
        lease_expires_at=?,attempts=attempts+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE operation_id=? AND state<>'acknowledged' AND ((state='pending') OR (state='claimed' AND lease_expires_at<=?))
          AND EXISTS(SELECT 1 FROM operations_portal_native_workspace_cleanup_invocations invocation
            WHERE invocation.invocation_id=? AND invocation.operation_id=? AND invocation.state='authorized')`)
        .bind(lease, now + 120_000, operationId, now, invocationId, operationId),
      session.prepare(`UPDATE operations_portal_native_workspace_cleanup_invocations SET state='claimed',claim_token=?,
        claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE invocation_id=? AND operation_id=? AND state='authorized'`)
        .bind(lease, invocationId, operationId),
      session.prepare(`INSERT INTO operations_portal_native_workspace_cleanup_invocation_audit
        (invocation_id,operation_id,request_fingerprint,target_id,root_record_id,invoked_by_staff_id,
         invoked_access_subject,invoked_email,invoked_admission_version,invoked_profile_version,
         invoked_grant_generation,invoked_verified_until,claim_token,claimed_at)
        SELECT invocation_id,operation_id,request_fingerprint,target_id,root_record_id,invoked_by_staff_id,
          invoked_access_subject,invoked_email,invoked_admission_version,invoked_profile_version,
          invoked_grant_generation,invoked_verified_until,claim_token,claimed_at
        FROM operations_portal_native_workspace_cleanup_invocations
        WHERE invocation_id=? AND operation_id=? AND state='claimed' AND claim_token=?`)
        .bind(invocationId, operationId, lease),
    ]);
  } catch { return false; }
  return Boolean(await session.prepare(`SELECT 1 FROM operations_portal_native_workspace_cleanup_invocation_audit audit
    JOIN operations_portal_native_workspace_cleanup_outbox outbox ON outbox.operation_id=audit.operation_id
    WHERE audit.invocation_id=? AND audit.operation_id=? AND audit.claim_token=?
      AND outbox.state='claimed' AND outbox.lease_token=audit.claim_token`)
    .bind(invocationId, operationId, lease).first());
}

export async function materializeOperationsPortalNativeWorkspaceCleanup(database: D1Database, operationId: string) {
  if (!UUID.test(operationId)) throw new Error("operations_portal_native_workspace_cleanup_denied");
  const row = await database.withSession("first-primary").prepare(`SELECT command.request_fingerprint,
      command.canonical_wire_json,outbox.request_fingerprint outbox_fingerprint,
      outbox.canonical_wire_json outbox_wire
    FROM operations_portal_native_workspace_cleanup_commands command
    JOIN operations_portal_native_workspace_cleanup_outbox outbox ON outbox.operation_id=command.operation_id
    WHERE command.operation_id=?`).bind(operationId).first<{ request_fingerprint: string; canonical_wire_json: string;
      outbox_fingerprint: string; outbox_wire: string }>();
  if (!row || row.request_fingerprint !== row.outbox_fingerprint || row.canonical_wire_json !== row.outbox_wire
    || await sha256(row.canonical_wire_json) !== row.request_fingerprint)
    throw new Error("operations_portal_native_workspace_cleanup_denied");
  return { operationId, requestFingerprint: row.request_fingerprint, replayed: true };
}

export async function dispatchOperationsPortalNativeWorkspaceCleanup(
  env: OperationsPortalNativeRecipientAuthorityDispatchEnv, operationId: string, recoveryInvocationId?: string,
): Promise<{ status: "disabled" | "idle" | "acknowledged" | "retry" | "rejected"; operationId?: string; code?: string }> {
  if (env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED !== "true") return { status: "disabled" };
  if (!UUID.test(operationId)) return { status: "idle" };
  if (!env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY) return { status: "retry", operationId, code: "configuration" };
  const session = env.OPS_DB.withSession("first-primary");
  const acknowledged = await session.prepare(`SELECT 1 FROM operations_portal_native_workspace_cleanup_receipts
    WHERE operation_id=?`).bind(operationId).first();
  if (acknowledged) {
    await finalizeOperationsPortalNativeWorkspaceCleanup(env.OPS_DB, operationId);
    return { status: "acknowledged", operationId };
  }
  const lease = crypto.randomUUID(), now = Date.now();
  const manualRecovery = recoveryInvocationId !== undefined;
  if (manualRecovery) {
    if (!UUID.test(recoveryInvocationId)
      || !await claimRecoveryInvocation(session, recoveryInvocationId, operationId, lease, now))
      return { status: "retry", operationId, code: "recovery-invocation-denied" };
  } else {
    await session.prepare(`UPDATE operations_portal_native_workspace_cleanup_outbox SET state='claimed',lease_token=?,
        lease_expires_at=?,attempts=attempts+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE operation_id=? AND attempts<? AND ((state='pending' AND available_at<=?)
        OR (state='claimed' AND lease_expires_at<=?))`).bind(lease, now + 120_000, operationId, MAX_ATTEMPTS, now, now).run();
  }
  const row = await session.prepare(`SELECT command.operation_id,command.target_id,command.resulting_ownership_epoch,
      outbox.request_fingerprint,outbox.canonical_wire_json,outbox.state,outbox.lease_token
    FROM operations_portal_native_workspace_cleanup_outbox outbox
    JOIN operations_portal_native_workspace_cleanup_commands command ON command.operation_id=outbox.operation_id
    WHERE outbox.operation_id=? AND outbox.state='claimed' AND outbox.lease_token=?`)
    .bind(operationId, lease).first<CleanupRow>();
  if (!row) return { status: "idle" };
  const live = await session.prepare(`SELECT 1 FROM operations_portal_native_workspace_cleanup_live_commands
    WHERE operation_id=?`).bind(operationId).first();
  let receipt: RpcSuccess | RpcFailure | null = null, ambiguous = false;
  if (!live && !manualRecovery) {
    try { receipt = parseRpc(await withDeadline(env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY.getNativeAuthorityStatus(
      JSON.stringify({ protocolVersion: 1, operationId })))); } catch { receipt = null; }
    if (!(receipt?.ok === true && matches(receipt, row))) {
      await session.prepare(`UPDATE operations_portal_native_workspace_cleanup_outbox SET state='pending',available_at=?,
        last_error='authorization-stale',lease_token=NULL,lease_expires_at=NULL
        WHERE operation_id=? AND state='claimed' AND lease_token=?`).bind(now + 300_000, operationId, lease).run();
      return { status: "retry", operationId, code: "authorization-stale" };
    }
  }
  if (!receipt) {
    try { receipt = parseRpc(await withDeadline(
      env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY.applyNativeAuthority(row.canonical_wire_json))); }
    catch { ambiguous = true; }
    if (!receipt || receipt.ok === false && receipt.retryable) ambiguous = true;
    if (ambiguous) {
      try { receipt = parseRpc(await withDeadline(env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY.getNativeAuthorityStatus(
        JSON.stringify({ protocolVersion: 1, operationId })))); } catch { receipt = null; }
    }
  }
  if (receipt?.ok === true && matches(receipt, row)) {
    try {
      await session.batch([
        session.prepare(`UPDATE operations_portal_native_workspace_cleanup_outbox SET state='acknowledged',
          lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE operation_id=? AND state='claimed' AND lease_token=?`).bind(operationId, lease),
        session.prepare(`INSERT INTO operations_portal_native_workspace_cleanup_receipts
          (operation_id,request_fingerprint,target_id,ownership_epoch,resulting_state)
          VALUES(?,?,?,?,'revoked')`).bind(operationId, row.request_fingerprint, row.target_id,
          row.resulting_ownership_epoch),
      ]);
      await finalizeOperationsPortalNativeWorkspaceCleanup(env.OPS_DB, operationId);
      return { status: "acknowledged", operationId };
    } catch {
      const saved = await session.prepare(`SELECT 1 FROM operations_portal_native_workspace_cleanup_receipts
        WHERE operation_id=?`).bind(operationId).first();
      if (saved) {
        await finalizeOperationsPortalNativeWorkspaceCleanup(env.OPS_DB, operationId);
        return { status: "acknowledged", operationId };
      }
    }
  }
  const rejected = receipt?.ok === false && !receipt.retryable;
  await session.prepare(`UPDATE operations_portal_native_workspace_cleanup_outbox SET state='pending',available_at=?,
    last_error=?,lease_token=NULL,lease_expires_at=NULL WHERE operation_id=? AND state='claimed' AND lease_token=?`)
    .bind(now + (rejected ? 300_000 : 30_000), receipt?.ok === false ? receipt.code : "transport-ambiguous",
      operationId, lease).run();
  return { status: rejected ? "rejected" : "retry", operationId,
    code: receipt?.ok === false ? receipt.code : "transport-ambiguous" };
}
