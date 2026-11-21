export interface StageOwnerAdoptionPins {
  environment: "staging";
  accountId: "df3f376bae6ee621f50cf972ebcc9484";
  databaseId: "a58ea102-f04d-417a-bfd1-b0654cfeb503";
}
export interface StageOwnerAdoptionTarget { accountId: string; databaseId: string }
export interface StageOwnerAdoptionSnapshot {
  snapshotJson: string;
  snapshotSha256: string;
  [key: string]: unknown;
}
export interface StageOwnerAdoptionApproval { approvalId: string; issuedAt: string; expiresAt: string }
export interface StageOwnerAdoptionIdentityClaims {
  staffId: string; email: string; accessSubject: string;
  /** Actual verified Access JWT exp, as UTC ISO milliseconds. */
  verifiedUntil: string;
}
export interface StageOwnerAdoptionInput {
  target: StageOwnerAdoptionTarget;
  reviewedSnapshot: { snapshotJson: string; snapshotSha256: string };
  canonicalPlanJson: string;
  approval: StageOwnerAdoptionApproval;
  commandId: string;
  ownerIdentityToken: string;
  consent: { envelope: Record<string, unknown>; proof: unknown };
}
export interface StageOwnerAdoptionVerifiers {
  verifyOwnerIdentity: (token: string) => Promise<StageOwnerAdoptionIdentityClaims> | StageOwnerAdoptionIdentityClaims;
  verifyConsent: (input: { envelope: Record<string, unknown>; envelopeSha256: string; proof: unknown }) => Promise<boolean> | boolean;
}
export type StageOwnerAdoptionPrepared = Readonly<Record<string, unknown>>;
export interface StageOwnerAdoptionBatchRequest { batch: { sql: string; params: (string | number | null)[] }[] }

export const STAGE_OWNER_ADOPTION_PLAN_KIND: string;
export const STAGE_OWNER_ADOPTION_ACTION: string;
export const STAGE_OWNER_ADOPTION_PURPOSE: string;
export const STAGE_OWNER_ADOPTION_CONSENT_PHRASE: string;
export const STAGE_OWNER_ADOPTION_TARGET_STAFF_ID: string;
export const STAGE_OWNER_ADOPTION_MIGRATIONS: Readonly<{ count: number; last: string; namesSha256: string; contentsSha256: string }>;
export const STAGE_PINS: Readonly<StageOwnerAdoptionPins>;

export function assertStageOwnerAdoptionPinsProvisioned(pins?: unknown): StageOwnerAdoptionPins;
export function readStageOwnerAdoptionSourceMigrations(directory?: string): { names: string[]; namesSha256: string; contentsSha256: string };
export function assertStageOwnerAdoptionSourceMigrations<T extends { names: string[]; namesSha256: string; contentsSha256: string }>(
  source: T, pin?: Readonly<{ count: number; last: string; namesSha256: string; contentsSha256: string }>): T;
export function readStageOwnerAdoptionSnapshot(db: unknown, target: StageOwnerAdoptionTarget): Promise<StageOwnerAdoptionSnapshot>;
export function buildStageOwnerAdoptionPlan(snapshot: StageOwnerAdoptionSnapshot, ids: { approvalId: string; commandId: string }): string;
export function stageOwnerAdoptionConsentEnvelope(input: {
  snapshot: StageOwnerAdoptionSnapshot; canonicalPlanJson: string; approval: StageOwnerAdoptionApproval; commandId: string;
}): Record<string, unknown>;
export function prepareStageOwnerAdoption(
  input: StageOwnerAdoptionInput,
  options: Partial<StageOwnerAdoptionVerifiers> & { now?: () => number },
): Promise<StageOwnerAdoptionPrepared>;
export function executeStageOwnerAdoption(
  db: unknown,
  prepared: StageOwnerAdoptionPrepared,
  options: Partial<StageOwnerAdoptionVerifiers> & {
    ownerIdentityToken?: string;
    submitBatch?: (request: StageOwnerAdoptionBatchRequest, target: StageOwnerAdoptionTarget) => Promise<unknown[]> | unknown[];
    now?: () => number;
  },
): Promise<Readonly<Record<string, unknown>>>;
