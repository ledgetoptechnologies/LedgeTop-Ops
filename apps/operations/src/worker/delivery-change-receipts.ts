import {
  AUTHENTICATED_DELIVERY_CHANGE_CANDIDATE_LIMIT,
  authenticatedDeliveryChangeCandidatesSql,
  authenticatedDeliveryChangeNotificationsReady,
  authenticatedDeliveryNotificationsEnabled,
} from "./authenticated-delivery-change-notifications";
import { d1TablesPresent } from "./schema-readiness";
import type { Env } from "./types";

export interface AcceptedDeliveryChange {
  key: string;
  present: boolean;
  /** R2Object.version for the accepted upload, not its content ETag. */
  objectVersion: string;
  etag: string | null;
  eventAt: string;
  delivery: { queue: string; id: string };
}

export interface AcceptedDeliveryChangeSnapshot extends AcceptedDeliveryChange {
  receiptKey: string;
  sequence: number;
}

export interface AcceptedDeliveryChangeReceipt {
  receiptKey: string;
  sequence: number;
  disposition: "accepted" | "duplicate";
}

interface ReceiptRow {
  receipt_key: string;
  sequence: number;
  r2_key: string;
  object_version: string;
  object_etag: string | null;
  current_present: number;
  observed_event_at: string;
}

const RECEIPT_TABLES = [
  "portal_authenticated_delivery_change_receipts",
  "portal_authenticated_delivery_change_receipt_targets",
  "portal_authenticated_delivery_change_receipt_seals",
  "portal_authenticated_delivery_change_receipt_deliveries",
] as const;

function validateDelivery(delivery: AcceptedDeliveryChange["delivery"]): void {
  if (!delivery || [delivery.queue,delivery.id].some(value => typeof value !== "string"
    || value.length < 1 || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)))
    throw new Error("delivery-change-receipt-delivery-invalid");
}

function validateChange(input: AcceptedDeliveryChange): AcceptedDeliveryChange {
  validateDelivery(input.delivery);
  const milliseconds = typeof input.eventAt === "string" ? Date.parse(input.eventAt) : Number.NaN;
  if (typeof input.key !== "string" || !input.key || new TextEncoder().encode(input.key).byteLength > 1024
    || typeof input.present !== "boolean" || typeof input.objectVersion !== "string"
    || !input.objectVersion || input.objectVersion.trim() !== input.objectVersion || input.objectVersion.length > 512 || !Number.isFinite(milliseconds)
    || input.etag !== null && (typeof input.etag !== "string" || !input.etag.trim() || input.etag.length > 512))
    throw new Error("delivery-change-receipt-invalid");
  const etag = input.etag === null ? null : input.etag.replace(/^"|"$/g, "").trim();
  if (etag === "" || input.present && !etag) throw new Error("delivery-change-receipt-invalid");
  return { ...input, delivery: { queue: input.delivery.queue, id: input.delivery.id }, etag, eventAt: new Date(milliseconds).toISOString() };
}

async function receiptIdentity(input: AcceptedDeliveryChange): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    "authenticated-delivery-accepted:v1", input.key, input.objectVersion, input.present,
  ])));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

async function readReceipt(db: D1DatabaseSession, key: string): Promise<ReceiptRow | null> {
  return db.prepare(`SELECT receipt.receipt_key,receipt.sequence,receipt.r2_key,receipt.object_version,receipt.object_etag,receipt.current_present,receipt.observed_event_at
    FROM portal_authenticated_delivery_change_receipts receipt
    JOIN portal_authenticated_delivery_change_receipt_seals seal ON seal.receipt_key=receipt.receipt_key
    WHERE receipt.receipt_key=?`).bind(key).first<ReceiptRow>();
}

