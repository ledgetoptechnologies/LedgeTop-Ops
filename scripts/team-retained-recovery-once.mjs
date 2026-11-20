/** Local draft with a source-pinned short-lived public-recipient gate.
 * One manual main-only static-byte recovery; never a release or general provider CLI. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createPublicKey, randomUUID } from 'node:crypto';
import { canonical, hash } from './production-deploy.mjs';
import { createJournaledAssetVerifierProvider } from './ordinary-frontend-retained-executor.mjs';
import { createAssetVerificationNonce, createAssetVerifierSource, executeAssetVerification } from './production-auto-verify.mjs';
import { ProductionCloudflareProvider, newTemporaryVerifierName } from './production-auto-provider.mjs';
import { compatibleAssetMime } from './production-auto-assets.mjs';
import { sealProductionStaticRecoveryEvidence } from './production-auto-journal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'ledgetoptechnologies/LedgeTop-Ops';
const WORKFLOW = '.github/workflows/team-retained-recovery-once.yml';
const ACK = 'recover-exact-active-844a-39-assets-no-release';
const SPEC_BYTES = fs.readFileSync(new URL('./team-retained-recovery-39.json', import.meta.url));
const SPEC = JSON.parse(SPEC_BYTES);
const APPROVED_RECIPIENT = '2121d813f8c9386df6d2fa99536708a81d9b268fc34d575ceca6ef85c0bfd5e2';
const RECIPIENT_EXPIRY = '2026-11-21T05:14:38.000Z';
const COMMIT = /^[a-f0-9]{40}$/u, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const fail = () => { throw Error('team_retained_recovery_refused'); };
const need = x => { if (!x) fail(); };
const pin = file => ({ size: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)) });
const write = (file, bytes) => { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };

export function reviewedRecipient(value, now = Date.now()) {
  // Validate before reading any credential, event file or starting provider work.
  need(value?.schemaVersion === 1 && value.status === 'reviewed-short-lived-recipient'
    && value.keyIdSha256 === APPROVED_RECIPIENT && typeof value.publicKeyPem === 'string'
    && value.expiresAt === RECIPIENT_EXPIRY
    && Date.parse(value.expiresAt) > now && Date.parse(value.expiresAt) <= now + 7 * 86400000);
  let key; try { key = createPublicKey(value.publicKeyPem); } catch { fail(); }
  need(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 3072
    && hash(key.export({ type: 'spki', format: 'der' })) === value.keyIdSha256);
  return { schemaVersion: 1, keyIdSha256: value.keyIdSha256, publicKeyPem: value.publicKeyPem };
}

export function manualIdentity(env, event, checkoutHead, clean) {
  need(env.GITHUB_REPOSITORY === REPO && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_RUN_ATTEMPT === '1'
    && /^[1-9][0-9]{0,14}$/u.test(env.GITHUB_RUN_ID ?? '')
    && COMMIT.test(env.GITHUB_SHA ?? '') && env.GITHUB_SHA === env.APPROVED_SOURCE_COMMIT
    && checkoutHead === env.APPROVED_SOURCE_COMMIT && clean
    && event?.inputs?.approved_source_commit === env.APPROVED_SOURCE_COMMIT
    && event?.inputs?.acknowledgement === ACK && ['main', 'refs/heads/main'].includes(event.ref));
  return { repository: REPO, workflowPath: WORKFLOW, sourceCommit: checkoutHead,
    workflowRunId: Number(env.GITHUB_RUN_ID), workflowRunAttempt: 1 };
}

/** Exact transport fence in addition to canonical provider owned-helper checks. */
export function recoveryFetch({ name, bearer, apiToken, entries = SPEC.entries, fetchImpl = fetch }) {
  need(/^ops-ui-verify-[a-f0-9]{24}$/u.test(name) && /^[A-Za-z0-9_-]{43}$/u.test(bearer));
  const allowed = new Set(entries.map(x => x.path));
  const base = `/client/v4/accounts/${SPEC.accountId}`;
  const script = `/workers/scripts/${name}`;
  const productionReads = new Set([`/workers/scripts/${SPEC.workerName}/deployments?per_page=1`,
    `/workers/workers/${SPEC.workerName}/versions/${SPEC.versionId}?include=modules`,
    `/workers/scripts/${SPEC.workerName}/settings`, `/workers/scripts/${SPEC.workerName}/schedules`,
    `/workers/scripts/${SPEC.workerName}/subdomain`, '/workers/subdomain']);
  let verifierOrigin;
  return async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? 'GET';
    need(u.protocol === 'https:' && !u.username && !u.password && !u.hash && init.redirect === 'error');
    const headers = new Headers(init.headers);
    if (u.origin === 'https://api.cloudflare.com') {
      need(u.pathname.startsWith(base + '/'));
      const suffix = u.pathname.slice(base.length) + u.search;
      const helperRead = suffix === script || suffix === script + '/settings' || suffix === script + '/subdomain'
        || suffix === script + '/versions?per_page=1'
        || suffix.startsWith(script + '/versions/') && UUID.test(suffix.slice((script + '/versions/').length))
        || suffix.startsWith(`/workers/workers/${name}/versions/`) && u.search === '?include=modules'
          && UUID.test(u.pathname.split('/').at(-1));
      if (method === 'GET') need(productionReads.has(suffix) || helperRead);
      else if (method === 'PUT') {
        need(suffix === script && init.body instanceof FormData
          && [...init.body.keys()].sort().join() === 'index.js,metadata');
        const meta = JSON.parse(init.body.get('metadata'));
        need(canonical(meta.bindings) === canonical([{ name: 'SOURCE_ASSETS', type: 'service', service: SPEC.workerName, environment: 'production' }])
          && Object.keys(meta).sort().join() === 'bindings,compatibility_date,main_module' && meta.main_module === 'index.js');
      } else if (method === 'POST') need(suffix === script + '/subdomain'
        && canonical(JSON.parse(init.body)) === canonical({ enabled: true, previews_enabled: false }));
      else need(method === 'DELETE' && suffix === script);
      need(typeof apiToken === 'string' && headers.get('Authorization') === 'Bearer ' + apiToken);
      const response = await fetchImpl(url, init);
      if (suffix === '/workers/subdomain' && response.status === 200) {
        const subdomain = (await response.clone().json())?.result?.subdomain;
        need(typeof subdomain === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/u.test(subdomain));
        const next = `https://${name}.${subdomain}.workers.dev`;
        need(!verifierOrigin || verifierOrigin === next); verifierOrigin = next;
      }
      return response;
    }
    need(u.origin === verifierOrigin && !u.search && ['GET', 'HEAD'].includes(method)
      && allowed.has(u.pathname) && headers.get('Authorization') === 'Bearer ' + bearer);
    return fetchImpl(url, init);
  };
}

