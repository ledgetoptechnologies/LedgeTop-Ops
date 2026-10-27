import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PINNED_TRUST_CONFIG_SHA256, parseTrustConfig } from './native-staff-bootstrap-owner-approval.mjs';

const stop = code => { throw new Error(`native_staff_bootstrap_executor_${code}`); };

export function loadPinnedNativeStaffBootstrapExecutorConfig({ env = process.env } = {}) {
  if (!/^[0-9a-f]{64}$/u.test(PINNED_TRUST_CONFIG_SHA256) || PINNED_TRUST_CONFIG_SHA256 === '0'.repeat(64))
    stop('trust_config_pin_unprovisioned');
  const local = env.LOCALAPPDATA;
  if (typeof local !== 'string' || !local) stop('trust_config_unavailable');
  const file = path.join(local, 'LedgeTop', 'native-staff-bootstrap', 'trust-config.json');
  let text;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 32 * 1024) stop('trust_config_unavailable');
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('native_staff_bootstrap_executor_')) throw error;
    stop('trust_config_unavailable');
  }
  try { return parseTrustConfig(text, PINNED_TRUST_CONFIG_SHA256); }
  catch { stop('trust_config_pin_mismatch'); }
}
