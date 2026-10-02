import { WorkerEntrypoint } from "cloudflare:workers";
import {
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_RPC_RESPONSE_MAX_BYTES,
  verifyOperationsPortalWorkspacePublication,
  sha256OperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublication,
} from "@ltds/shared/operations-portal-workspace-publication";
import { consumeOperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublicationReceipt } from "./operations-portal-workspace-publications";
import { cancelOperationsPortalWorkspacePublication, getOperationsPortalWorkspacePublicationDisposition,
  OperationsPortalWorkspacePublicationCancelledError,
  type OperationsPortalWorkspacePublicationCancellation,
  type OperationsPortalWorkspacePublicationDisposition } from "./operations-portal-workspace-publication-cancellations";
import type { Env } from "./types";

type Config = Pick<Env, "DELIVERY_DB" | "CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED"> & {
  ENVIRONMENT?: string;
  EXPECTED_HOST?: string;
};
type PublishFailureCode = "disabled" | "invalid" | "conflict" | "temporarily-unavailable";
type StatusFailureCode = PublishFailureCode | "not-found";
type Failure<C extends StatusFailureCode> = Readonly<{ ok: false; protocol: "operations-portal-workspace-publication";
  protocolVersion: 1; code: C; retryable: boolean }>;
export type OperationsPortalWorkspacePublicationResult = Readonly<{ ok: true; receipt: OperationsPortalWorkspacePublicationReceipt }>
  | Readonly<{ ok: true; disposition: "cancelled"; cancellation: OperationsPortalWorkspacePublicationCancellation }>
  | Readonly<{ ok: false; protocol: "operations-portal-workspace-publication";
    protocolVersion: 1; code: PublishFailureCode; retryable: boolean }>;
export type OperationsPortalWorkspacePublicationStatusResult = Readonly<{ ok: true;
  receipt: OperationsPortalWorkspacePublicationReceipt }>
  | Readonly<{ ok: true; disposition: "cancelled"; cancellation: OperationsPortalWorkspacePublicationCancellation }>
  | Failure<StatusFailureCode>;
export type OperationsPortalWorkspacePublicationDispositionResult =
  | Readonly<{ ok: true; disposition: "committed"; receipt: OperationsPortalWorkspacePublicationReceipt }>
  | Readonly<{ ok: true; disposition: "cancelled"; cancellation: OperationsPortalWorkspacePublicationCancellation }>
  | Readonly<{ ok: true; disposition: "not-found" }>
  | Failure<StatusFailureCode>;

function failure<C extends StatusFailureCode>(code: C): Failure<C> {
  return { ok: false, protocol: "operations-portal-workspace-publication", protocolVersion: 1, code,
    retryable: code === "disabled" || code === "temporarily-unavailable" };
}
type RpcResponse = OperationsPortalWorkspacePublicationResult
  | OperationsPortalWorkspacePublicationStatusResult
  | OperationsPortalWorkspacePublicationDispositionResult;
function encodeRpcResponse(value: RpcResponse): string {
  const encoded = JSON.stringify(value);
  if (encoded.length === 0 || encoded.length > OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_RPC_RESPONSE_MAX_BYTES
    || new TextEncoder().encode(encoded).byteLength
      > OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_RPC_RESPONSE_MAX_BYTES) {
    throw new Error("operations_portal_workspace_publication_response_invalid");
  }
  return encoded;
}
function safeErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string") return descriptor.value;
    }
  } catch { /* Never serialize hostile errors, SQL, snapshots or identity data. */ }
  return "";
}

/** Rebuild a closed receipt from durable evidence, never caller-supplied success.
 * The fingerprint binds the complete customer/project/folder snapshot. */
