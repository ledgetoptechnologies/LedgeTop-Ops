export type NativeStaffReadinessReceipt = Readonly<{ schemaVersion: 2; sourceCommit: string; accountId: string; databaseId: string;
  reviewSha256: string; cohortSha256: string; controlPlaneSha256: string; observedAt: string; staffCount: number; generation: number }>;
export type NativeStaffReadinessCohortRow = Readonly<{ staffId: string; email: string; accessSubject: string;
  displayName: string; active: boolean; admissionVersion: number; profileVersion: number }>;
export type NativeStaffBootstrapReference = Readonly<{ approvalId: string; commandId: string; canonicalPlanSha256: string;
  bindingEvidenceSha256: string; operatorStaffId: string; operatorSubject: string }>;
export type NativeStaffOnboardingReference = Readonly<{ commandId: string; resultSha256: string;
  createCommandId: string; createResultSha256: string }>;
/** Historical handoff is immutable; cohort and controlPlaneStaffIds are this
 * release's fresh reviewed state. The receipt pins the canonical current set.
 * This data type does not itself establish trusted review or grant authority. */
export type NativeStaffReadinessReview = Readonly<{ schemaVersion: 3; sourceCommit: string; accountId: string; databaseId: string;
  cohort: readonly NativeStaffReadinessCohortRow[]; controlPlaneStaffIds: readonly string[];
  handoff: Readonly<{ cohort: readonly NativeStaffReadinessCohortRow[]; controlPlaneStaffIds: readonly string[] }>;
  bootstrapReceipts: readonly NativeStaffBootstrapReference[]; onboardingReceipts: readonly NativeStaffOnboardingReference[] }>;
export const NATIVE_STAFF_PRODUCTION_TARGET: Readonly<{ accountId: string; databaseId: string; databaseName: string }>;
export const NATIVE_STAFF_READINESS_QUERIES: Readonly<Record<string, string>>;
export const NATIVE_STAFF_READINESS_SNAPSHOT_QUERY: string;
export function canonicalStaffReadiness(value: unknown): string;
export function verifyNativeStaffCutoverReadiness(review: unknown, observation: unknown, options: {
  sourceCommit: string; now?: number; maxAgeMs?: number }): NativeStaffReadinessReceipt;
export function nativeStaffReadinessEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined>;
export function readNativeStaffCutoverReadiness(options: { review: unknown; sourceCommit: string;
  read?: (args: string[], options: { cwd: string }) => Promise<unknown>; now?: () => number; env?: Record<string, string | undefined> }): Promise<NativeStaffReadinessReceipt>;
