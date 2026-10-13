import { WorkerEntrypoint } from "cloudflare:workers";
import {
  parseVerifiedRecipientDeliveryAuthorityCommand,
  parseVerifiedRecipientDeliveryAuthorityReceipt,
  VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL,
  VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL_VERSION,
  type VerifiedRecipientDeliveryAuthorityReceipt,
} from "@ltds/shared/verified-recipient-delivery-authority";
import {
  applyVerifiedRecipientDeliveryAuthority,
  getVerifiedRecipientDeliveryAuthorityStatus,
} from "./verified-recipient-delivery-authority";

type Config = Parameters<typeof applyVerifiedRecipientDeliveryAuthority>[0] & {
  ENVIRONMENT?: string; EXPECTED_HOST?: string;
};
type FailureCode = "disabled" | "invalid" | "conflict" | "not_found" | "temporarily-unavailable";
export type VerifiedRecipientDeliveryAuthorityRpcResult =
  | Readonly<{ ok: true; receipt: VerifiedRecipientDeliveryAuthorityReceipt }>
  | Readonly<{
      ok: false;
      protocol: typeof VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL;
      protocolVersion: typeof VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL_VERSION;
      code: FailureCode;
      retryable: boolean;
    }>;

function failure(code: FailureCode): VerifiedRecipientDeliveryAuthorityRpcResult {
  return {
    ok: false,
    protocol: VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL,
    protocolVersion: VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL_VERSION,
    code,
    retryable: code === "disabled" || code === "temporarily-unavailable",
  };
}

function storageFailure(error: unknown): VerifiedRecipientDeliveryAuthorityRpcResult {
  let code = "";
  try {
    if (error instanceof Error) {
      const message = Object.getOwnPropertyDescriptor(error, "message");
      if (message && "value" in message && typeof message.value === "string") code = message.value;
    }
  } catch { /* Hostile error objects must not escape the sanitized RPC boundary. */ }
  if (code.endsWith("-disabled")) return failure("disabled");
  if (code === "verified-recipient-delivery-authority-invalid") return failure("invalid");
  if (code === "verified-recipient-delivery-authority-operation-conflict"
    || code === "verified-recipient-delivery-authority-cas-conflict"
    || code === "verified-recipient-delivery-authority-current-proof-missing"
    || code === "verified-recipient-delivery-authority-owner-proof-expired") return failure("conflict");
  // Never serialize database errors, issuer/subject, or private command bytes.
  return failure("temporarily-unavailable");
}

async function invoke(env: Config, input: unknown, action: "apply" | "status"):
Promise<VerifiedRecipientDeliveryAuthorityRpcResult> {
  const flag = action === "apply"
    ? env.CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED
    : env.CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED;
  if (env.ENVIRONMENT !== "staging" || env.EXPECTED_HOST !== "delivery-staging.ledgetopdroneservices.com"
    || flag !== "true") return failure("disabled");
  let command;
  try { command = parseVerifiedRecipientDeliveryAuthorityCommand(input); }
  catch { return failure("invalid"); }
  if (!command) return failure("invalid");
  try {
    const stored = action === "apply"
      ? await applyVerifiedRecipientDeliveryAuthority(env, command)
      : await getVerifiedRecipientDeliveryAuthorityStatus(env, command);
    if (stored === null) return failure("not_found");
    // The helper supplies durable receipt evidence. Do not manufacture a
    // successful receipt from the caller's command or a revision-only summary.
    const receipt = parseVerifiedRecipientDeliveryAuthorityReceipt(stored, command);
    return receipt ? { ok: true, receipt } : failure("conflict");
  } catch (error) { return storageFailure(error); }
}

export function applyVerifiedRecipientDeliveryAuthorityRpc(env: Config, input: unknown) {
  return invoke(env, input, "apply");
}
export function getVerifiedRecipientDeliveryAuthorityStatusRpc(env: Config, input: unknown) {
  return invoke(env, input, "status");
}

/** Exported only as a private named RPC for reviewed staging service bindings.
 * Runtime staging, exact-host, and action flags remain mandatory; no authority
 * method is exposed through the Worker's HTTP surface. */
export class VerifiedRecipientDeliveryAuthorityIngress extends WorkerEntrypoint<Config> {
  applyAuthority(input: unknown) {
    return applyVerifiedRecipientDeliveryAuthorityRpc(this.env, input);
  }
  getAuthorityStatus(input: unknown) {
    return getVerifiedRecipientDeliveryAuthorityStatusRpc(this.env, input);
  }
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
