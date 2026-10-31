import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, unlink, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { NATIVE_STAFF_PRODUCTION_TARGET, nativeStaffReadinessEnvironment } from './native-staff-cutover-readiness.mjs';
import { POST0226_STAFF_PRESERVATION_QUERY, qualifyPost0226Snapshot, validatePost0226StaffPreservationReview } from './ordinary-frontend-authority-post0226.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{64}$/u;
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const parse = output => {
  let result; try { result = typeof output === 'string' ? JSON.parse(output) : output; } catch { throw Error('post0226_reader:json_invalid'); }
  if (!Array.isArray(result) || result.length !== 1 || result[0]?.success !== true || !Array.isArray(result[0].results))
    throw Error('post0226_reader:result_invalid');
  return result[0].results;
};

/** Read-only one-query Operations snapshot. Raw login rows exist only transiently
 * in this function; callers receive digests/counts, never aliases or token hashes. */
export async function readPost0226StaffPreservationObservation({ review = null, sourceCommit, read, now = Date.now, env = process.env } = {}) {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit ?? '') || (review && review.sourceCommit !== sourceCommit))
    throw Error('post0226_reader:source_invalid');
  const environment = read ? null : nativeStaffReadinessEnvironment(env);
  const runtime = path.join(ROOT, 'apps/operations/node_modules/wrangler/wrangler-dist/cli.js');
  if (!read) {
    const profile = JSON.parse(await readFile(path.join(ROOT, 'scripts/production-deploy-profile.json'), 'utf8'));
    if (!SHA.test(profile.wranglerRuntimeSHA256) || hash(await readFile(runtime)) !== profile.wranglerRuntimeSHA256)
      throw Error('post0226_reader:runtime_unqualified');
  }
  const target = NATIVE_STAFF_PRODUCTION_TARGET, folder = await mkdtemp(path.join(tmpdir(), 'ops-post0226-preservation-'));
  const config = path.join(folder, 'wrangler.json');
  try {
    await writeFile(config, JSON.stringify({ name: 'ops-staff-preservation-read-only', account_id: target.accountId,
      compatibility_date: '2026-07-22', d1_databases: [{ binding: 'OPS_DB', database_name: target.databaseName, database_id: target.databaseId }] }),
      { flag: 'wx', mode: 0o600 });
    const runner = read ?? (async args => {
      try { return (await promisify(execFile)(process.execPath, [runtime, ...args], { cwd: folder, env: environment,
        timeout: 60_000, maxBuffer: 24 * 1024 * 1024, encoding: 'utf8', windowsHide: true, shell: false })).stdout; }
      catch { throw Error('post0226_reader:read_failed'); }
    });
    const started = now();
    const rows = parse(await runner(['d1','execute',target.databaseId,'--remote','--config',config,
      '--command',POST0226_STAFF_PRESERVATION_QUERY,'--json'], { cwd: folder }));
    if (rows.length !== 1 || typeof rows[0].frontend_authority_snapshot !== 'string'
      || Buffer.byteLength(rows[0].frontend_authority_snapshot) > 24 * 1024 * 1024 || now()-started > 60_000)
      throw Error('post0226_reader:snapshot_invalid');
    let raw; try { raw = JSON.parse(rows[0].frontend_authority_snapshot); } catch { throw Error('post0226_reader:snapshot_invalid'); }
    const observation = await qualifyPost0226Snapshot(raw, { sourceCommit, observedAt: new Date(started).toISOString(), now: now() });
    return review ? validatePost0226StaffPreservationReview(review, observation, { sourceCommit, now: now() }) : observation;
  } finally {
    await unlink(config).catch(() => {});
    await rmdir(folder).catch(() => {});
  }
}