async function boundedJson(response) {
  need(response.status === 200 && !response.redirected && response.body);
  const chunks = []; let size = 0; const reader = response.body.getReader();
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > 32 * 1024 * 1024) { await reader.cancel(); fail(); } chunks.push(Buffer.from(part.value)); } }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, size));
}

/** Durable ciphertext checkpoints precede mutations; the artifact glob never sees plaintext. */
export function sealRecoveryCheckpoint({ binding, recipient, journalDirectory, outputDirectory, stage, asset, evidence }) {
  need(['initial', 'mutation-intent', 'mutation-response', 'asset-verified', 'absence-verified', 'incomplete', 'complete'].includes(stage));
  const journal = {};
  for (const file of ['identity.private.json', 'journal.jsonl', 'provider-responses.private.jsonl']) {
    const full = path.join(journalDirectory, file);
    if (fs.existsSync(full)) journal[file] = fs.readFileSync(full, 'utf8');
  }
  const context = { releaseId: hash(canonical(binding)), requestId: randomUUID(), method: 'GET',
    pathSha256: hash(asset?.entry?.path ?? stage), status: stage === 'complete' ? 200 : null };
  const encrypted = sealProductionStaticRecoveryEvidence(Buffer.from(JSON.stringify({ schemaVersion: 1,
    status: stage === 'complete' ? 'complete-static-recovery-only' : 'incomplete-not-release-acceptance',
    stage, binding, journal, ...(asset ? { asset } : {}), ...(evidence ? { evidence } : {}) })), context, recipient);
  const filename = context.requestId + '.sealed.json'; write(path.join(outputDirectory, filename), encrypted.bytes);
  return { filename, size: encrypted.bytes.length, sha256: encrypted.sha256 };
}

