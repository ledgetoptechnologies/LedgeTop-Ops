import { authenticatedDeliveryChangeAuthoritySql } from "@ltds/shared/authenticated-delivery-authority";
import { portalProjectionSourceGuard, readPortalProjectionSourceProof } from "../../../client/src/worker/project-alpha-portal-authority";
import { d1TablesPresent } from "./schema-readiness";
import type { Env } from "./types";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const LIMIT = 20;
const TABLES = [
  "authenticated_delivery_recipient_events",
  "authenticated_delivery_recipient_event_state",
  "authenticated_delivery_recipient_event_email_controls",
  "portal_primary_staff_bindings",
  "portal_native_staff_bindings",
  "portal_native_staff_grants",
  "portal_v2_identity_eligibility_blocks",
  "pa_portal_source_authorities",
  "pa_portal_source_authority_revisions",
  "pa_portal_source_signing_keys",
  "pa_portal_source_authority_audit",
  "pa_portal_source_write_fences",
] as const;

export interface AuthenticatedDeliveryBellBatch {
  id: string;
  revision: number;
}
export interface AuthenticatedDeliveryBellDependencies {
  /** Test-only race seam, immediately before the authority/CAS batch. */
  beforeBellCommit?(): Promise<void>;
}
export type AuthenticatedDeliveryBellPublication = {
  disposition: "published" | "duplicate" | "suppressed" | "not-ready";
  revision: number | null;
};

export function authenticatedDeliveryBellEnabled(env: Pick<Env, "AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED">): boolean {
  return env.AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED === "true";
}

export async function authenticatedDeliveryBellReady(env: Env): Promise<boolean> {
  if (!(await d1TablesPresent(env.DELIVERY_DB, TABLES))) return false;
  try {
    await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT bell_published_at,bell_retry_after,email_suppressed_at
      FROM portal_authenticated_delivery_change_batches LIMIT 0`).all();
    return true;
  } catch (error) {
    if (error instanceof Error && /no such column|no such table/i.test(error.message)) return false;
    throw error;
  }
}

async function existing(env: Env, batchId: string): Promise<number | null> {
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT batch.revision
      FROM authenticated_delivery_recipient_events event
      JOIN portal_authenticated_delivery_change_batches batch ON batch.id=event.batch_id
      WHERE event.batch_id=?`).bind(batchId).first<{ revision: number }>();
  return row && Number.isSafeInteger(row.revision) ? row.revision : null;
}

function authority(env: Env): string {
  return authenticatedDeliveryChangeAuthoritySql(
    env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED === "true",
    env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED === "true",
    true,
  );
}

export type AuthenticatedDeliveryBellSourceProof = { sourceId: string; sql: string; bindings: (string | number)[] };

/** Pin the source authority before the publication race, then re-evaluate the
 * same immutable proof inside its CAS.  In particular, primary is not an
 * unguarded special case: configured legacy HMACs must still have their
 * reserved signing fingerprints. */
export async function readAuthenticatedDeliveryBellSourceProof(env: Env, batchId: string): Promise<AuthenticatedDeliveryBellSourceProof | null> {
  const db = env.DELIVERY_DB.withSession("first-primary");
  const batch = await db.prepare("SELECT source_id FROM portal_authenticated_delivery_change_batches WHERE id=?")
    .bind(batchId).first<{ source_id: string }>();
  if (!batch?.source_id) return null;
  const proof = await readPortalProjectionSourceProof(env,db,batch.source_id);
  if (!proof || proof.sourceId !== batch.source_id) return null;
  const guard = portalProjectionSourceGuard(proof);
  return { sourceId: proof.sourceId, ...guard };
}

async function suppressWithoutBell(env: Env, batch: AuthenticatedDeliveryBellBatch, source: AuthenticatedDeliveryBellSourceProof): Promise<number | null> {
  const db = env.DELIVERY_DB.withSession("first-primary");
  const result = await db.prepare(`WITH authenticated_batch_authority AS MATERIALIZED(${authority(env)}),
      authenticated_batch_source AS MATERIALIZED(SELECT 1 ok WHERE ${source.sql})
    UPDATE portal_authenticated_delivery_change_batches SET status='suppressed',sealed_at=COALESCE(sealed_at,${NOW}),
      revision=revision+1,last_error='authority-changed',lease_token=NULL,lease_expires_at=NULL,updated_at=${NOW}
    WHERE id=? AND source_id=? AND revision=? AND status='pending' AND bell_published_at IS NULL
      AND added_count+removed_count>0 AND eligible_at<=${NOW}
      AND (NOT EXISTS(SELECT 1 FROM authenticated_batch_authority)
        OR NOT EXISTS(SELECT 1 FROM authenticated_batch_source))`)
    .bind(batch.id,...source.bindings,batch.id,source.sourceId,batch.revision).run();
  if (Number(result.meta.changes) !== 1) return null;
  return batch.revision + 1;
}

