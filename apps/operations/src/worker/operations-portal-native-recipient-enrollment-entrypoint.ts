import { WorkerEntrypoint } from "cloudflare:workers";
import { inspectOperationsPortalNativeRecipientIntent, redeemOperationsPortalNativeRecipientIntent }
  from "./operations-portal-native-recipient-authority";
import type { Env } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[0-9a-f]{64}$/u;
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input), names = Reflect.ownKeys(descriptors);
    if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key)
      || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}
export type OperationsPortalNativeRecipientEnrollmentRpcEnv = Pick<Env,
  "OPS_DB" | "ENVIRONMENT" | "EXPECTED_HOST" | "TEAM_DOMAIN"> & {
  CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED?: string;
};
function enabled(env: OperationsPortalNativeRecipientEnrollmentRpcEnv): boolean {
  if (env.CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED !== "true" || env.ENVIRONMENT !== "staging"
    || !/(?:^|[-.])staging(?:[-.]|$)/u.test(env.EXPECTED_HOST)) return false;
  try { const issuer = new URL(env.TEAM_DOMAIN); return issuer.origin === env.TEAM_DOMAIN
    && issuer.protocol === "https:" && issuer.hostname.endsWith(".cloudflareaccess.com"); }
  catch { return false; }
}
const unavailable = () => JSON.stringify({ ok: false, protocolVersion: 1, code: "unavailable" });

export async function inspectOperationsPortalNativeRecipientEnrollmentRpc(
  env: OperationsPortalNativeRecipientEnrollmentRpcEnv, input: unknown,
): Promise<string> {
  if (!enabled(env)) return unavailable();
  const value = exact(input, ["protocolVersion", "intentId", "opaqueToken"]);
  if (!value || value.protocolVersion !== 1 || typeof value.intentId !== "string" || !UUID.test(value.intentId)
    || typeof value.opaqueToken !== "string" || !TOKEN.test(value.opaqueToken)) return unavailable();
  try {
    const review = await inspectOperationsPortalNativeRecipientIntent(env.OPS_DB, value.intentId, value.opaqueToken);
    const displayLabel = await env.OPS_DB.withSession("first-primary").prepare(`SELECT
      json_extract(revision.profile_json,'$.name') display_label
      FROM operations_portal_native_recipient_intents intent
      JOIN operations_directory_records record ON record.record_id=intent.target_client_record_id
      JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
      WHERE intent.intent_id=? AND record.record_kind='client'`).bind(value.intentId).first<string>("display_label");
    if (!displayLabel || displayLabel.length > 300 || /[\u0000-\u001f\u007f]/u.test(displayLabel)) return unavailable();
    return JSON.stringify({ intentId: review.intentId, revision: review.revision, state: review.state,
      target: { ...review.target, displayLabel }, expiresAt: review.expiresAt });
  } catch { return unavailable(); }
}

export async function redeemOperationsPortalNativeRecipientEnrollmentRpc(
  env: OperationsPortalNativeRecipientEnrollmentRpcEnv, input: unknown,
): Promise<string> {
  if (!enabled(env)) return unavailable();
  const value = exact(input, ["protocolVersion", "intentId", "opaqueToken", "operationId", "acknowledged",
    "acknowledgedTarget", "principal", "recipientLabel", "verifiedUntil"]);
  const target = exact(value?.acknowledgedTarget, ["targetId", "targetRevision", "clientRecordId"]);
  const principal = exact(value?.principal, ["issuer", "subject"]);
  if (!value || value.protocolVersion !== 1 || value.acknowledged !== true
    || typeof value.intentId !== "string" || !UUID.test(value.intentId)
    || typeof value.opaqueToken !== "string" || !TOKEN.test(value.opaqueToken)
    || typeof value.operationId !== "string" || !UUID.test(value.operationId) || !target || !principal
    || typeof target.targetId !== "string" || !UUID.test(target.targetId)
    || !Number.isSafeInteger(target.targetRevision) || Number(target.targetRevision) < 1
    || typeof target.clientRecordId !== "string" || target.clientRecordId.length < 1 || target.clientRecordId.length > 191
    || principal.issuer !== env.TEAM_DOMAIN || typeof principal.subject !== "string" || principal.subject.length < 1
    || principal.subject.length > 512 || typeof value.recipientLabel !== "string"
    || value.recipientLabel.length < 1 || value.recipientLabel.length > 160
    || value.recipientLabel.trim() !== value.recipientLabel || /\p{C}/u.test(value.recipientLabel)
    || typeof value.verifiedUntil !== "string") return unavailable();
  try {
    const redeemed = await redeemOperationsPortalNativeRecipientIntent(env.OPS_DB, {
      operationId: value.operationId, intentId: value.intentId, opaqueToken: value.opaqueToken,
      acknowledgedTarget: { targetId: target.targetId, targetRevision: Number(target.targetRevision),
        clientRecordId: target.clientRecordId },
      principal: { issuer: env.TEAM_DOMAIN, subject: principal.subject }, recipientLabel: value.recipientLabel,
      verifiedUntil: value.verifiedUntil,
    });
    return JSON.stringify({ intentId: redeemed.review.intentId, revision: redeemed.review.revision,
      state: redeemed.review.state });
  } catch { return unavailable(); }
}

/** Private, primitive-response RPC boundary. Returning a canonical string is
 * intentional: workerd adds Symbol.dispose to object RPC envelopes. */
export class OperationsPortalNativeRecipientEnrollmentIngress extends WorkerEntrypoint<Env> {
  inspectNativeEnrollment(input: unknown): Promise<string> {
    return inspectOperationsPortalNativeRecipientEnrollmentRpc(this.env, input);
  }
  redeemNativeEnrollment(input: unknown): Promise<string> {
    return redeemOperationsPortalNativeRecipientEnrollmentRpc(this.env, input);
  }
}
