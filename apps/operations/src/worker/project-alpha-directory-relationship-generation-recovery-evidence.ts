import {
  sendConfiguredProjectAlphaDirectoryRelationshipCommand,
  validatedProjectAlphaDirectoryRelationshipGenerationConflict,
  type ProjectAlphaDirectoryRelationshipCommand,
} from "./project-alpha-directory-relationship-api-v2";
import { readConfiguredProjectAlphaDirectoryInventory, type ProjectAlphaDirectoryInventorySuccess }
  from "./project-alpha-directory-command-api-v2";
import {
  readConfiguredProjectAlphaDirectoryBindingStatus,
  readConfiguredProjectAlphaDirectoryProfile,
} from "./project-alpha-directory-read-api-v2";
import { resolveProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import { planDirectoryRelationshipGenerationRecovery } from "./project-alpha-directory-relationship-generation-recovery-proposal";

/**
 * This collector is evidence acquisition, not an authorization boundary.
 * Its caller MUST first prove current administrator identity, the exact live
 * allow grants (with deny precedence), and immutable terminal-predecessor
 * eligibility. Nothing returned here grants permission to reserve or send a
 * successor command.
 */
export type DirectoryRelationshipGenerationRecoveryEvidenceInput = Readonly<{
  sourceId: string;
  clientExternalId: string;
  clientPublicId: string;
  targetOrganizationExternalId: string;
  targetOrganizationPublicId: string;
  predecessorCommandJson: string;
  successorCommandId: string;
}>;

export type DirectoryRelationshipGenerationRecoveryEvidence = Readonly<{
  sourceId: string;
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  destinationOrigin: string;
  predecessorCommandId: string;
  successorCommandId: string;
  action: "assign";
  clientPublicId: string;
  clientRevision: string;
  remoteParentPublicId: null;
  targetOrganizationExternalId: string;
  targetOrganizationPublicId: string;
  targetOrganizationRevision: string;
  observedAuthorizationGeneration: string;
  replayConflictJson: string;
  replayRequestPath: string;
  conflict: Readonly<{ requestId: string; code: "authorization_generation_conflict"; requestPath: string }>;
  readRequestIds: Readonly<{ clientProfile: string; organizationProfile: string; organizationBinding: string;
    clientInventory: string; organizationInventory: string }>;
  evidenceSha256: string;
}>;

export type DirectoryRelationshipGenerationRecoveryEvidenceOutcome =
  | Readonly<{ status: "observed"; evidence: DirectoryRelationshipGenerationRecoveryEvidence;
      successorCommand: ProjectAlphaDirectoryRelationshipCommand; inventoryPagesForRootPersistence: readonly ProjectAlphaDirectoryInventorySuccess[] }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "not_eligible" | "conflict_proof" | "remote_state" | "generation" }>
  | Readonly<{ status: "uncertain"; reason: "transport_or_contract" }>;

const PUBLIC_ID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTERNAL_ID_MAX_BYTES = 764;
const MAX_INVENTORY_PAGES = 32;
const INVENTORY_PAGE_SIZE = 200;