async function verifiedStaticClone(response, entry) {
  const mime = (response.headers.get('Content-Type') ?? '').split(';', 1)[0].trim().toLowerCase();
  need(response.status === 200 && !response.redirected && !response.headers.has('Location')
    && !response.headers.has('Content-Range') && !response.headers.get('Content-Encoding')
    && compatibleAssetMime(entry.path, entry.size, entry.sha256, entry.contentType, mime)
    && (response.headers.get('Content-Length') === null || response.headers.get('Content-Length') === String(entry.size)));
  const reader = response.clone().body?.getReader(); need(reader);
  const chunks = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > entry.size) { void reader.cancel().catch(() => {}); void response.body?.cancel().catch(() => {}); fail(); } chunks.push(Buffer.from(part.value)); } }
  finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, size); need(size === entry.size && hash(bytes) === entry.sha256);
  return bytes;
}

export function inventoryCiphertexts({ binding, recipient, outputDirectory }) {
  const files = fs.readdirSync(outputDirectory).map(filename => {
    need(/^[a-f0-9-]{36}\.sealed\.json$/u.test(filename));
    const file = path.join(outputDirectory, filename), stat = fs.lstatSync(file);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 48 * 1024 * 1024);
    const bytes = fs.readFileSync(file), envelope = JSON.parse(bytes);
    need(envelope.schemaVersion === 1 && envelope.algorithm === 'RSA-OAEP-256+A256GCM'
      && envelope.keyIdSha256 === recipient.keyIdSha256 && envelope.context?.releaseId === hash(canonical(binding))
      && ![hash('complete'), hash('incomplete')].includes(envelope.context.pathSha256));
    return { filename, size: bytes.length, sha256: hash(bytes) };
  }).sort((a, b) => a.filename.localeCompare(b.filename));
  need(files.length > 0); return files;
}

/** Complete is the last durable operation after inventory; claim it synchronously before any further work. */
export function finalizeRecoveryEvidence({ binding, recipient, journalDirectory, outputDirectory, evidence, state,
  inventory = inventoryCiphertexts }) {
  need(state?.complete === false);
  const previous = inventory({ binding, recipient, outputDirectory });
  const completion = sealRecoveryCheckpoint({ binding, recipient, journalDirectory, outputDirectory,
    stage: 'complete', evidence: { ...evidence, ciphertextInventory: previous } });
  state.complete = true;
  return [...previous, completion];
}

export function sealRecovered({ assets, receipt, binding, recipient, journalDirectory, outputDirectory, partialAssets, state }) {
  need(receipt?.temporaryWorkerRemoved === true && receipt.absenceVerified === true && receipt.productionUnchangedVerified === true
    && assets instanceof Map && assets.size === SPEC.entries.length
    && Array.isArray(partialAssets) && partialAssets.length === SPEC.entries.length);
  const paths = new Set();
  for (const row of SPEC.entries) {
    const bytes = assets.get(row.path), sealed = partialAssets.find(x => x.path === row.path);
    need(Buffer.isBuffer(bytes) && bytes.length === row.size && hash(bytes) === row.sha256
      && sealed && !paths.has(row.path) && /^[a-f0-9-]{36}\.sealed\.json$/u.test(sealed.filename));
    paths.add(row.path);
    const file = fs.readFileSync(path.join(outputDirectory, sealed.filename));
    need(file.length === sealed.size && hash(file) === sealed.sha256);
  }
  return finalizeRecoveryEvidence({ binding, recipient, journalDirectory, outputDirectory, evidence: { receipt, partialAssets }, state });
}

