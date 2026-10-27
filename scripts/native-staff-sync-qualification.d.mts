import type { NativeStaffSyncQualificationEvidence } from './native-staff-sync-preparation.mjs';

export function runNativeStaffSyncQualification(input: {
  sourceCommit: string;
  candidateModuleSha256: string;
}): NativeStaffSyncQualificationEvidence;
