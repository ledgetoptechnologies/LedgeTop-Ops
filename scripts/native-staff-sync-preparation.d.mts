export interface NativeStaffSyncSourceFileEvidence {
  path: string;
  sha256: string;
}

export interface NativeStaffSyncSourceEvidence {
  schemaVersion: 1;
  sourceCommit: string;
  sourceTreeSha256: string;
  moduleSha256: string;
  files: readonly NativeStaffSyncSourceFileEvidence[];
  sourceEvidenceSha256: string;
}

export interface NativeStaffSyncQualificationEvidence {
  schemaVersion: 1;
  kind: 'ops-sync-candidate-behavior-qualification-v1';
  sourceCommit: string;
  sourceTreeSha256: string;
  sourceEvidenceSha256: string;
  candidateModuleSha256: string;
  builtModuleSha256: string;
  qualificationRunnerSha256: string;
  vitestVersion: string;
  wranglerVersion: string;
  suiteCount: number;
  testCount: number;
  testReportSha256: string;
  testFiles: readonly string[];
  qualificationSha256: string;
}

export interface NativeStaffSyncWorkerObservation {
  accountId: string;
  workerName: string;
  environment: string;
  databaseId: string;
  runtimeVersion: string;
  settings: Record<string, unknown>;
  bindings: readonly { name: string; type: string; resourceId: string }[];
  moduleSha256: string;
  sourceCommit: string;
}

export interface NativeStaffSyncCohortRow {
  staffId: string;
  email: string;
  accessSubject: string;
  displayName: string;
  active: boolean;
  admissionVersion: number;
  profileVersion: number;
}

export interface NativeStaffSyncPreparationReceipt {
  schemaVersion: 1;
  kind: 'operations-native-staff-sync-dormant-preparation-v1';
  accountId: string;
  workerName: string;
  environment: string;
  databaseId: string;
  activeRuntimeVersion: string;
  candidateRuntimeVersion: string;
  activeSettingsSha256: string;
  candidateSettingsSha256: string;
  bindingsSha256: string;
  activeModuleSha256: string;
  candidateModuleSha256: string;
  activeSourceCommit: string;
  candidateSourceCommit: string;
  candidateSourceTreeSha256: string;
  sourceEvidenceSha256: string;
  behaviorQualificationSha256: string;
  testReportSha256: string;
  builtModuleSha256: string;
  qualificationRunnerSha256: string;
  controlState: 'missing' | 'disabled';
  cohortSha256: string;
  activeStaffCount: number;
  activeAlternateBindingCount: number;
  alternateBindingEvidenceSha256: string;
  currentGroupCount: number;
  currentGroupSha256: string;
  desiredGroupCount: number;
  desiredGroupSha256: string;
  receiptSha256: string;
}

export interface NativeStaffSyncAlternateBindingEvidence {
  bindingId: string;
  staffId: string;
  loginEmail: string;
  accessSubject: string;
  issuer: string;
  bindingVersion: number;
  status: 'active';
  intentId: string;
  intentStatus: 'claimed';
  intentBindingId: string;
  intentGeneration: number;
  canonicalEmail: string;
  canonicalSubject: string;
  staffStatus: 'active';
  admissionActive: 1;
  admissionSubject: string;
  profileEmail: string;
  generation: number;
  ownerGlobal: boolean;
  ownerAdminDeny: boolean;
}

export interface NativeStaffSyncPreparationInput {
  active: NativeStaffSyncWorkerObservation;
  candidate: NativeStaffSyncWorkerObservation;
  control: { tablePresent: boolean; enabled: number | null; generation: number | null; appliedGeneration: number | null;
    leaseId: string | null; leaseUntil: string | null; attemptGeneration: number | null };
  cohortBefore: { cohortSha256: string; rows: readonly NativeStaffSyncCohortRow[] };
  cohortAfter: { cohortSha256: string; rows: readonly NativeStaffSyncCohortRow[] };
  alternateBindingsBefore: { issuer: string; activeBindings: readonly NativeStaffSyncAlternateBindingEvidence[]; pendingIntentCount: number };
  alternateBindingsAfter: { issuer: string; activeBindings: readonly NativeStaffSyncAlternateBindingEvidence[]; pendingIntentCount: number };
  groupBefore: readonly string[];
  groupAfter: readonly string[];
  pins: { accountId: string; workerName: string; environment: string; databaseId: string; runtimeVersion: string;
    activeModuleSha256: string; activeSourceCommit: string; candidateModuleSha256: string; candidateSourceCommit: string;
    settingsSha256: string; bindingsSha256: string; staffAccessIssuer: string };
  sourceEvidence: NativeStaffSyncSourceEvidence;
  qualificationEvidence: NativeStaffSyncQualificationEvidence;
  repositoryRoot: string;
}

export function gitEvidenceEnvironment(): Record<string, string>;
export function deriveNativeStaffSyncSourceEvidence(input: {
  repositoryRoot: string;
  sourceCommit: string;
  moduleSha256: string;
}): NativeStaffSyncSourceEvidence;
export function compileNativeStaffSyncPreparation(input: NativeStaffSyncPreparationInput): Readonly<NativeStaffSyncPreparationReceipt>;