async function readDeliveryReceipt(db: D1DatabaseSession, delivery: AcceptedDeliveryChange["delivery"]): Promise<ReceiptRow | null> {
  return db.prepare(`SELECT receipt.receipt_key,receipt.sequence,receipt.r2_key,receipt.object_version,
      receipt.object_etag,receipt.current_present,receipt.observed_event_at
    FROM portal_authenticated_delivery_change_receipt_deliveries delivery
    JOIN portal_authenticated_delivery_change_receipt_seals seal ON seal.receipt_key=delivery.receipt_key
    JOIN portal_authenticated_delivery_change_receipts receipt ON receipt.receipt_key=seal.receipt_key
    WHERE delivery.queue_name=? AND delivery.message_id=?`).bind(delivery.queue,delivery.id).first<ReceiptRow>();
}

/** Consumer replay lookup before HEAD/index observation, especially after a
 * committed deletion. Requires the unchanged original queue message identity;
 * do not substitute current HEAD or a key-only/latest-receipt lookup. */
export async function readAcceptedDeliveryChangeReceipt(
  env: Env,
  message: { queue: string; id: string; key: string; present: boolean },
): Promise<AcceptedDeliveryChangeSnapshot | null> {
  validateDelivery(message);
  if (typeof message.key !== "string" || !message.key || typeof message.present !== "boolean")
    throw new Error("delivery-change-receipt-delivery-invalid");
  if (!(await d1TablesPresent(env.DELIVERY_DB, RECEIPT_TABLES))) throw new Error("delivery-change-receipts-schema-unavailable");
  const row = await readDeliveryReceipt(env.DELIVERY_DB.withSession("first-primary"), message);
  if (!row) return null;
  if (row.r2_key !== message.key || row.current_present !== Number(message.present))
    throw new Error("delivery-change-receipt-identity-conflict");
  return { receiptKey: row.receipt_key, sequence: row.sequence, key: row.r2_key, present: row.current_present === 1,
    objectVersion: row.object_version, etag: row.object_etag, eventAt: row.observed_event_at,
    delivery: { queue: message.queue, id: message.id } };
}

async function attachDeliveryAlias(db: D1DatabaseSession, change: AcceptedDeliveryChange, row: ReceiptRow): Promise<void> {
  await db.prepare(`INSERT INTO portal_authenticated_delivery_change_receipt_deliveries(queue_name,message_id,receipt_key)
    VALUES(?,?,?) ON CONFLICT(queue_name,message_id) DO NOTHING`)
    .bind(change.delivery.queue,change.delivery.id,row.receipt_key).run();
  const bound = await readDeliveryReceipt(db,change.delivery);
  if (!bound || bound.receipt_key !== row.receipt_key) throw new Error("delivery-change-receipt-identity-conflict");
}

function checkedReceipt(row: ReceiptRow, input: AcceptedDeliveryChange,
  disposition: AcceptedDeliveryChangeReceipt["disposition"]): AcceptedDeliveryChangeReceipt {
  if (row.r2_key !== input.key || row.object_version !== input.objectVersion
    || row.current_present !== Number(input.present) || row.object_etag !== input.etag
    || !Number.isSafeInteger(row.sequence) || row.sequence < 1)
    throw new Error("delivery-change-receipt-identity-conflict");
  return { receiptKey: row.receipt_key, sequence: row.sequence, disposition };
}

/** Internal acceptance primitive, not a route or a deployment gate.
 *
 * The caller must prepare ONE authoritative index CAS mutation against the
 * same DELIVERY_DB, based on its pre-HEAD index snapshot. This method executes
 * it exactly once in the transaction that captures immutable receipt/targets.
 * A zero-row CAS rolls back; replay returns the original receipt without
 * executing the mutation or rediscovering recipients. Consumer wiring and
 * durable projection remain separate rollout requirements.
 */
