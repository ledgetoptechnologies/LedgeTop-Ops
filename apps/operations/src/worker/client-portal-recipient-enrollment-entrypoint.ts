import { WorkerEntrypoint } from "cloudflare:workers";
import { inspectRecipientEnrollmentIntent, redeemRecipientEnrollmentIntent } from "./client-portal-recipient-enrollment-ledger";
import type { Env } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;
export type RecipientEnrollmentRpcEnv = Pick<Env, "OPS_DB" | "ENVIRONMENT" | "EXPECTED_HOST" | "TEAM_DOMAIN"> & {
  CLIENT_PORTAL_RECIPIENT_ENROLLMENT_ENABLED?: string;
};
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Object.keys(descriptors);
    if (names.length !== keys.length || names.some(key => !keys.includes(key) || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(names.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0
  && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
function enabled(env: RecipientEnrollmentRpcEnv): boolean {
  if (env.CLIENT_PORTAL_RECIPIENT_ENROLLMENT_ENABLED !== "true" || env.ENVIRONMENT !== "staging"
    || !/(?:^|[-.])staging(?:[-.]|$)/.test(env.EXPECTED_HOST)) return false;
  try {
    const issuer = new URL(env.TEAM_DOMAIN);
    return issuer.origin === env.TEAM_DOMAIN && issuer.protocol === "https:" && issuer.hostname.endsWith(".cloudflareaccess.com");
  } catch { return false; }
}
const rejected = () => ({ ok: false as const, protocolVersion: 1 as const, code: "unavailable" as const });

export async function inspectRecipientEnrollmentRpc(env: RecipientEnrollmentRpcEnv, input: unknown) {
  if (!enabled(env)) return rejected();
  const value = exact(input, ["protocolVersion", "intentId", "opaqueToken"]);
  if (!value || value.protocolVersion !== 1 || typeof value.intentId !== "string" || !UUID.test(value.intentId)
    || typeof value.opaqueToken !== "string" || !TOKEN.test(value.opaqueToken)) return rejected();
  try {
    const result = await inspectRecipientEnrollmentIntent(env.OPS_DB, value.intentId, value.opaqueToken);
    // Deliberately omit principal (even null), issuer, email, token and owner pins.
    return { intentId: result.intentId, revision: result.revision, state: result.state, target: result.target, expiresAt: result.expiresAt };
  } catch { return rejected(); }
}

export async function redeemRecipientEnrollmentRpc(env: RecipientEnrollmentRpcEnv, input: unknown) {
  if (!enabled(env)) return rejected();
  const value = exact(input, ["protocolVersion", "intentId", "opaqueToken", "operationId", "acknowledged", "acknowledgedTarget", "principal", "verifiedUntil"]);
  const target = value && exact(value.acknowledgedTarget, ["clientRecordId", "selectionId"]);
  const principal = value && exact(value.principal, ["issuer", "subject"]);
  if (!value || value.protocolVersion !== 1 || value.acknowledged !== true
    || typeof value.intentId !== "string" || !UUID.test(value.intentId) || typeof value.operationId !== "string" || !UUID.test(value.operationId)
    || typeof value.opaqueToken !== "string" || !TOKEN.test(value.opaqueToken)
    || !target || !text(target.clientRecordId, 200) || typeof target.selectionId !== "string" || !UUID.test(target.selectionId)
    || !principal || principal.issuer !== env.TEAM_DOMAIN || !text(principal.subject)
    || typeof value.verifiedUntil !== "string" || value.verifiedUntil.length !== 24
    || !Number.isFinite(Date.parse(value.verifiedUntil)) || Date.parse(value.verifiedUntil) <= Date.now()
    || new Date(value.verifiedUntil).toISOString() !== value.verifiedUntil) return rejected();
  try {
    const result = await redeemRecipientEnrollmentIntent(env.OPS_DB, { intentId: value.intentId, opaqueToken: value.opaqueToken,
      operationId: value.operationId, principal: { issuer: env.TEAM_DOMAIN, subject: principal.subject },
      verifiedUntil: value.verifiedUntil, acknowledgedTarget: { clientRecordId: target.clientRecordId, selectionId: target.selectionId } });
    return { intentId: result.review.intentId, revision: result.review.revision, state: result.review.state };
  } catch { return rejected(); }
}

/** Private Client Worker service binding only. Never register these as HTTP. */
export class ClientPortalRecipientEnrollmentBridge extends WorkerEntrypoint<Env> {
  inspectEnrollment(input: unknown) { return inspectRecipientEnrollmentRpc(this.env, input); }
  redeemEnrollment(input: unknown) { return redeemRecipientEnrollmentRpc(this.env, input); }
}
