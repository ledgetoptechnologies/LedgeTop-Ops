/**
 * Pure proposal helper only. It does not read authority, write D1, dispatch, or
 * register a route. The eventual reviewed recovery service must establish all
 * authority, source, and local-mapping fences before invoking this byte-shape
 * planner. PA external-ID uniqueness is enforced by PA when a successor is
 * sent; this helper does not claim that remote absence was observed.
 */
export type DirectoryCreateGenerationRecoveryProof = Readonly<{
  predecessorCommandId: string;
  successorCommandId: string;
  predecessorState: "terminal";
  predecessorHttpStatus: 409;
  observedAuthorizationGeneration: string;
}>;

export type DirectoryCreateCommand = Readonly<{
  operation: "create";
  commandId: string;
  resourceType: "organization" | "client";
  externalId: string;
  expectedRevision: "0";
  expectedAuthorizationGeneration: string;
  fields: Readonly<Record<string, unknown>>;
  organization?: Readonly<{ externalId:string; publicId:string; expectedRevision:string }> | null;
}>;

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GENERATION=/^(0|[1-9][0-9]{0,18})$/;
const MAX_GENERATION=9223372036854775807n;
function generation(value:string):boolean{return GENERATION.test(value)&&BigInt(value)<=MAX_GENERATION;}

export function planDirectoryCreateGenerationRecovery(predecessor:DirectoryCreateCommand,
  proof:DirectoryCreateGenerationRecoveryProof):DirectoryCreateCommand|null{
  if(!UUID.test(proof.predecessorCommandId)||!UUID.test(proof.successorCommandId)
    ||proof.predecessorCommandId===proof.successorCommandId||predecessor.commandId!==proof.predecessorCommandId
    ||predecessor.operation!=="create"||predecessor.expectedRevision!=="0"
    ||(predecessor.resourceType!=="organization"&&predecessor.resourceType!=="client")
    ||typeof predecessor.externalId!=="string"||predecessor.externalId.length<1||predecessor.externalId.length>191
    ||!generation(predecessor.expectedAuthorizationGeneration)
    ||!generation(proof.observedAuthorizationGeneration)
    ||BigInt(proof.observedAuthorizationGeneration)>=MAX_GENERATION
    ||predecessor.expectedAuthorizationGeneration===proof.observedAuthorizationGeneration
    ||proof.predecessorState!=="terminal"||proof.predecessorHttpStatus!==409)return null;
  // This is a shape-preserving plan, not frozen transport bytes. The future
  // reservation writer must canonicalize and durably freeze the complete JSON.
  return {...predecessor,commandId:proof.successorCommandId,
    expectedAuthorizationGeneration:proof.observedAuthorizationGeneration};
}
