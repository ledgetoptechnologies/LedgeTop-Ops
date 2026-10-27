export const PINNED_NATIVE_STAFF_CUTOVER_CONFIG_SHA256: string;
export function parseNativeStaffCutoverConfig(text: string, expectedSha256: string): any;
export function loadPinnedNativeStaffCutoverConfig(options?: { env?: NodeJS.ProcessEnv; read?: typeof import('node:fs').readFileSync;
  stat?: typeof import('node:fs').lstatSync }): any;