function exactReceipt(input: unknown, publication: OperationsPortalWorkspacePublication,
  fingerprint: string): OperationsPortalWorkspacePublicationReceipt | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) return null;
    const fields = ["operationId", "publicationId", "requestFingerprint", "targetId", "resultingRevision",
      "sourceSequence", "snapshotId", "snapshotSha256", "replayed"] as const;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== fields.length || keys.some(key => typeof key !== "string"
      || !fields.includes(key as typeof fields[number]) || !("value" in descriptors[key]!)
      || descriptors[key]!.enumerable !== true)) return null;
    const values = Object.fromEntries(fields.map(field => [field, descriptors[field]!.value]));
    if (values.operationId !== publication.operationId || values.publicationId !== publication.publicationId
      || values.requestFingerprint !== fingerprint || values.targetId !== publication.target.targetId
      || values.resultingRevision !== publication.resultingRevision
      || values.sourceSequence !== publication.snapshot.sourceSequence
      || values.snapshotId !== publication.snapshot.snapshotId
      || values.snapshotSha256 !== publication.snapshot.snapshotSha256 || typeof values.replayed !== "boolean") return null;
    return { operationId: publication.operationId, publicationId: publication.publicationId,
      requestFingerprint: fingerprint, targetId: publication.target.targetId,
      resultingRevision: publication.resultingRevision, sourceSequence: publication.snapshot.sourceSequence,
      snapshotId: publication.snapshot.snapshotId, snapshotSha256: publication.snapshot.snapshotSha256,
      replayed: values.replayed };
  } catch { return null; }
}
function exactCancellation(input: unknown, publication: OperationsPortalWorkspacePublication,
  fingerprint: string): OperationsPortalWorkspacePublicationCancellation | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) return null;
    const fields = ["operationId", "publicationId", "requestFingerprint", "targetId", "targetRevision",
      "clientAuthorityId", "workspaceId", "rootKind", "rootRecordId", "expectedRevision", "resultingRevision",
      "sourceSequence", "snapshotId", "checkpointId", "snapshotSha256", "cancelledAt", "replayed"] as const;
    const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== fields.length || keys.some(key => typeof key !== "string"
      || !fields.includes(key as typeof fields[number]) || !("value" in descriptors[key]!)
      || descriptors[key]!.enumerable !== true)) return null;
    const values = Object.fromEntries(fields.map(field => [field, descriptors[field]!.value]));
    if (values.operationId !== publication.operationId || values.publicationId !== publication.publicationId
      || values.requestFingerprint !== fingerprint || values.targetId !== publication.target.targetId
      || values.targetRevision !== publication.target.targetRevision
      || values.clientAuthorityId !== publication.target.clientAuthorityId
      || values.workspaceId !== publication.target.workspaceId || values.rootKind !== publication.target.rootKind
      || values.rootRecordId !== publication.target.rootRecordId || values.expectedRevision !== publication.expectedRevision
      || values.resultingRevision !== publication.resultingRevision
      || values.sourceSequence !== publication.snapshot.sourceSequence
      || values.snapshotId !== publication.snapshot.snapshotId || values.checkpointId !== publication.snapshot.checkpointId
      || values.snapshotSha256 !== publication.snapshot.snapshotSha256 || typeof values.cancelledAt !== "string"
      || new Date(values.cancelledAt).toISOString() !== values.cancelledAt || typeof values.replayed !== "boolean") return null;
    return values as OperationsPortalWorkspacePublicationCancellation;
  } catch { return null; }
}
function exactDisposition(value: OperationsPortalWorkspacePublicationDisposition,
  publication: OperationsPortalWorkspacePublication, fingerprint: string):
    | Readonly<{ ok: true; disposition: "committed"; receipt: OperationsPortalWorkspacePublicationReceipt }>
    | Readonly<{ ok: true; disposition: "cancelled"; cancellation: OperationsPortalWorkspacePublicationCancellation }>
    | null {
  if (value.disposition === "committed") {
    const stored = exactReceipt(value.receipt, publication, fingerprint);
    return stored ? { ok: true, disposition: "committed", receipt: stored } : null;
  }
  const cancelled = exactCancellation(value.cancellation, publication, fingerprint);
  return cancelled ? { ok: true, disposition: "cancelled", cancellation: cancelled } : null;
}

export async function publishOperationsPortalWorkspaceRpc(
  env: Config, input: unknown,
): Promise<OperationsPortalWorkspacePublicationResult> {
  // Runtime fencing remains mandatory even if an account administrator creates
  // an unintended service binding. This method is not a public HTTP endpoint.
  if (env.ENVIRONMENT !== "staging" || env.EXPECTED_HOST !== "delivery-staging.ledgetopdroneservices.com"
    || env.CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED !== "true") return failure("disabled");
  try {
    const publication = await verifyOperationsPortalWorkspacePublication(input);
    if (!publication) return failure("invalid");
    const fingerprint = await sha256OperationsPortalWorkspacePublication(publication);
    const stored = await consumeOperationsPortalWorkspacePublication(env.DELIVERY_DB, publication);
    const receipt = exactReceipt(stored, publication, fingerprint);
    return receipt ? { ok: true, receipt } : failure("conflict");
  } catch (error) {
    if (error instanceof OperationsPortalWorkspacePublicationCancelledError) {
      const publication = await verifyOperationsPortalWorkspacePublication(input);
      if (!publication) return failure("invalid");
      const fingerprint = await sha256OperationsPortalWorkspacePublication(publication);
      const cancellation = exactCancellation(error.cancellation, publication, fingerprint);
      return cancellation ? { ok: true, disposition: "cancelled", cancellation } : failure("conflict");
    }
    let message = "";
    try {
      if (error instanceof Error) {
        const descriptor = Object.getOwnPropertyDescriptor(error, "message");
        if (descriptor && "value" in descriptor && typeof descriptor.value === "string") message = descriptor.value;
      }
    } catch { /* Never serialize hostile errors, SQL, snapshots or identity data. */ }
    if (message === "operations_portal_workspace_publication_invalid"
      || message === "operations_portal_workspace_publication_integer_overflow") return failure("invalid");
    if (["operations_portal_workspace_publication_conflict", "operations_portal_workspace_publication_replay_mismatch",
      "operations_portal_workspace_publication_target_revision_mismatch",
      "operations_portal_workspace_publication_commit_unverified"].includes(message)) return failure("conflict");
    return failure("temporarily-unavailable");
  }
}

