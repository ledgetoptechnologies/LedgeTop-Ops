/** Offline evidence only. Builds the Client and Operations UIs twice from one exact
 * commit, each in its own clean git-blob export inside the pinned Node image, with
 * release-prefixed asset URLs. Builds run one after the other (concurrent builds
 * have overloaded the shared PC). Writes the proof layout ui-release-packet.mjs
 * reads. No network beyond npm ci, no deployment, upload or approval. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BUILD_IMAGE = 'node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e';
export const APPLICATIONS = Object.freeze(['client', 'operations']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(condition, message) { if (!condition) throw new Error(message); }

/** Every regular file under a build output, as sorted { path, size, sha256 }. */
export function buildManifest(base) {
  const out = [];
  (function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        fail(entry.isFile(), `Nonregular output: ${full}`);
        const bytes = fs.readFileSync(full);
        out.push({ path: '/' + path.relative(base, full).split(path.sep).join('/'), size: bytes.length, sha256: hash(bytes) });
      }
    }
  })(base);
  return out.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Paths whose presence, size or digest differ between two manifests. */
export function compareManifests(left, right) {
  const l = new Map(left.map(file => [file.path, file])), r = new Map(right.map(file => [file.path, file]));
  return [...new Set([...l.keys(), ...r.keys()])].sort().flatMap(name => {
    const a = l.get(name), b = r.get(name);
    return a && b && a.size === b.size && a.sha256 === b.sha256 ? [] : [{ path: name, left: a ?? null, right: b ?? null }];
  });
}

export function buildScript(commit) {
  fail(/^[0-9a-f]{40}$/.test(commit), 'Release commit must be a full lowercase SHA');
  const vite = app => `(cd apps/${app} && WRANGLER_WRITE_LOGS=false node node_modules/vite/bin/vite.js build --base=/_ui/${app}/${commit}/)`;
  return ['set -eu', 'node --version', 'npm --version', 'cat /etc/os-release',
    'printf "STEP install-client\\n"', 'npm ci --prefix apps/client',
    'printf "STEP install-operations\\n"', 'npm ci --prefix apps/operations',
    'printf "STEP install-sync\\n"', 'npm ci --prefix apps/ops-sync',
    // The committed build wrapper ignores CLI arguments, so call the locked Vite directly.
    'printf "STEP build-client\\n"', vite('client'),
    'printf "STEP build-operations\\n"', vite('operations'),
    'printf "STEP complete\\n"'].join('\n');
}

function git(repo, args) {
  return cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** Exports the commit as a tar and checks every tracked file against its git blob. */
function exportSource(repo, commit, root, n) {
  const source = path.join(root, `build-${n}`), archive = path.join(root, `source-${n}.tar`);
  fs.mkdirSync(source);
  git(repo, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', `--output=${archive}`, commit]);
  cp.execFileSync('tar', ['-xf', archive, '-C', source], { windowsHide: true });
  const verified = [];
  for (const line of git(repo, ['ls-tree', '-rz', commit]).split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t'), [mode, type, blob] = line.slice(0, tab).split(' '), name = line.slice(tab + 1);
    fail(['100644', '100755'].includes(mode) && type === 'blob' && !name.startsWith('/') && !name.split('/').includes('..'),
      `Unsupported tracked entry ${name}`);
    const bytes = fs.readFileSync(path.join(source, name));
    const actual = crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    fail(actual === blob, `Git blob export mismatch ${name}`);
    verified.push({ path: name, size: bytes.length, gitBlob: blob, sha256: hash(bytes) });
  }
  fs.writeFileSync(path.join(root, `build-${n}-source-blob-manifest.json`), JSON.stringify(verified, null, 2));
  return { source, sourceArchiveSHA256: hash(fs.readFileSync(archive)), regularFiles: verified.length,
    sourceBlobManifestSHA256: hash(JSON.stringify(verified)) };
}

/** A new output directory outside the repository. The existing parent is resolved
 * first so a junction or symlink cannot redirect a lexical path into the checkout. */
export function newOutsideOutput(repo, output) {
  const requested = path.resolve(output), parent = path.dirname(requested);
  fail(fs.existsSync(parent), 'Output parent must already exist');
  const root = path.join(fs.realpathSync(parent), path.basename(requested));
  fail(!fs.existsSync(root), 'Output must be a new directory');
  const relative = path.relative(fs.realpathSync(repo), root);
  fail(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative),
    'Output must be outside the repository');
  return root;
}

export function runPrefixedBuilds({ repo, commit, output }) {
  fail(/^[0-9a-f]{40}$/.test(commit), 'Release commit must be a full lowercase SHA');
  fail(git(repo, ['rev-parse', `${commit}^{commit}`]) === commit, 'Release commit is not in this repository');
  const root = newOutsideOutput(repo, output);
  fs.mkdirSync(root);
  const receipt = { kind: 'exact-git-blob-prefixed-vite-two-builds', commit, tree: git(repo, ['rev-parse', `${commit}^{tree}`]),
    image: BUILD_IMAGE, serialized: true, environment: { WRANGLER_WRITE_LOGS: 'false' },
    bases: Object.fromEntries(APPLICATIONS.map(app => [app, `/_ui/${app}/${commit}/`])),
    deploymentApproved: false, liveByteEqualityProved: false, startedAt: new Date().toISOString(), builds: [] };
  const save = () => fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  save();
  for (const n of [1, 2]) {
    const build = { id: n, ...exportSource(repo, commit, root, n), startedAt: new Date().toISOString() };
    receipt.builds.push(build); save();
    const args = ['run', '--rm', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', `type=bind,source=${build.source},target=/work`, '--workdir', '/work', BUILD_IMAGE, 'sh', '-c', buildScript(commit)];
    const log = fs.openSync(path.join(root, `build-${n}.log`), 'w');
    const result = cp.spawnSync('docker', args, { stdio: ['ignore', log, log], windowsHide: true });
    fs.closeSync(log);
    Object.assign(build, { exit: result.status, error: result.error?.message ?? null, finishedAt: new Date().toISOString() });
    save();
    fail(result.status === 0, `Build ${n} failed; see build-${n}.log`);
    build.outputs = {};
    for (const app of APPLICATIONS) {
      const manifest = buildManifest(path.join(build.source, 'apps', app, 'dist', 'client'));
      fs.writeFileSync(path.join(root, `build-${n}-${app}-manifest.json`), JSON.stringify(manifest, null, 2));
      build.outputs[app] = { files: manifest.length, bytes: manifest.reduce((sum, file) => sum + file.size, 0),
        manifestSHA256: hash(JSON.stringify(manifest)) };
    }
    save();
  }
  receipt.comparison = Object.fromEntries(APPLICATIONS.map(app => {
    const read = n => JSON.parse(fs.readFileSync(path.join(root, `build-${n}-${app}-manifest.json`), 'utf8'));
    const differences = compareManifests(read(1), read(2));
    return [app, { identical: differences.length === 0, differences }];
  }));
  receipt.finishedAt = new Date().toISOString(); save();
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fail(process.argv.length === 4, 'Usage: node scripts/ui-release-prefixed-builds.mjs <release-commit> <new-output-directory>');
  const receipt = runPrefixedBuilds({ repo: process.cwd(), commit: process.argv[2], output: process.argv[3] });
  console.log(JSON.stringify({ commit: receipt.commit, comparison: Object.fromEntries(Object.entries(receipt.comparison)
    .map(([app, value]) => [app, value.identical])),
    manifests: Object.fromEntries(APPLICATIONS.map(app => [app, receipt.builds[0].outputs[app].manifestSHA256])) }));
}
