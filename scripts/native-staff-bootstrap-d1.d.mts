export type NativeStaffBootstrapManagementParam = string | number | null;
export interface NativeStaffBootstrapManagementStatement {
  sql: string;
  params: unknown[];
}
export interface NativeStaffBootstrapCompiledStatement {
  sql: string;
  params: NativeStaffBootstrapManagementParam[];
}
export interface NativeStaffBootstrapManagementBatch {
  batch: NativeStaffBootstrapCompiledStatement[];
}
export interface NativeStaffBootstrapManagementResult {
  success: boolean;
  results?: unknown[];
  meta?: Record<string, unknown>;
}
export interface NativeStaffBootstrapSnapshot {
  snapshotJson: string;
  snapshotSha256: string;
  migrationNames: readonly string[];
  migrationNamesSha256: string;
  currentStaffCount: number;
  controlPlaneStaffIds: readonly string[];
}
export interface NativeStaffBootstrapPrepared {
  approval: Record<string, unknown>;
  canonicalPlanJson: string;
  bindingEvidenceJson: string;
  reviewedSnapshot: NativeStaffBootstrapSnapshot;
  commandId: string;
  trustEnvelope: Record<string, unknown>;
  plan: {
    staffCohort: readonly string[];
    controlPlaneStaffIds: readonly string[];
    rows: readonly { table: string; row: Record<string, any> }[];
  };
  planSha256: string;
  bindingSha256: string;
}

export function readNativeStaffBootstrapSnapshot(db: unknown, proposedStaffIds?: string[]): Promise<NativeStaffBootstrapSnapshot>;
export function prepareNativeStaffBootstrapD1(input: unknown, options?: { verifyTrust?: (input: unknown) => unknown }): Promise<NativeStaffBootstrapPrepared>;
export function executeNativeStaffBootstrapD1(
  db: unknown,
  prepared: NativeStaffBootstrapPrepared,
  options?: {
    verifyTrust?: (input: unknown) => unknown;
    submitManagementBatch?: (request: NativeStaffBootstrapManagementBatch) => Promise<NativeStaffBootstrapManagementResult[]> | NativeStaffBootstrapManagementResult[];
  },
): Promise<Record<string, unknown>>;
export function compileNativeStaffBootstrapManagementBatch(statements: NativeStaffBootstrapManagementStatement[]): NativeStaffBootstrapManagementBatch;
export function submitNativeStaffBootstrapManagementBatch(
  postBatch: (request: NativeStaffBootstrapManagementBatch) => Promise<NativeStaffBootstrapManagementResult[]> | NativeStaffBootstrapManagementResult[],
  statements: NativeStaffBootstrapManagementStatement[],
): Promise<NativeStaffBootstrapManagementResult[]>;
export const nativeStaffBootstrapD1InsertColumns: Readonly<Record<string, readonly string[]>>;
