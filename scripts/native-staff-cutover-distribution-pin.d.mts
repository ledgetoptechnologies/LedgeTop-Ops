export const NATIVE_STAFF_CUTOVER_DISTRIBUTION_FILES: readonly string[];
export function assertPinnedNativeStaffCutoverDistribution(options?: { read?: typeof import('node:fs').readFileSync;
  stat?: typeof import('node:fs').lstatSync; root?: string }): true;