/**
 * Seals exactly one ready batch and atomically records its immutable bell
 * event.  This never rediscoveres recipients and never consults R2; current
 * access is established entirely by the source/workspace/grant/binding and
 * recipient authority proof immediately inside the compare-and-swap.
 */
export async function publishAuthenticatedDeliveryChangeBellBatch(
  env: Env,
  batch: AuthenticatedDeliveryBellBatch,
  dependencies: AuthenticatedDeliveryBellDependencies = {},
): Promise<AuthenticatedDeliveryBellPublication> {
  if (!authenticatedDeliveryBellEnabled(env)) return { disposition: "not-ready", revision: null };
  if (!(await authenticatedDeliveryBellReady(env))) throw new Error("authenticated-delivery-bell-schema-unavailable");
  if (!batch.id || !Number.isSafeInteger(batch.revision) || batch.revision < 1)
    throw new Error("authenticated-delivery-bell-invalid");
  const prior = await existing(env,batch.id);
  if (prior !== null) return { disposition: "duplicate", revision: prior };
  const source = await readAuthenticatedDeliveryBellSourceProof(env,batch.id);
  // A temporarily unavailable deployment credential is not evidence that a
  // recipient lost access.  Leave it pending for the next bounded pass.
  if (!source) return { disposition: "not-ready", revision: null };
  await dependencies.beforeBellCommit?.();
  const db = env.DELIVERY_DB.withSession("first-primary");
  const eventId = crypto.randomUUID();
  try {
    const result = await db.batch([
      db.prepare(`WITH authenticated_batch_authority AS MATERIALIZED(${authority(env)})
        UPDATE portal_authenticated_delivery_change_batches SET bell_published_at=${NOW},bell_retry_after=NULL,sealed_at=COALESCE(sealed_at,${NOW}),
          revision=revision+1,updated_at=${NOW}
        WHERE id=? AND source_id=? AND revision=? AND status='pending' AND bell_published_at IS NULL
          AND added_count+removed_count>0 AND eligible_at<=${NOW} AND EXISTS(SELECT 1 FROM authenticated_batch_authority)
          AND (${source.sql})`)
        .bind(batch.id,batch.id,source.sourceId,batch.revision,...source.bindings),
      db.prepare(`INSERT INTO authenticated_delivery_recipient_events
          (id,batch_id,grant_id,grant_version,logical_grant_id,source_id,workspace_id,folder_binding_id,binding_source_version,
            owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,
            added_count,removed_count)
        SELECT ?,id,grant_id,grant_version,logical_grant_id,source_id,workspace_id,folder_binding_id,binding_source_version,
          owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,
          added_count,removed_count
        FROM portal_authenticated_delivery_change_batches WHERE id=? AND changes()=1`).bind(eventId,batch.id),
    ]);
    if (Number(result[0]?.meta.changes) === 1 && Number(result[1]?.meta.changes) === 1)
      return { disposition: "published", revision: batch.revision + 1 };
  } catch (error) {
    // An ambiguous Worker/D1 response may have committed the atomically paired
    // event.  Reading the immutable UNIQUE(batch_id) fact is safe; never retry
    // the mutation based only on an exception.
    const committed = await existing(env,batch.id);
    if (committed !== null) return { disposition: "duplicate", revision: committed };
    throw error;
  }
  const committed = await existing(env,batch.id);
  if (committed !== null) return { disposition: "duplicate", revision: committed };
  const suppressed = await suppressWithoutBell(env,batch,source);
  if (suppressed !== null) return { disposition: "suppressed", revision: suppressed };
  return { disposition: "not-ready", revision: null };
}

/** Publish ready batches before the SMTP dispatcher.  A mail outage therefore
 * cannot erase history, and old completed/cancelled batches are never read. */
