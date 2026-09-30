import { WorkerEntrypoint } from "cloudflare:workers";
import {
  verifyOperationsPortalWorkspacePublication,
  sha256OperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublication,
} from "@ltds/shared/operations-portal-workspace-publication";
import { consumeOperationsPortalWorkspacePublication,
  getOperationsPortalWorkspacePublicationStatus,
  type OperationsPortalWorkspacePublicationReceipt } from "./operations-portal-workspace-publications";
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
  | Readonly<{ ok: false; protocol: "operations-portal-workspace-publication";
    protocolVersion: 1; code: PublishFailureCode; retryable: boolean }>;
export type OperationsPortalWorkspacePublicationStatusResult = Readonly<{ ok: true;
  receipt: OperationsPortalWorkspacePublicationReceipt }>| Failure<StatusFailureCode>;

function failure<C extends StatusFailureCode>(code: C): Failure<C> {
  return { ok: false, protocol: "operations-portal-workspace-publication", protocolVersion: 1, code,
    retryable: code === "disabled" || code === "temporarily-unavailable" };
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
      || !fields.includes(key as typeof fields[number]) || !("value" in descriptors[key]!))) return null;
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
    const stored = await getOperationsPortalWorkspacePublicationStatus(env.DELIVERY_DB, publication);
    if (!stored) return failure("not-found");
    const receipt = exactReceipt(stored, publication, fingerprint);
    return receipt ? { ok: true, receipt } : failure("conflict");
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

/** Data-only ingress. Explicit recipient enrollment and current delivery grants
 * are independent of publication; no authority is inferred from this receipt. */
export class OperationsPortalWorkspacePublicationIngress extends WorkerEntrypoint<Config> {
  publishWorkspace(input: unknown) { return publishOperationsPortalWorkspaceRpc(this.env, input); }
  getPublicationStatus(input: unknown) { return getOperationsPortalWorkspacePublicationStatusRpc(this.env, input); }
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
