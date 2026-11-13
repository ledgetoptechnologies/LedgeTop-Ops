/** Explicit controller authority, independent of usernames and flight viewing.
 * This module does not grant eligibility or infer it from a role or PA record.
 * Its storage/RPC wiring is a separately reviewed source slice. */
export type LogsDeviceAuthority = Readonly<{ eligible: boolean; revision: number | null }>;
export type LogsDeviceAuthorityEvidence = Readonly<{
  staffActive: boolean;
  nativeAdmissionActive: boolean;
  identityMatches: boolean;
  nativeAdmissionVersion: number | null;
  grantAdmissionVersion: number | null;
  effect: 'allow' | 'deny' | null;
  revision: number | null;
}>;

function version(value: number | null): value is number {
  return Number.isSafeInteger(value) && value !== null && value > 0;
}

/** A restored admission has a new version and requires an explicit regrant.
 * A missing or incoherent record is denied, never treated as a legacy allow. */
export function evaluateLogsDeviceAuthority(evidence: LogsDeviceAuthorityEvidence): LogsDeviceAuthority {
  const revision = version(evidence.revision) ? evidence.revision : null;
  return {
    eligible: revision !== null && evidence.staffActive === true
      && evidence.nativeAdmissionActive === true && evidence.identityMatches === true
      && evidence.effect === 'allow' && version(evidence.nativeAdmissionVersion)
      && evidence.grantAdmissionVersion === evidence.nativeAdmissionVersion,
    revision,
  };
}

/** Compare the revision captured at pending approval/token issuance. A later
 * grant cannot revive a controller holding a token from an earlier revision. */
export function logsDeviceRevisionCurrent(authority: LogsDeviceAuthority, issuedRevision: unknown): boolean {
  return authority.eligible === true && version(authority.revision)
    && typeof issuedRevision === 'number' && Number.isSafeInteger(issuedRevision)
    && issuedRevision > 0 && issuedRevision === authority.revision;
}
