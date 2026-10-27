export interface NativeStaffCutoverSnapshot {
  snapshotJson: string;
  snapshotSha256: string;
  migrationNames: readonly string[];
  migrationNamesSha256: string;
  currentStaffCount: number;
  controlPlaneStaffIds: readonly string[];
}

export interface NativeStaffCutoverCompiled {
  schemaVersion: 1;
  canonicalPlanJson: string;
  bindingEvidenceJson: string;
  planSha256: string;
  bindingSha256: string;
  syncPreparationReceipt: Record<string, unknown>;
  reviewedSnapshot: NativeStaffCutoverSnapshot;
  cohort: readonly NativeStaffCutoverCohortRow[];
  controlPlaneStaffIds: readonly string[];
  operator: { staffId: string; accessSubject: string };
  plan: {
    kind: 'operations-native-staff-cutover-v1';
    cohortSha256: string;
    controlPlaneStaffIds: readonly string[];
  };
  binding: {
    kind: 'operations-native-staff-binding-review-v1';
    cohortSha256: string;
    operatorStaffId: string;
    operatorSubject: string;
  };
}

export interface NativeStaffCutoverCohortRow {
  staffId: string;
  email: string;
  accessSubject: string;
  displayName: string;
  active: boolean;
  admissionVersion: number;
  profileVersion: number;
}

export interface NativeStaffCutoverPrepared {
  schemaVersion: 1;
  approval: { approvalId: string; operatorStaffId: string; operatorSubject: string; issuedAt: string; expiresAt: string };
  commandId: string;
  canonicalPlanJson: string;
  bindingEvidenceJson: string;
  reviewedSnapshot: NativeStaffCutoverSnapshot;
  trustEnvelope: Record<string, unknown>;
  controlPlaneStaffIds: readonly string[];
  operator: { staffId: string; accessSubject: string };
  syncPreparationReceipt: Record<string, unknown>;
  cohort: readonly NativeStaffCutoverCohortRow[];
  plan: NativeStaffCutoverCompiled['plan'];
  binding: NativeStaffCutoverCompiled['binding'];
  cutoverApprovalContext: Record<string, unknown>;
  cutoverApprovalContextSha256: string;
  planSha256: string;
  bindingSha256: string;
}

export function readNativeStaffCutoverSnapshot(db: unknown): Promise<NativeStaffCutoverSnapshot>;
export function compileNativeStaffCutoverV1(input: {
  reviewedSnapshot: NativeStaffCutoverSnapshot;
  controlPlaneStaffIds: string[];
  operator: { staffId: string; accessSubject: string };
  syncPreparationReceipt: Record<string, unknown>;
}): NativeStaffCutoverCompiled;
export function prepareNativeStaffCutoverD1(
  input: unknown,
  options: { db: unknown; verifyApproval: (input: unknown) => unknown; readSnapshot?: typeof readNativeStaffCutoverSnapshot },
): Promise<NativeStaffCutoverPrepared>;
export function executeNativeStaffCutoverD1(
  db: unknown,
  prepared: NativeStaffCutoverPrepared,
  options: { verifyApproval: (input: unknown) => unknown; readSnapshot?: typeof readNativeStaffCutoverSnapshot;
    beforeMutationDispatch?: (dispatch: { schemaVersion: 1; commandId: string; approvalId: string;
      snapshotSha256: string; planSha256: string; bindingSha256: string }) => Promise<void> | void },
): Promise<Record<string, unknown>>;
