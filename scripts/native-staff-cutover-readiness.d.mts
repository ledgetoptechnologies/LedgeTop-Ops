export type NativeStaffReadinessReceipt = Readonly<{ schemaVersion: 1; sourceCommit: string; accountId: string; databaseId: string;
  reviewSha256: string; cohortSha256: string; observedAt: string; staffCount: number; generation: number }>;
export const NATIVE_STAFF_PRODUCTION_TARGET: Readonly<{ accountId: string; databaseId: string; databaseName: string }>;
export const NATIVE_STAFF_READINESS_QUERIES: Readonly<Record<string, string>>;
export const NATIVE_STAFF_READINESS_SNAPSHOT_QUERY: string;
export function canonicalStaffReadiness(value: unknown): string;
export function verifyNativeStaffCutoverReadiness(review: unknown, observation: unknown, options: {
  sourceCommit: string; now?: number; maxAgeMs?: number }): NativeStaffReadinessReceipt;
export function nativeStaffReadinessEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined>;
export function readNativeStaffCutoverReadiness(options: { review: unknown; sourceCommit: string;
  read?: (args: string[], options: { cwd: string }) => Promise<unknown>; now?: () => number; env?: Record<string, string | undefined> }): Promise<NativeStaffReadinessReceipt>;
