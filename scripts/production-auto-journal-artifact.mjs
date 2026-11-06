/** Journal-only completion for a release workflow's encrypted response artifact.
 * This path validates GitHub's exact artifact record and cannot call Cloudflare. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ProductionAutoJournal, loadPinnedProductionAutoRecipient } from './production-auto-journal.mjs';
import { ProductionMainCI } from './production-auto-ci.mjs';
import { readProductionAutoTriggerRun } from './production-auto-runtime.mjs';
import { isGitHubHeaderCredential } from './production-auto-token.mjs';

const REPO = 'ledgetoptechnologies/LedgeTop-Ops';
const COMMIT = /^[a-f0-9]{40}$/u, DIGEST = /^[a-f0-9]{64}$/u;
const need = (condition, code) => { if (!condition) throw Error(code); };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function readProductionAutoArtifact({ id, token, fetchImpl = fetch, sourceCommit, workerName, runId, name, digest }) {
  need(Number.isSafeInteger(id) && id > 0 && COMMIT.test(sourceCommit ?? '')
    && ['ledgetop-ops','ledgetop-clients'].includes(workerName)
    && name === `production-auto-${createHash('sha256').update(`${workerName}\n${sourceCommit}`).digest('hex')}`
    && Number.isSafeInteger(runId) && runId > 0 && DIGEST.test(digest ?? '')
    && isGitHubHeaderCredential(token), 'artifact_id_invalid');
  const controller = new AbortController(); let timer, response;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('artifact_read_timeout')); }, 20_000); });
  const operation = (async () => {
    response = await fetchImpl(`https://api.github.com/repos/${REPO}/actions/artifacts/${id}`, { method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}` } });
    need(response instanceof Response && response.status === 200 && !response.redirected && !response.headers.has('Location')
      && response.headers.get('Content-Type')?.split(';')[0] === 'application/json', 'artifact_provider_response_invalid');
    const length = response.headers.get('Content-Length'); need(length === null || /^\d+$/u.test(length) && Number(length) <= 64 * 1024);
    const reader = response.body?.getReader(); need(reader);
    try {
      const chunks = []; let size = 0;
      for (;;) { const part = await reader.read(); need(!controller.signal.aborted); if (part.done) break;
        size += part.value.byteLength; need(size <= 64 * 1024); chunks.push(Buffer.from(part.value)); }
      const bytes = Buffer.concat(chunks, size), text = bytes.toString('utf8'); need(Buffer.from(text, 'utf8').equals(bytes));
      const row = JSON.parse(text);
      need(row.id === id && row.name === name && row.expired === false
        && Number.isSafeInteger(row.size_in_bytes) && row.size_in_bytes > 0 && row.size_in_bytes <= 256 * 1024 * 1024
        && row.digest === `sha256:${digest}` && row.workflow_run?.id === runId
        && row.workflow_run?.head_branch === 'main', 'artifact_provider_binding_invalid');
      return { id: row.id, name: row.name, sizeBytes: row.size_in_bytes, digestSha256: digest };
    } finally { try { await reader.cancel(); } catch {} }
  })();
  try { return await Promise.race([operation, timeout]); }
  catch { controller.abort(); throw Error('artifact_provider_read_failed'); }
  finally { clearTimeout(timer); }
}

export async function completeProductionAutoArtifact({ env = process.env, fetchImpl = fetch,
  recipientLoader = loadPinnedProductionAutoRecipient, ciFactory = options => new ProductionMainCI(options),
  journalFactory = options => new ProductionAutoJournal(options), triggerReader = readProductionAutoTriggerRun } = {}) {
  const recipient = recipientLoader(); // Validate the source-pinned encryption recipient before token/event/API use.
  need(env.PRODUCTION_AUTO_RELEASE_ENABLED === 'true' && isGitHubHeaderCredential(env.GITHUB_TOKEN)
    && /^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'artifact_completion_disabled');
  const trigger = triggerReader(env), sourceCommit = trigger.sourceCommit;
  need(COMMIT.test(sourceCommit) && ['ledgetop-ops','ledgetop-clients','ledgetop-ops-sync'].includes(env.PRODUCTION_AUTO_WORKER), 'artifact_completion_identity_invalid');
  const verified = await ciFactory({ token: env.GITHUB_TOKEN, fetchImpl }).verify(sourceCommit);
  need(verified.runId === trigger.runId && verified.runAttempt === trigger.runAttempt, 'artifact_trigger_ci_no_longer_latest');
  need(/^[1-9][0-9]*$/u.test(env.AUTO_ARTIFACT_ID ?? '') && DIGEST.test(env.AUTO_ARTIFACT_DIGEST ?? '')
    && ['success','failure','cancelled'].includes(env.AUTO_UPLOAD_CONCLUSION ?? '')
    && ['success','failure','cancelled'].includes(env.AUTO_RELEASE_CONCLUSION ?? ''), 'artifact_output_invalid');
  const artifactDigest = env.AUTO_ARTIFACT_DIGEST;
  const workerName = env.PRODUCTION_AUTO_WORKER;
  const releaseId = createHash('sha256').update(`${env.PRODUCTION_AUTO_WORKER}\n${sourceCommit}`).digest('hex');
  const artifact = await readProductionAutoArtifact({ id: Number(env.AUTO_ARTIFACT_ID), token: env.GITHUB_TOKEN, fetchImpl, sourceCommit, workerName,
    runId: Number(env.GITHUB_RUN_ID), name: `production-auto-${releaseId}`, digest: artifactDigest });
  need(artifact.digestSha256 === artifactDigest, 'artifact_digest_unconfirmed');
  const responseDirectory = path.join(ROOT, '.backups', 'production-auto-release', workerName, sourceCommit);
  const journal = journalFactory({ token: env.GITHUB_TOKEN, workerName,
    ...(workerName === 'ledgetop-ops-sync' ? { releaseKind: 'backend-sync' } : {}), sourceCommit, ciRunId: verified.runId,
    ciRunAttempt: verified.runAttempt, workflowRunId: Number(env.GITHUB_RUN_ID), workflowRunAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    recipient, responseDirectory, fetchImpl });
  await journal.attachArtifact({ artifactId: artifact.id, artifactDigest, runId: Number(env.GITHUB_RUN_ID),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT), name: artifact.name, status: env.AUTO_UPLOAD_CONCLUSION,
    releaseStatus: env.AUTO_RELEASE_CONCLUSION });
  return { attached: true, artifactId: artifact.id, digestSha256: artifactDigest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await completeProductionAutoArtifact())); }
  catch { console.error('Automatic release artifact journal update held; preserve the journal and reconcile read-only.'); process.exitCode = 1; }
}
