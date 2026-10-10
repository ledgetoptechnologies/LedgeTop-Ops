import {
  isProjectAlphaDirectoryRelationshipCommand,
  type ProjectAlphaDirectoryRelationshipAction,
  type ProjectAlphaDirectoryRelationshipCommand,
} from "./project-alpha-directory-relationship-api-v2";

/**
 * Pure shape planner only. This helper performs no I/O and does not establish
 * operator authority, freshness, binding ownership, or permission to dispatch.
 * Its evidence arguments must be sealed and authorized by the eventual
 * recovery service before the returned command is durably reserved.
 */

export type DirectoryRelationshipRecoverySourceEvidence = Readonly<{
  sourceId: string;
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  destinationOrigin: string;
}>;

export type DirectoryRelationshipGenerationRecoveryProof = Readonly<{
  predecessorCommandId: string;
  successorCommandId: string;
  action: ProjectAlphaDirectoryRelationshipAction;
  predecessorState: "terminal";
  predecessorHttpStatus: 409;
  predecessorSource: DirectoryRelationshipRecoverySourceEvidence;
  observedSource: DirectoryRelationshipRecoverySourceEvidence;
  clientPublicId: string;
  observedClientPublicId: string;
  observedClientRevision: string;
  observedCurrentOrganizationPublicId: string | null;
  observedOrganizationBindingExternalId: string;
  observedOrganizationPublicId: string;
  observedOrganizationRevision: string;
  observedOrganizationBindingStatus: "active" | "tombstoned";
  observedAuthorizationGeneration: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const GENERATION = /^(?:0|[1-9][0-9]{0,18})$/;
const MAX_GENERATION = 9223372036854775807n;

function generation(value: unknown): value is string {
  return typeof value === "string" && GENERATION.test(value) && BigInt(value) <= MAX_GENERATION;
}

function sameSource(left: DirectoryRelationshipRecoverySourceEvidence,
  right: DirectoryRelationshipRecoverySourceEvidence): boolean {
  return left.sourceId === right.sourceId
    && left.sourceInstanceId === right.sourceInstanceId
    && left.applicationId === right.applicationId
    && left.historyEpoch === right.historyEpoch
    && left.destinationOrigin === right.destinationOrigin;
}

function source(value: DirectoryRelationshipRecoverySourceEvidence): boolean {
  if (!SOURCE_ID.test(value.sourceId) || !UUID.test(value.sourceInstanceId)
    || !UUID.test(value.applicationId) || !UUID.test(value.historyEpoch)) return false;
  try {
    const parsed = new URL(value.destinationOrigin);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
      && parsed.origin === value.destinationOrigin;
  }
  catch { return false; }
}

export function planDirectoryRelationshipGenerationRecovery(
  predecessor: ProjectAlphaDirectoryRelationshipCommand,
  proof: DirectoryRelationshipGenerationRecoveryProof,
): ProjectAlphaDirectoryRelationshipCommand | null {
  // Remove and move require separately pinned PA contracts. The first release
  // deliberately supports only the observed simple assign case.
  if (proof.action !== "assign"
    || proof.predecessorState !== "terminal"
    || proof.predecessorHttpStatus !== 409
    || !UUID.test(proof.predecessorCommandId)
    || !UUID.test(proof.successorCommandId)
    || proof.predecessorCommandId.toLowerCase() === proof.successorCommandId.toLowerCase()
    || predecessor.commandId !== proof.predecessorCommandId
    || !isProjectAlphaDirectoryRelationshipCommand("assign", predecessor)
    || !source(proof.predecessorSource)
    || !source(proof.observedSource)
    || !sameSource(proof.predecessorSource, proof.observedSource)
    || !PUBLIC_ID.test(proof.clientPublicId)
    || proof.observedClientPublicId !== proof.clientPublicId
    || proof.observedClientRevision !== predecessor.expectedClientRevision
    || proof.observedCurrentOrganizationPublicId !== predecessor.expectedCurrentOrganizationPublicId
    || predecessor.organization === null
    || proof.observedOrganizationBindingExternalId !== predecessor.organization.externalId
    || proof.observedOrganizationPublicId !== predecessor.organization.publicId
    || proof.observedOrganizationRevision !== predecessor.organization.expectedRevision
    || proof.observedOrganizationBindingStatus !== "active"
    || !generation(predecessor.expectedAuthorizationGeneration)
    || !generation(proof.observedAuthorizationGeneration)
    || BigInt(proof.observedAuthorizationGeneration) === MAX_GENERATION
    || BigInt(proof.observedAuthorizationGeneration) <= BigInt(predecessor.expectedAuthorizationGeneration)) return null;

  const successor: ProjectAlphaDirectoryRelationshipCommand = {
    ...predecessor,
    commandId: proof.successorCommandId,
    expectedAuthorizationGeneration: proof.observedAuthorizationGeneration,
    organization: { ...predecessor.organization },
  };
  return isProjectAlphaDirectoryRelationshipCommand("assign", successor) ? successor : null;
}
