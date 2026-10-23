/** Offline staging only. No network, deployment or approval. Both independent
 * build trees and their complete manifests must match the pinned reconstruction.
 * The only omitted file is the build tool's .assetsignore control file. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import catalog from '../packages/shared/src/ui-release-catalog.generated.json' with { type: 'json' };

const controlSha = '4f83140d5f4293ab55bd1207327e995c83258f1e7d3145b1b5d7a3d17fdfe0a7';
/** Reviewed build-manifest digests per release. Each new release adds a row; earlier
 * rows stay unchanged so packets for releases still serving open tabs reproduce. */
export const RELEASE_MANIFEST_PINS = Object.freeze({
  cfcf5cf992084f7b3658763cdf362fbc37101665: Object.freeze({
    client: 'ffcfa84f31e7855b05895338c6f53ad4d3bc963ad115c3c1290912c7b438a4b9',
    operations: '621ddeead1c3edb4d3218b8919269f843e5a22b74b2eea42271f2b93ae7292c4',
  }),
});
export const DEFAULT_RELEASE_ID = 'cfcf5cf992084f7b3658763cdf362fbc37101665';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(condition, message) { if (!condition) throw new Error(message); }
function walk(directory, relative = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const child = relative + '/' + entry.name;
    fail(!entry.isSymbolicLink(), `Symbolic link: ${child}`);
    if (entry.isDirectory()) return walk(path.join(directory, entry.name), child);
    fail(entry.isFile() && fs.lstatSync(path.join(directory, entry.name)).nlink === 1, `Nonregular or linked file: ${child}`);
    return [child];
  }).sort();
}

export function stageUiReleasePacket(proofRoot, outputDirectory, releaseId = DEFAULT_RELEASE_ID) {
  const manifestSha = Object.hasOwn(RELEASE_MANIFEST_PINS, releaseId) ? RELEASE_MANIFEST_PINS[releaseId] : null;
  fail(manifestSha, `Unpinned release: ${releaseId}`);
  const source = fs.realpathSync(proofRoot), requestedOutput = path.resolve(outputDirectory);
  // Resolve the existing parent before containment checks so a junction or
  // symlink cannot redirect a lexical sibling into the proof inputs.
  const output = path.join(fs.realpathSync(path.dirname(requestedOutput)), path.basename(requestedOutput));
  fail(!fs.existsSync(output), 'Output must be a new directory');
  const relative = path.relative(source, output);
  fail(relative !== '' && (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)),
    'Output must be outside proof inputs');
  const copies = [], exclusions = [];
  for (const application of ['operations', 'client']) {
    const release = catalog.releases.find(item => item.application === application && item.releaseId === releaseId);
    fail(release, `Missing catalog: ${application}`);
    const builds = [];
    for (const build of [1, 2]) {
      const manifest = JSON.parse(fs.readFileSync(path.join(source, `build-${build}-${application}-manifest.json`), 'utf8'));
      fail(digest(JSON.stringify(manifest)) === manifestSha[application], `Unpinned build manifest: ${application}/${build}`);
      const directory = path.join(source, `build-${build}`, 'apps', application, 'dist', 'client');
      fail(JSON.stringify(walk(directory)) === JSON.stringify(manifest.map(file => file.path).sort()), 'Manifest does not cover the exact full tree');
      const contents = new Map();
      for (const file of manifest) {
        fail(/^\/[A-Za-z0-9._/-]+$/.test(file.path) && file.path.slice(1).split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid manifest path');
        const bytes = fs.readFileSync(path.join(directory, file.path.slice(1)));
        fail(bytes.length === file.size && digest(bytes) === file.sha256, `Build bytes mismatch: ${application}/${build}${file.path}`);
        contents.set(file.path, bytes);
      }
      builds.push(contents);
    }
    for (const [name, bytes] of builds[0]) fail(bytes.equals(builds[1].get(name)), `Independent builds differ: ${name}`);
    const control = builds[0].get('/.assetsignore');
    fail(control && digest(control) === controlSha && control.toString('utf8') === 'wrangler.json\n.dev.vars\n', 'Unexpected assetsignore policy');
    exclusions.push({ application, path: '/.assetsignore', size: control.length, sha256: controlSha, reason: 'Build upload control file; not a served asset' });
    fail(release.files.length === builds[0].size - 1, 'Catalog count differs');
    for (const file of release.files) {
      const bytes = builds[0].get(file.path);
      fail(bytes && bytes.length === file.size && digest(bytes) === file.sha256, `Catalog bytes mismatch: ${file.path}`);
      copies.push({ path: `/_ui/${application}/${releaseId}${file.path}`, bytes, sha256: file.sha256, mime: file.mime });
    }
  }
  // All validation precedes the first write. A failed write leaves a partial
  // packet for diagnosis and never deletes or overwrites an existing directory.
  fs.mkdirSync(output);
  for (const file of copies) {
    const destination = path.join(output, 'dist', file.path.slice(1));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.bytes, { flag: 'wx' });
  }
  const receipt = { schemaVersion: 1, releaseId, approvedInventory: false, deploymentApproved: false,
    providerNamespaceVerified: false, targetCompatibilityDateQualified: false,
    independentBuildBytesEqual: true, exclusions,
    files: copies.map(({ path, bytes, sha256, mime }) => ({ path, size: bytes.length, sha256, mime })),
  };
  fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fail(process.argv.length === 4 || process.argv.length === 5,
    'Usage: node scripts/ui-release-packet.mjs <independent-build-proof-root> <new-packet-directory> [release-commit]');
  const receipt = stageUiReleasePacket(process.argv[2], process.argv[3], process.argv[4] ?? DEFAULT_RELEASE_ID);
  console.log(JSON.stringify({ files: receipt.files.length, bytes: receipt.files.reduce((sum, file) => sum + file.size, 0),
    approvedInventory: false, deploymentApproved: false }));
}
