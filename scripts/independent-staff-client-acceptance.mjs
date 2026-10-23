import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// There is deliberately no remote mode or configurable target. Workerd/D1 are
// ephemeral and local; no Cloudflare credential or existing database is used.
if (process.argv.length !== 2) {
  console.error('Usage: node scripts/independent-staff-client-acceptance.mjs');
  process.exit(2);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../apps/operations/package.json', import.meta.url));
let executable;
try { executable = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'); }
catch { console.error('Install locked Operations dependencies first: npm ci --prefix apps/operations'); process.exit(2); }
const result = spawnSync(process.execPath, [executable, 'run', '--config', 'scripts/independent-staff-client-vitest.config.mjs'], {
  cwd: root, stdio: 'inherit', timeout: 300_000,
});
if (result.error) console.error(`Local acceptance did not complete: ${result.error.code ?? 'runner_error'}`);
process.exit(result.status ?? 1);
