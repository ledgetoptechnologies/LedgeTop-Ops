import { WorkerEntrypoint } from "cloudflare:workers";
import type { ClientPortalServiceMetadataRequestV1, ClientPortalServiceMetadataV1 } from "../../../../packages/shared/src/client-portal-service-metadata";
import { readClientPortalServiceMetadata } from "./client-portal-service-metadata";
import type { Env } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keys = ["protocolVersion", "authorityId", "workspaceId", "ownershipEpoch", "grantRevision", "issuer", "subject"] as const;
type MetadataEntrypointEnv = Pick<Env, "OPS_DB"> & { CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED?: string };

export type ClientPortalServiceMetadataEnvelopeV1 = Readonly<{
  ok: boolean; protocolVersion: 1; authorityId: string; workspaceId: string; ownershipEpoch: number;
  grantRevision: number; issuer: string; subject: string; services?: readonly ClientPortalServiceMetadataV1[];
  code?: "denied" | "overflow" | "disabled";
}> | Readonly<{ ok: false; protocolVersion: 1; code: "invalid_request" }>;

function parse(value: unknown): ClientPortalServiceMetadataRequestV1 | null {
  if (!value || typeof value !== "object") return null;
  try {
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).some(key => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Object.keys(descriptors);
    if (names.length !== keys.length || names.some(key => !keys.includes(key as typeof keys[number])
      || !("value" in descriptors[key]!))) return null;
    const row = Object.fromEntries(names.map(key => [key, descriptors[key]!.value])) as Record<string, unknown>;
    if (row.protocolVersion !== 1 || typeof row.authorityId !== "string" || !UUID.test(row.authorityId)
      || typeof row.workspaceId !== "string" || row.workspaceId.length < 1 || row.workspaceId.length > 200 || row.workspaceId.trim() !== row.workspaceId || row.workspaceId.includes("\0")
      || typeof row.issuer !== "string" || row.issuer.length < 1 || row.issuer.length > 512 || row.issuer.trim() !== row.issuer || row.issuer.includes("\0")
      || typeof row.subject !== "string" || row.subject.length < 1 || row.subject.length > 512 || row.subject.trim() !== row.subject || row.subject.includes("\0")
      || typeof row.ownershipEpoch !== "number" || !Number.isSafeInteger(row.ownershipEpoch) || row.ownershipEpoch < 1
      || typeof row.grantRevision !== "number" || !Number.isSafeInteger(row.grantRevision) || row.grantRevision < 1) return null;
    return { protocolVersion: 1, authorityId: row.authorityId, workspaceId: row.workspaceId,
      ownershipEpoch: row.ownershipEpoch, grantRevision: row.grantRevision, issuer: row.issuer, subject: row.subject };
  } catch { return null; }
}

const echo = (request: ClientPortalServiceMetadataRequestV1) => ({ protocolVersion: 1 as const,
  authorityId: request.authorityId, workspaceId: request.workspaceId, ownershipEpoch: request.ownershipEpoch,
  grantRevision: request.grantRevision, issuer: request.issuer, subject: request.subject });

export async function readClientPortalServiceMetadataRpc(env: MetadataEntrypointEnv,
  input: unknown): Promise<ClientPortalServiceMetadataEnvelopeV1> {
  const request = parse(input);
  if (!request) return { ok: false, protocolVersion: 1, code: "invalid_request" };
  if (env.CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED !== "true") return { ok: false, ...echo(request), code: "disabled" };
  const result = await readClientPortalServiceMetadata(env.OPS_DB, request);
  return result.ok ? { ok: true, ...echo(request), services: result.services }
    : { ok: false, ...echo(request), code: result.code };
}

/** Named private service-binding entrypoint. It is never mounted as HTTP. */
export class ClientPortalServiceMetadataReader extends WorkerEntrypoint<Env> {
  readServiceMetadata(input: unknown): Promise<ClientPortalServiceMetadataEnvelopeV1> {
    return readClientPortalServiceMetadataRpc(this.env, input);
  }
}
