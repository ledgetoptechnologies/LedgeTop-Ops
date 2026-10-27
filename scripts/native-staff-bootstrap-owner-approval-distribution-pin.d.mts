export const PINNED_OWNER_APPROVAL_DISTRIBUTION_SHA256: string;
export const OWNER_APPROVAL_DISTRIBUTION_MANIFEST: string;
export function assertPinnedIssuerDistribution(options?: { root?: string; expectedSha256?: string;
  read?: typeof import('node:fs').readFileSync; stat?: typeof import('node:fs').lstatSync; manifestPath?: string }): true;
