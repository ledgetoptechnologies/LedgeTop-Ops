export const PINNED_TRUST_CONFIG_SHA256: string;
export const BOOTSTRAP_OWNER_APPROVAL_KIND: string;
export const BOOTSTRAP_APPROVAL_STATE_KIND: string;
export const BOOTSTRAP_OWNER_CONSENT_PREFIX: string;
export function canonicalJson(value: unknown): string;
export function parseTrustConfig(text: string, expectedSha256: string): any;
export function assertPinnedInstallerSource(config: any, options?: { cwd?: string; run?: typeof import('node:child_process').execFileSync;
  read?: typeof import('node:fs').readFileSync; directory?: string }): true;
export function verifyCloudflareAccessJwt(token: string, access: any, options?: { now?: number; fetchImpl?: typeof fetch }): Promise<any>;
export function runPinnedCloudflaredToken(config: any, options?: { spawn?: typeof import('node:child_process').spawnSync;
  stat?: typeof import('node:fs').lstatSync; read?: typeof import('node:fs').readFileSync; env?: NodeJS.ProcessEnv }): string;
export function validateLiveOwnerReview(reviewResponse: any, reviewedSnapshot: any, config: any, verifiedSession: any): any;
export function ownerApprovalConsentText(input: { planSha256: string; bindingEvidenceSha256: string; snapshotSha256: string; liveCohortPacketSha256: string }): string;
export function preparedOwnerApprovalConsentText(prepared: any, liveReviewProof: any): string;
export function protectedSign(payloadJson: string, config: any): string;
export function buildOwnerApprovalReceipt(input: { config: any; artifact: any; liveReview: any; ownerClaims: any;
  now?: number; authorizationChallenge: string }): { payload: any; payloadJson: string; keyId: string; algorithm: string };
export function verifyNativeStaffBootstrapOwnerApprovalReceipt(receipt: any, options: { config: any; now?: number; expected?: any }): any;
export function initializeNativeStaffBootstrapApprovalRegistry(config: any, protectedSign: (payload: string, config: any) => string): any;
export function readNativeStaffBootstrapApprovalRegistry(config: any): { envelope: any; stateSha256: string };
export function issueNativeStaffBootstrapApproval(config: any, receipt: any, protectedSign: (payload: string, config: any) => string): any;
export function revokeNativeStaffBootstrapApproval(config: any, receipt: any, protectedSign: (payload: string, config: any) => string,
  expectedStateSha256: string): any;
export function acquireNativeStaffBootstrapApprovalLease(config: any, receipt: any, protectedSign: (payload: string, config: any) => string):
  { stateSha256: string; finish(outcome: 'consumed' | 'uncertain'): void };
