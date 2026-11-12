// Generates the asset-only retirement facade for ONE old staging Worker from Merger's installed-version readback.
//   node scripts/legacy-staging-retirement/generate.mjs <spec.json> <out-dir>
// spec.json (all fields required, from read-only provider readback of the INSTALLED version, never source):
//   { "worker": "ledgetop-ops-staging", "installedVersionId": "<uuid>", "bindings": ["ASSETS"],
//     "exports": [{ "name": "ThumbnailRendererContainer", "kind": "durable_object" | "workflow" | "entrypoint" }],
//     "files": [{ "path": "/assets/app-1a2b.js", "size": 123, "sha256": "<64 hex>", "mime": "text/javascript", "binding": "ASSETS" }] }
// Writes <out-dir>/index.mjs (single module, no imports except cloudflare:workers) and <out-dir>/receipt.json.
// Nothing here talks to a provider; Merger owns verification, upload (keep_assets) and the cutoff.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateRetirePolicy } from './retire-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;
const KINDS = new Set(['durable_object', 'workflow', 'entrypoint']);
const RESERVED = new Set(['default', 'DurableObject', 'WorkflowEntrypoint', 'WorkerEntrypoint', 'POLICY', 'FILES',
  'validateRetirePolicy', 'handleRetiredRequest', 'RETIRE_LIMITS', 'gone', 'unavailable', 'sha256Hex']);
export const RETENTION_HOURS = 48;
const sha256 = text => createHash('sha256').update(text).digest('hex');

export function validateSpec(spec) {
  const fail = message => { throw new Error(`retire_spec_invalid: ${message}`); };
  if (!spec || typeof spec !== 'object' || Object.keys(spec).sort().join(',') !== 'bindings,exports,files,installedVersionId,worker') fail('top-level keys');
  validateRetirePolicy({ worker: spec.worker, installedVersionId: spec.installedVersionId, bindings: spec.bindings, files: spec.files });
  if (!Array.isArray(spec.exports)) fail('exports');
  const names = new Set();
  for (const item of spec.exports) {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'kind,name') fail('export shape');
    if (!IDENT.test(item.name) || RESERVED.has(item.name)) fail(`export name ${item.name}`);
    if (!KINDS.has(item.kind)) fail(`export kind ${item.kind}`);
    if (names.has(item.name)) fail(`duplicate export ${item.name}`);
    names.add(item.name);
  }
  return spec;
}

function pinnedPolicy(spec) {
  return { worker: spec.worker, installedVersionId: spec.installedVersionId, bindings: [...spec.bindings],
    files: [...spec.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

/** Builds the facade module source: the inlined core, the pinned policy, a fetch-only default and inert exports. */
export function buildFacadeSource(spec) {
  validateSpec(spec);
  const core = fs.readFileSync(path.join(here, 'retire-core.mjs'), 'utf8')
    .replace(/^\/\/.*\n/gmu, '').replace(/^export (const|function|async function) /gmu, '$1 ');
  const policy = pinnedPolicy(spec);
  const inert = spec.exports.map(({ name, kind }) => kind === 'durable_object'
    ? `export class ${name} extends DurableObject {\n  async fetch() { return gone(); }\n  async alarm() {}\n}`
    : kind === 'workflow'
      ? `export class ${name} extends WorkflowEntrypoint {\n  async run() { throw new Error('worker_retired'); }\n}`
      : `export class ${name} extends WorkerEntrypoint {\n  async fetch() { return gone(); }\n}`).join('\n\n');
  return `// GENERATED asset-only retirement facade for ${spec.worker} (installed version ${spec.installedVersionId}).
// Serves only the pinned retained static files below, byte-verified; everything else is 410 Gone.
// No scheduled, queue or email handlers: crons and queue consumers do nothing. Inert classes keep the exact
// exported names so Durable Object namespaces, Workflow and service bindings stay valid with no side effects.
import { DurableObject, WorkflowEntrypoint, WorkerEntrypoint } from 'cloudflare:workers';

${core.trim()}

const POLICY = Object.freeze(${JSON.stringify(policy)});
validateRetirePolicy(POLICY);
const FILES = new Map(POLICY.files.map(file => [file.path, Object.freeze({ ...file })]));

export default {
  fetch(request, env) { return handleRetiredRequest(request, env, FILES); },
};
${inert ? `\n${inert}\n` : ''}`;
}

/** Receipt Merger completes at cutoff: hashes pin exactly what was reviewed; pruning never earlier than +48 h. */
export function buildReceipt(spec, source) {
  const policy = pinnedPolicy(spec);
  return {
    schemaVersion: 1, worker: spec.worker, installedVersionId: spec.installedVersionId, bindings: [...spec.bindings],
    facadeSha256: sha256(source), policySha256: sha256(JSON.stringify(policy)),
    retainedFiles: spec.files.length, retainedBytes: spec.files.reduce((sum, file) => sum + file.size, 0),
    inertExports: spec.exports.map(item => `${item.kind}:${item.name}`).sort(),
    upload: { keep_assets: true, assetsConfig: { run_worker_first: true }, handlers: ['fetch'] },
    retentionHours: RETENTION_HOURS, cutoffAt: null, earliestPruningAt: null,
  };
}

/** Fills cutoffAt and earliestPruningAt (= cutoff + 48 h) once Merger has observed the facade active. */
export function completeReceipt(receipt, cutoffIso) {
  const at = Date.parse(cutoffIso);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== cutoffIso) throw new Error('retire_cutoff_invalid');
  return { ...receipt, cutoffAt: cutoffIso, earliestPruningAt: new Date(at + RETENTION_HOURS * 3600_000).toISOString() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [specPath, outDir] = process.argv.slice(2);
  if (!specPath || !outDir) { console.error('usage: generate.mjs <spec.json> <out-dir>'); process.exit(2); }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const source = buildFacadeSource(spec);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.mjs'), source, { flag: 'wx' });
  fs.writeFileSync(path.join(outDir, 'receipt.json'), `${JSON.stringify(buildReceipt(spec, source), null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ worker: spec.worker, out: outDir, facadeSha256: sha256(source) }));
}
