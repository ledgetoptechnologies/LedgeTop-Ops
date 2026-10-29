export type NativeStaffBootstrapReviewedSnapshot = Readonly<{
  snapshotJson: string;
  snapshotSha256: string;
  migrationNames: readonly string[];
  migrationNamesSha256: string;
  currentStaffCount: number;
  controlPlaneStaffIds: readonly string[];
}>;

export type NativeStaffBootstrapInsert = Readonly<{ table: string; row: Readonly<Record<string, string | number | null>> }>;

export type NativeStaffBootstrapArtifactComposition = Readonly<{
  artifact: Readonly<{
    canonicalPlanJson: string;
    bindingEvidenceJson: string;
    reviewedSnapshot: NativeStaffBootstrapReviewedSnapshot;
    commandId: string;
  }>;
  planSha256: string;
  bindingSha256: string;
  preservedStaff: readonly Readonly<{ role: 'owner' | 'kstirn'; staffId: string }>[];
  inactiveStaffHistorySha256: string;
}>;

export function composeNativeStaffBootstrapArtifact(input: Readonly<{
  reviewedSnapshot: NativeStaffBootstrapReviewedSnapshot;
  proposedStaffIds: readonly string[];
  controlPlaneStaffIds: readonly string[];
  preservationRoles: Readonly<{ ownerStaffId: string; kstirnStaffId: string }>;
  explicitPolicyRows?: readonly NativeStaffBootstrapInsert[];
  decisionReference: string;
  approvalId?: string;
  commandId?: string;
}>): NativeStaffBootstrapArtifactComposition;
