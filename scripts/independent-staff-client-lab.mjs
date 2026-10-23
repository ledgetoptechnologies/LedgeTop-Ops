import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../apps/operations/package.json', import.meta.url));
const port = process.argv.length === 2 ? 8789 : process.argv.length === 4 && process.argv[2] === '--port' ? Number(process.argv[3]) : NaN;
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('Usage: node scripts/independent-staff-client-lab.mjs [--port 8789]');
  process.exit(2);
}
const output = join(root, 'apps/operations/node_modules/.cache/independent-staff-client-lab/server.mjs');
await mkdir(join(output, '..'), { recursive: true });
const { build } = require('esbuild');
await build({ entryPoints: [join(root, 'scripts/independent-staff-client-lab-server.ts')],
  outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
  alias: { '@ltds/shared': join(root, 'packages/shared/src/index.ts') },
  define: { LAB_PORT: String(port), 'import.meta.url': JSON.stringify(pathToFileURL(join(root, 'scripts/independent-staff-client-fixture.ts')).href) }, logLevel: 'warning' });
const child = spawn(process.execPath, [output], { stdio: 'inherit', cwd: root });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