export async function run() {
  const recipient = reviewedRecipient(JSON.parse(fs.readFileSync(new URL('./team-retained-recovery-recipient.json', import.meta.url))));
  need(process.argv.length === 2 && !Object.keys(process.env).some(key => /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*)$/iu.test(key)));
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT)$/iu.test(key)));
  const git = args => execFileSync('git', args, { cwd: ROOT, env: gitEnv, encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
  const identity = manualIdentity(process.env, JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH)), git(['rev-parse', 'HEAD']), git(['status', '--porcelain', '--untracked-files=all']) === '');
  need(hash(SPEC_BYTES.toString('utf8').replaceAll('\r\n', '\n')) === '22b636be4e492fb2c3fa6c58a5cb5308025e90c3bb8346e5ddc2b21e0973e0cf');
  need(SPEC.entries.length === 39 && SPEC.entries.reduce((n, x) => n + x.size, 0) === 21495030);
  const ghToken = process.env.GITHUB_TOKEN, token = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.GITHUB_TOKEN; delete process.env.CLOUDFLARE_API_TOKEN;
  need(typeof ghToken === 'string' && /^[A-Za-z0-9_-]{20,1024}$/u.test(token ?? ''));
  const control = new AbortController(), timer = setTimeout(() => control.abort(), 480000);
  const abort = () => control.abort(); process.on('SIGTERM', abort); process.on('SIGINT', abort);
  let provider, name, outputDirectory, journalDirectory, binding;
  const completionState = { complete: false };
  try {
    const run = await boundedJson(await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${identity.workflowRunId}`, {
      redirect: 'error', signal: control.signal, headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json' } }));
    need(run.id === identity.workflowRunId && run.run_attempt === 1 && run.event === 'workflow_dispatch'
      && run.head_branch === 'main' && run.head_sha === identity.sourceCommit
      && [WORKFLOW, WORKFLOW + '@main', WORKFLOW + '@refs/heads/main'].includes(run.path)
      && run.repository?.full_name === REPO && run.head_repository?.full_name === REPO);
    // A new dispatch is not a retry escape hatch after an incomplete same-source run.
    const history = await boundedJson(await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/team-retained-recovery-once.yml/runs?event=workflow_dispatch&head_sha=${identity.sourceCommit}&per_page=100`, {
      redirect: 'error', signal: control.signal, headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json' } }));
    need(Number.isSafeInteger(history.total_count) && history.total_count >= 1 && history.total_count <= 100
      && Array.isArray(history.workflow_runs) && history.workflow_runs.length === history.total_count
      && history.workflow_runs.some(x => x.id === identity.workflowRunId)
      && !history.workflow_runs.some(x => x.id < identity.workflowRunId));
    const temp = process.env.RUNNER_TEMP; need(path.isAbsolute(temp ?? ''));
    const root = fs.mkdtempSync(path.join(temp, 'team-retained-recovery-')); fs.chmodSync(root, 0o700);
    journalDirectory = path.join(root, 'journal'); outputDirectory = path.join(root, 'sealed');
    fs.mkdirSync(journalDirectory, { mode: 0o700 }); fs.mkdirSync(outputDirectory, { mode: 0o700 });
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `sealed_directory=${outputDirectory}\n`);
    name = newTemporaryVerifierName(); const nonce = createAssetVerificationNonce();
    binding = { identity, workerName: SPEC.workerName, versionId: SPEC.versionId, deploymentId: SPEC.deploymentId,
      ledgerSHA256: SPEC.ledgerSHA256, manifestSHA256: hash(canonical(SPEC.entries)), verifierName: name,
      nonceHash: nonce.nonceHash, verifierSourceSHA256: hash(createAssetVerifierSource({
        workerName: SPEC.workerName, origin: SPEC.origin, entries: SPEC.entries, nonceHash: nonce.nonceHash, versionId: SPEC.versionId })) };
    const checkpoint = (stage, asset) => sealRecoveryCheckpoint({ binding, recipient, journalDirectory, outputDirectory, stage, asset, evidence });
    const transport = recoveryFetch({ name, bearer: nonce.bearer, apiToken: token });
    // Keep canonical ownership and dispatch gates; checkpoint only after their durable journal callback.
    class CheckpointProvider extends ProductionCloudflareProvider {
      constructor(options) {
        const wrap = callback => async value => { await callback(value); checkpoint('mutation-intent'); };
        super({ ...options, recordIntent: wrap(options.recordIntent), recordCleanupIntent: wrap(options.recordCleanupIntent),
          persistResponse: async value => { await options.persistResponse(value); checkpoint('mutation-response'); } });
      }
    }
    provider = createJournaledAssetVerifierProvider({ accountId: SPEC.accountId, token, fetchImpl: transport,
      journalDirectory, sourceCommit: identity.sourceCommit, Provider: CheckpointProvider });
    const partialAssets = [];
    const get = suffix => provider.get(suffix);
    const assertActive = async () => {
      const suffix = `/workers/scripts/${SPEC.workerName}/deployments?per_page=1`;
      const deployments = (await get(suffix)).deployments;
      need(deployments?.[0]?.id === SPEC.deploymentId && deployments[0].versions?.length === 1
        && deployments[0].versions[0].version_id === SPEC.versionId && deployments[0].versions[0].percentage === 100);
      const version = await get(`/workers/workers/${SPEC.workerName}/versions/${SPEC.versionId}?include=modules`);
      const ledgerModule = version.modules?.filter(x => x.name === '__ops_release_ledger.json');
      need(version.id === SPEC.versionId && ledgerModule?.length === 1
        && hash(Buffer.from(ledgerModule[0].content_base64, 'base64')) === SPEC.ledgerSHA256);
      const ledger = JSON.parse(Buffer.from(ledgerModule[0].content_base64, 'base64'));
      need(ledger.sourceCommit === SPEC.installedSource && ledger.assets.length === 600);
      for (const entry of SPEC.entries) need(ledger.assets.some(row => row.path === entry.path && row.size === entry.size
        && row.sha256 === entry.sha256 && row.mime === entry.contentType));
      const settings = await get(`/workers/scripts/${SPEC.workerName}/settings`);
      const schedules = await get(`/workers/scripts/${SPEC.workerName}/schedules`);
      const subdomain = await get(`/workers/scripts/${SPEC.workerName}/subdomain`);
      need(canonical((await get(suffix)).deployments) === canonical(deployments));
      return hash(canonical({ deployments, version, settings, schedules, subdomain }));
    };
    const before = await assertActive();
    write(path.join(journalDirectory, 'identity.private.json'), JSON.stringify({ identity, verifierName: name,
      baselineSHA256: before, manifestSHA256: hash(canonical(SPEC.entries)),
      binding, sourcePins: [WORKFLOW, 'scripts/team-retained-recovery-once.mjs', 'scripts/team-retained-recovery-39.json',
        'scripts/team-retained-recovery-recipient.json', 'scripts/ordinary-frontend-retained-executor.mjs',
        'scripts/production-auto-provider.mjs', 'scripts/production-auto-verify.mjs'].map(file => ({ file, ...pin(path.join(ROOT, file)) })) }));
    checkpoint('initial');
    let result;
    try { result = await executeAssetVerification({ entries: SPEC.entries, signal: control.signal, timeoutMs: 300000,
      create: async () => { need(await assertActive() === before); return provider.createVerifier({ name,
        workerName: SPEC.workerName, origin: SPEC.origin, entries: SPEC.entries, nonceHash: nonce.nonceHash, versionId: SPEC.versionId }); },
      fetchAsset: async ({ path: assetPath }, { method, signal }) => {
        const response = await provider.fetchVerifierAsset({ name, path: assetPath, method, signal, bearer: nonce.bearer });
        if (method === 'GET') {
          const entry = SPEC.entries.find(row => row.path === assetPath);
          const bytes = await verifiedStaticClone(response, entry);
          const pin = checkpoint('asset-verified', { entry, contentBase64: bytes.toString('base64') });
          partialAssets.push({ path: entry.path, ...pin });
        }
        return response;
      },
      remove: () => provider.removeVerifier(name), readAbsent: async () => {
        const absent = await provider.verifierAbsent(name); if (absent) checkpoint('absence-verified'); return absent;
      } }); }
    finally { need(await assertActive() === before); }
    need(git(['rev-parse', 'HEAD']) === identity.sourceCommit && git(['status', '--porcelain', '--untracked-files=all']) === '');
    const receipt = { ...result.receipt, productionUnchangedVerified: true, baselineSHA256: before };
    const outputs = sealRecovered({ assets: result.assets, receipt, binding, recipient, journalDirectory, outputDirectory,
      partialAssets, state: completionState });
    process.stdout.write(JSON.stringify({ status: 'sealed-static-recovery-complete', sourceCommit: identity.sourceCommit,
      runId: identity.workflowRunId, runAttempt: 1, assets: 39, sealedFiles: outputs.length,
      manifestSHA256: hash(canonical(outputs)), recipientKeyId: recipient.keyIdSha256, cleanupVerified: true }) + '\n');
  } finally {
    clearTimeout(timer); process.off('SIGTERM', abort); process.off('SIGINT', abort);
    // executeAssetVerification owns the single deletion attempt. No blind cleanup retry.
    if (!completionState.complete && outputDirectory) sealRecoveryCheckpoint({ binding: binding ?? { identity, verifierName: name },
      recipient, journalDirectory, outputDirectory, stage: 'incomplete' });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run().catch(() => {
  process.stderr.write('Recovery held or incomplete; no automatic retry.\n'); process.exitCode = 1;
});