function externalId(value: string): boolean {
  return value.length > 0 && Array.from(value).length <= 191 && !/\p{C}/u.test(value)
    && new TextEncoder().encode(value).byteLength <= EXTERNAL_ID_MAX_BYTES;
}
function canonicalOrigin(value: string): string | null {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.origin : null; }
  catch { return null; }
}
function sameIdentity(value: { sourceId: string; sourceInstanceId: string; applicationId: string; historyEpoch: string },
  expected: { sourceId: string; sourceInstanceId: string; applicationId: string; historyEpoch: string }): boolean {
  return value.sourceId === expected.sourceId && value.sourceInstanceId === expected.sourceInstanceId
    && value.applicationId === expected.applicationId && value.historyEpoch === expected.historyEpoch;
}
async function sha256(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function collectDirectoryRelationshipGenerationRecoveryEvidence(
  configuredEnvironmentSnapshot: ProjectAlphaApiV2ConnectionEnvironment,
  input: DirectoryRelationshipGenerationRecoveryEvidenceInput,
  send: typeof fetch = fetch,
): Promise<DirectoryRelationshipGenerationRecoveryEvidenceOutcome> {
  // Copy the only accepted configuration value before the first await. The
  // frozen snapshot prevents later mutation of a shared environment object.
  const rawConfiguration = configuredEnvironmentSnapshot.PROJECT_ALPHA_API_V2_CONNECTIONS;
  const env = Object.freeze({ PROJECT_ALPHA_API_V2_CONNECTIONS: rawConfiguration });
  if (typeof rawConfiguration !== "string" || !PUBLIC_ID.test(input.clientPublicId) || !externalId(input.clientExternalId)
    || !PUBLIC_ID.test(input.targetOrganizationPublicId) || !externalId(input.targetOrganizationExternalId)
    || !UUID.test(input.successorCommandId)) return { status: "blocked", reason: "configuration" };

  let configured: ReturnType<typeof resolveProjectAlphaApiV2Connection>;
  let predecessor: ProjectAlphaDirectoryRelationshipCommand;
  try {
    configured = resolveProjectAlphaApiV2Connection(env, input.sourceId);
    predecessor = JSON.parse(input.predecessorCommandJson) as ProjectAlphaDirectoryRelationshipCommand;
  } catch { return { status: "blocked", reason: "configuration" }; }
  if (!configured.enabled || typeof configured.connection.expectedHistoryEpoch !== "string")
    return { status: "blocked", reason: "configuration" };
  if (JSON.stringify(predecessor) !== input.predecessorCommandJson
    || predecessor.organization === null || predecessor.organization.externalId !== input.targetOrganizationExternalId
    || predecessor.organization.publicId !== input.targetOrganizationPublicId || predecessor.expectedCurrentOrganizationPublicId !== null)
    return { status: "blocked", reason: "not_eligible" };

  const destinationOrigin = canonicalOrigin(configured.connection.baseUrl);
  if (!destinationOrigin) return { status: "blocked", reason: "configuration" };
  const identity = { sourceId: input.sourceId, sourceInstanceId: configured.connection.expectedSourceInstanceId,
    applicationId: configured.connection.expectedApplicationId, historyEpoch: configured.connection.expectedHistoryEpoch };
  const requestPath = `/api/v2/directory/clients/${input.clientPublicId}/organization/assign/commands`;

  const replay = await sendConfiguredProjectAlphaDirectoryRelationshipCommand(env, input.sourceId, input.clientPublicId, "assign", predecessor, send);
  const proof = validatedProjectAlphaDirectoryRelationshipGenerationConflict(replay);
  if (!proof || JSON.stringify(proof.command) !== input.predecessorCommandJson || proof.destinationOrigin !== destinationOrigin
    || proof.requestPath !== requestPath || proof.response.sourceInstanceId !== identity.sourceInstanceId
    || proof.response.applicationId !== identity.applicationId || proof.response.historyEpoch !== identity.historyEpoch)
    return { status: "blocked", reason: "conflict_proof" };

  // Two explicit waves bound concurrency without erasing the distinct outcome
  // types (or allowing an unbounded inventory/read fan-out).
  const [clientResult, organizationResult] = await Promise.all([
    readConfiguredProjectAlphaDirectoryProfile(env, input.sourceId, "client", input.clientPublicId, send),
    readConfiguredProjectAlphaDirectoryProfile(env, input.sourceId, "organization", input.targetOrganizationPublicId, send),
  ]);
  const bindingResult = await readConfiguredProjectAlphaDirectoryBindingStatus(env, input.sourceId, "organization",
    input.targetOrganizationExternalId, input.targetOrganizationPublicId, send);
  if (clientResult.status !== "observed" || organizationResult.status !== "observed"
    || bindingResult.status !== "observed")
    return { status: "uncertain", reason: "transport_or_contract" };
  const client = clientResult.observation, organization = organizationResult.observation;
  const binding = bindingResult.observation;
  if (![client, organization, binding].every(value => sameIdentity(value, identity)))
    return { status: "blocked", reason: "configuration" };
  const observedGeneration = client.authorizationGeneration;
  if (organization.authorizationGeneration !== observedGeneration || binding.authorizationGeneration !== observedGeneration)
    return { status: "blocked", reason: "generation" };
  if (client.profile.publicId !== input.clientPublicId || client.profile.organizationPublicId !== null
    || client.resource.revision !== predecessor.expectedClientRevision
    || organization.profile.publicId !== input.targetOrganizationPublicId
    || organization.resource.revision !== predecessor.organization.expectedRevision
    || binding.binding.externalId !== input.targetOrganizationExternalId
    || binding.binding.publicId !== input.targetOrganizationPublicId
    || binding.resource.revision !== predecessor.organization.expectedRevision)
    return { status: "blocked", reason: "remote_state" };

  const inventoryPages: ProjectAlphaDirectoryInventorySuccess[] = [];
  let cursor: string | null = null, clientInventoryRequestId: string | null = null, organizationInventoryRequestId: string | null = null;
  let foundClient = false, foundOrganization = false;
  const seenCursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < MAX_INVENTORY_PAGES; pageNumber++) {
    const inventoryResult = await readConfiguredProjectAlphaDirectoryInventory(env, input.sourceId,
      { type: "all", limit: INVENTORY_PAGE_SIZE, cursor }, send);
    if (inventoryResult.status !== "observed") return { status: "uncertain", reason: "transport_or_contract" };
    const page = inventoryResult.inventory;
    if (!sameIdentity(page, identity)) return { status: "blocked", reason: "configuration" };
    if (page.authorizationGeneration !== observedGeneration) return { status: "blocked", reason: "generation" };
    inventoryPages.push(page);
    for (const resource of page.resources) {
      if (resource.type === "client" && resource.publicId === input.clientPublicId) {
        if (foundClient || !resource.present || resource.revision !== predecessor.expectedClientRevision
          || resource.binding?.status !== "active" || resource.binding.externalId !== input.clientExternalId
          || resource.binding.resourceRevision !== predecessor.expectedClientRevision)
          return { status: "blocked", reason: "remote_state" };
        foundClient = true; clientInventoryRequestId = page.requestId;
      }
      if (resource.type === "organization" && resource.publicId === input.targetOrganizationPublicId) {
        if (foundOrganization || !resource.present || resource.revision !== predecessor.organization.expectedRevision
          || resource.binding?.status !== "active" || resource.binding.externalId !== input.targetOrganizationExternalId
          || resource.binding.resourceRevision !== predecessor.organization.expectedRevision)
          return { status: "blocked", reason: "remote_state" };
        foundOrganization = true; organizationInventoryRequestId = page.requestId;
      }
    }
    if (foundClient && foundOrganization) break;
    if (page.nextCursor === null || seenCursors.has(page.nextCursor)) return { status: "blocked", reason: "remote_state" };
    seenCursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  if (!foundClient || !foundOrganization || clientInventoryRequestId === null || organizationInventoryRequestId === null)
    return { status: "blocked", reason: "remote_state" };

  const successor = planDirectoryRelationshipGenerationRecovery(predecessor, {
    predecessorCommandId: predecessor.commandId, successorCommandId: input.successorCommandId, action: "assign",
    predecessorState: "terminal", predecessorHttpStatus: 409,
    predecessorSource: { ...identity, destinationOrigin }, observedSource: { ...identity, destinationOrigin },
    clientPublicId: input.clientPublicId, observedClientPublicId: client.profile.publicId,
    observedClientRevision: client.resource.revision, observedCurrentOrganizationPublicId: client.profile.organizationPublicId,
    observedOrganizationBindingExternalId: binding.binding.externalId,
    observedOrganizationPublicId: organization.profile.publicId, observedOrganizationRevision: organization.resource.revision,
    observedOrganizationBindingStatus: "active", observedAuthorizationGeneration: observedGeneration,
  });
  if (!successor) return { status: "blocked", reason: "generation" };

  const replayConflictJson = JSON.stringify(proof.response);
  const unsigned = { ...identity, destinationOrigin, predecessorCommandId: predecessor.commandId,
    successorCommandId: input.successorCommandId, action: "assign" as const, clientPublicId: input.clientPublicId,
    clientRevision: client.resource.revision, remoteParentPublicId: null, targetOrganizationExternalId: input.targetOrganizationExternalId,
    targetOrganizationPublicId: input.targetOrganizationPublicId, targetOrganizationRevision: organization.resource.revision,
    observedAuthorizationGeneration: observedGeneration, replayConflictJson, replayRequestPath: proof.requestPath,
    conflict: { requestId: proof.response.requestId,
      code: proof.response.error.code, requestPath }, readRequestIds: { clientProfile: client.requestId,
      organizationProfile: organization.requestId, organizationBinding: binding.requestId,
      clientInventory: clientInventoryRequestId, organizationInventory: organizationInventoryRequestId } };
  const evidence = Object.freeze({ ...unsigned, evidenceSha256: await sha256(unsigned) });
  return { status: "observed", evidence, successorCommand: successor, inventoryPagesForRootPersistence: Object.freeze(inventoryPages) };
}