export async function acceptAuthenticatedDeliveryChangeReceipt(
  env: Env,
  input: AcceptedDeliveryChange,
  indexMutation: D1PreparedStatement,
): Promise<AcceptedDeliveryChangeReceipt> {
  if (!authenticatedDeliveryNotificationsEnabled(env)) throw new Error("authenticated-delivery-notifications-disabled");
  const change = validateChange(input);
  if (!(await authenticatedDeliveryChangeNotificationsReady(env)) || !(await d1TablesPresent(env.DELIVERY_DB, RECEIPT_TABLES)))
    throw new Error("delivery-change-receipts-schema-unavailable");
  const db = env.DELIVERY_DB.withSession("first-primary");
  const receiptKey = await receiptIdentity(change);
  const delivered = await readDeliveryReceipt(db,change.delivery);
  if (delivered) return checkedReceipt(delivered,change,"duplicate");
  const existing = await readReceipt(db, receiptKey);
  if (existing) {
    const result = checkedReceipt(existing, change, "duplicate");
    await attachDeliveryAlias(db,change,existing);
    return result;
  }

  const candidates = authenticatedDeliveryChangeCandidatesSql();
  const kind = change.present ? "added" : "removed";
  const candidateBindings = [change.key, kind, change.eventAt, AUTHENTICATED_DELIVERY_CHANGE_CANDIDATE_LIMIT + 1];
  // changes() is the immediately preceding index statement's result. CHECK
  // rejects 0 or >1 and rolls back the entire batch, including that mutation.
  const insertReceipt = db.prepare(`WITH candidates AS (${candidates})
    INSERT INTO portal_authenticated_delivery_change_receipts
      (receipt_key,r2_key,object_version,object_etag,current_present,observed_event_at,index_applied,candidate_count)
    VALUES(?5,?1,?6,?7,?8,?3,changes(),(SELECT count(*) FROM candidates))`)
    .bind(...candidateBindings, receiptKey, change.objectVersion, change.etag, Number(change.present));
  const insertTargets = db.prepare(`WITH candidates AS (${candidates})
    INSERT INTO portal_authenticated_delivery_change_receipt_targets
      (receipt_key,grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,
       principal_public_id,principal_source_version,access_notice_enabled,change_mode,policy_version,
       folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix)
    SELECT ?5,chosen.grant_id,chosen.grant_version,chosen.logical_grant_id,chosen.workspace_id,chosen.source_id,
      chosen.identity_id,chosen.principal_public_id,chosen.principal_source_version,chosen.access_notice_enabled,
      chosen.change_mode,chosen.policy_version,chosen.folder_binding_id,chosen.binding_source_version,
      chosen.owner_scope_type,chosen.owner_public_id,chosen.r2_prefix
    FROM candidates chosen
    WHERE length(chosen.r2_prefix)=(SELECT max(length(other.r2_prefix)) FROM candidates other WHERE other.identity_id=chosen.identity_id)
      AND (SELECT count(*) FROM candidates other WHERE other.identity_id=chosen.identity_id
        AND length(other.r2_prefix)=length(chosen.r2_prefix))=1`)
    .bind(...candidateBindings, receiptKey);
  try {
    await db.batch([indexMutation, insertReceipt, insertTargets,
      db.prepare(`INSERT INTO portal_authenticated_delivery_change_receipt_seals(receipt_key,target_count)
        SELECT ?,count(*) FROM portal_authenticated_delivery_change_receipt_targets WHERE receipt_key=?`)
        .bind(receiptKey,receiptKey),
      db.prepare(`INSERT INTO portal_authenticated_delivery_change_receipt_deliveries(queue_name,message_id,receipt_key) VALUES(?,?,?)`)
        .bind(change.delivery.queue,change.delivery.id,receiptKey),
    ]);
  } catch (error) {
    // A response can be lost after commit, or a concurrent delivery can win.
    // Confirm the sealed outcome before attaching this delivery's immutable
    // alias. Never automatically repeat the index mutation here.
    const committed = await readReceipt(db, receiptKey);
    if (committed) {
      const result = checkedReceipt(committed, change, "duplicate");
      await attachDeliveryAlias(db,change,committed);
      return result;
    }
    throw error;
  }
  const accepted = await readReceipt(db, receiptKey);
  if (!accepted) throw new Error("delivery-change-receipt-commit-unconfirmed");
  return checkedReceipt(accepted, change, "accepted");
}
