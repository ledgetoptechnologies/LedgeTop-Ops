export interface NativeStaffAccessGroupObservation {
  schemaVersion: 1;
  kind: 'cloudflare-access-group-observation-v1';
  accountId: string;
  groupId: string;
  groupName: string;
  observedAt: string;
  managedEmailCount: number;
  managedEmailsSha256: string;
  includeRuleCount: number;
  policySha256: string;
  providerResponseSha256: string;
  evidenceSha256: string;
}
export function validateNativeStaffAccessGroupObservation(value: unknown, options?: { now?: number }): Readonly<NativeStaffAccessGroupObservation>;
export function assertNativeStaffAccessGroupStateMatches(left: unknown, right: unknown, options?: { now?: number }): true;
export function assertNativeStaffAccessGroupObservationWasReadHere(value: unknown): true;
export interface NativeStaffAccessGroupCredential { schemaVersion: 1; accountId: string; groupId: string; groupName: string; token: string }
export function readNativeStaffAccessGroupObservation(input: { config: any; getAccessGroupReadCredential: () => NativeStaffAccessGroupCredential | Promise<NativeStaffAccessGroupCredential>;
  fetchImpl?: typeof fetch; now?: () => number }): Promise<Readonly<NativeStaffAccessGroupObservation>>;
export function assertFreshNativeStaffAccessGroup(input: { config: any; reviewedBefore: unknown; reviewedAfter: unknown;
  getAccessGroupReadCredential: () => NativeStaffAccessGroupCredential | Promise<NativeStaffAccessGroupCredential>; fetchImpl?: typeof fetch; now?: () => number }): Promise<Readonly<NativeStaffAccessGroupObservation>>;