export async function publishAuthenticatedDeliveryChangeBells(
  env: Env,
  dependencies: AuthenticatedDeliveryBellDependencies = {},
): Promise<number> {
  if (!authenticatedDeliveryBellEnabled(env)) return 0;
  if (!(await authenticatedDeliveryBellReady(env))) throw new Error("authenticated-delivery-bell-schema-unavailable");
  const candidates = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,revision
      FROM portal_authenticated_delivery_change_batches
      WHERE status='pending' AND bell_published_at IS NULL AND added_count+removed_count>0 AND eligible_at<=${NOW}
        AND (bell_retry_after IS NULL OR bell_retry_after<=${NOW})
      ORDER BY COALESCE(bell_retry_after,eligible_at),id LIMIT ?`).bind(LIMIT).all<AuthenticatedDeliveryBellBatch>();
  let published = 0;
  for (const batch of candidates.results) {
    const result = await publishAuthenticatedDeliveryChangeBellBatch(env,batch,dependencies);
    if (result.disposition === "published") published++;
    if (result.disposition === "not-ready") {
      // This is scheduling metadata, not suppression or a grant decision.
      // Preserve the original quiet period and revision. A concurrent content
      // or staff mutation wins; do not postpone its newly revised batch.
      // Ordering by the retry deadline also prevents starvation when cron
      // runs less frequently than the one-minute delay.
      await env.DELIVERY_DB.withSession("first-primary").prepare(`UPDATE portal_authenticated_delivery_change_batches
        SET bell_retry_after=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 minute')
        WHERE id=? AND revision=? AND status='pending' AND bell_published_at IS NULL`)
        .bind(batch.id,batch.revision).run();
    }
  }
  return published;
}

export async function suppressAuthenticatedDeliveryChangeEmail(
  env: Env,
  actorStaffId: string,
  input: { batchId: string; expectedRevision: number; idempotencyKey: string },
): Promise<{ revision: number; replayed: boolean }> {
  if (!authenticatedDeliveryBellEnabled(env)) throw new Error("authenticated-delivery-notifications-disabled");
  if (!(await authenticatedDeliveryBellReady(env))) throw new Error("authenticated-delivery-bell-schema-unavailable");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.batchId) || !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !actorStaffId)
    throw new Error("authenticated-delivery-email-suppression-invalid");
  const fingerprint = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([input.batchId,input.expectedRevision])));
  const hash = [...new Uint8Array(fingerprint)].map(value => value.toString(16).padStart(2,"0")).join("");
  const db = env.DELIVERY_DB.withSession("first-primary");
  const prior = await db.prepare(`SELECT request_fingerprint,result_revision FROM authenticated_delivery_recipient_event_email_controls
      WHERE actor_staff_id=? AND idempotency_key=?`).bind(actorStaffId,input.idempotencyKey)
    .first<{ request_fingerprint: string; result_revision: number }>();
  if (prior) {
    if (prior.request_fingerprint !== hash) throw new Error("authenticated-delivery-email-suppression-idempotency-conflict");
    return { revision: prior.result_revision, replayed: true };
  }
  const revision = input.expectedRevision + 1;
  const result = await db.batch([
    db.prepare(`UPDATE portal_authenticated_delivery_change_batches SET status='suppressed',email_suppressed_at=${NOW},
        email_suppressed_by_staff_id=?,revision=revision+1,lease_token=NULL,lease_expires_at=NULL,
        last_error='email-suppressed',updated_at=${NOW}
      WHERE id=? AND revision=? AND bell_published_at IS NOT NULL AND email_suppressed_at IS NULL
        AND status='pending'`).bind(actorStaffId,input.batchId,input.expectedRevision),
    db.prepare(`INSERT INTO authenticated_delivery_recipient_event_email_controls
        (actor_staff_id,idempotency_key,request_fingerprint,batch_id,expected_revision,result_revision)
      SELECT ?,?,?,?,?,? WHERE changes()=1`).bind(actorStaffId,input.idempotencyKey,hash,input.batchId,input.expectedRevision,revision),
  ]);
  if (Number(result[0]?.meta.changes) !== 1 || Number(result[1]?.meta.changes) !== 1)
    throw new Error("authenticated-delivery-email-suppression-conflict");
  return { revision, replayed: false };
}