export async function getOperationsPortalWorkspacePublicationStatusRpc(
  env: Config, input: unknown,
): Promise<OperationsPortalWorkspacePublicationStatusResult> {
  if (env.ENVIRONMENT !== "staging" || env.EXPECTED_HOST !== "delivery-staging.ledgetopdroneservices.com"
    || env.CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED !== "true") return failure("disabled");
  try {
    const publication = await verifyOperationsPortalWorkspacePublication(input);
    if (!publication) return failure("invalid");
    const fingerprint = await sha256OperationsPortalWorkspacePublication(publication);
    const stored = await getOperationsPortalWorkspacePublicationDisposition(env.DELIVERY_DB, publication);
    if (!stored) return failure("not-found");
    const result = exactDisposition(stored, publication, fingerprint);
    if (!result) return failure("conflict");
    return result.disposition === "committed" ? { ok: true, receipt: result.receipt } : result;
  } catch (error) {
    let message = "";
    try {
      if (error instanceof Error) {
        const descriptor = Object.getOwnPropertyDescriptor(error, "message");
        if (descriptor && "value" in descriptor && typeof descriptor.value === "string") message = descriptor.value;
      }
    } catch { /* Never serialize hostile errors, SQL, snapshots or identity data. */ }
    if (message === "operations_portal_workspace_publication_invalid"
      || message === "operations_portal_workspace_publication_integer_overflow") return failure("invalid");
    if (message === "operations_portal_workspace_publication_replay_mismatch") return failure("conflict");
    return failure("temporarily-unavailable");
  }
}

export async function cancelOperationsPortalWorkspacePublicationRpc(
  env: Config, input: unknown,
): Promise<OperationsPortalWorkspacePublicationDispositionResult> {
  if (env.ENVIRONMENT !== "staging" || env.EXPECTED_HOST !== "delivery-staging.ledgetopdroneservices.com"
    || env.CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED !== "true") return failure("disabled");
  try {
    const publication = await verifyOperationsPortalWorkspacePublication(input);
    if (!publication) return failure("invalid");
    const fingerprint = await sha256OperationsPortalWorkspacePublication(publication);
    const stored = await cancelOperationsPortalWorkspacePublication(env.DELIVERY_DB, publication);
    return exactDisposition(stored, publication, fingerprint) ?? failure("conflict");
  } catch (error) {
    const message = safeErrorMessage(error);
    if (message === "operations_portal_workspace_publication_invalid"
      || message === "operations_portal_workspace_publication_integer_overflow") return failure("invalid");
    if (["operations_portal_workspace_publication_conflict", "operations_portal_workspace_publication_replay_mismatch",
      "operations_portal_workspace_publication_commit_unverified"].includes(message)) return failure("conflict");
    return failure("temporarily-unavailable");
  }
}

export async function getOperationsPortalWorkspacePublicationDispositionRpc(
  env: Config, input: unknown,
): Promise<OperationsPortalWorkspacePublicationDispositionResult> {
  if (env.ENVIRONMENT !== "staging" || env.EXPECTED_HOST !== "delivery-staging.ledgetopdroneservices.com"
    || env.CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED !== "true") return failure("disabled");
  try {
    const publication = await verifyOperationsPortalWorkspacePublication(input);
    if (!publication) return failure("invalid");
    const fingerprint = await sha256OperationsPortalWorkspacePublication(publication);
    const stored = await getOperationsPortalWorkspacePublicationDisposition(env.DELIVERY_DB, publication);
    if (!stored) return { ok: true, disposition: "not-found" };
    return exactDisposition(stored, publication, fingerprint) ?? failure("conflict");
  } catch (error) {
    const message = safeErrorMessage(error);
    if (message === "operations_portal_workspace_publication_invalid"
      || message === "operations_portal_workspace_publication_integer_overflow") return failure("invalid");
    if (message === "operations_portal_workspace_publication_replay_mismatch") return failure("conflict");
    return failure("temporarily-unavailable");
  }
}

/** Data-only ingress. Explicit recipient enrollment and current delivery grants
 * are independent of publication; no authority is inferred from this receipt. */
export class OperationsPortalWorkspacePublicationIngress extends WorkerEntrypoint<Config> {
  async publishWorkspace(input: unknown): Promise<string> {
    return encodeRpcResponse(await publishOperationsPortalWorkspaceRpc(this.env, input));
  }
  async getPublicationStatus(input: unknown): Promise<string> {
    return encodeRpcResponse(await getOperationsPortalWorkspacePublicationStatusRpc(this.env, input));
  }
  async cancelWorkspacePublication(input: unknown): Promise<string> {
    return encodeRpcResponse(await cancelOperationsPortalWorkspacePublicationRpc(this.env, input));
  }
  async getPublicationDisposition(input: unknown): Promise<string> {
    return encodeRpcResponse(await getOperationsPortalWorkspacePublicationDispositionRpc(this.env, input));
  }
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
