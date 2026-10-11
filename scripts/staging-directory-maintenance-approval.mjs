import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';

// Out-of-band approval only. Never authenticates a native caller, executes a
// grant, installs a credential, or accepts a browser's claim of owner authority.
export const MAINTENANCE_APPROVAL_TARGET = Object.freeze({
  environment: 'staging', accountLabel: '846c924bf17bf4f3dd15c97a4c5d1d51',
  workerLabel: 'ledgetop-ops-staging', databaseLabel: '78b34173-b168-4e3d-9832-bb9d245cc6b8',
});
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const fail = () => { throw Error('staging maintenance approval rejected'); };
function exact(value, keys) {
  assert(value && Object.getPrototypeOf(value) === Object.prototype
    && same(Object.keys(value).sort(), [...keys].sort()), 'closed maintenance input required');
}

/** Provider responses must be fetched independently of the browser/private plan.
 * Production, split traffic, missing ENVIRONMENT, ambiguous binding and changed
 * deployed versions are rejected. Values returned here contain no secrets. */
async function readBinding({ token, fetch: fetcher = globalThis.fetch }) {
  assert(typeof token === 'string' && token.length >= 20 && typeof fetcher === 'function');
  const base = `https://api.cloudflare.com/client/v4/accounts/${MAINTENANCE_APPROVAL_TARGET.accountLabel}/workers/scripts/${MAINTENANCE_APPROVAL_TARGET.workerLabel}`;
  async function read(suffix) {
    try {
      const signal = AbortSignal.timeout(15_000);
      const response = await fetcher(`${base}${suffix}`, { method: 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok || !response.body?.getReader) fail();
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > 1_048_576) fail();
          chunks.push(Buffer.from(part.value));
        }
        if (signal.aborted) fail();
      } catch { try { await reader.cancel(); } catch {} fail(); }
      finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.success !== true || !body.result) fail();
      return body.result;
    } catch { fail(); }
  }
  const deployment = await read('/deployments'), active = deployment.deployments?.[0];
  if (!uuid.test(active?.id) || active.versions?.length !== 1
    || active.versions[0].percentage !== 100 || !uuid.test(active.versions[0].version_id)) fail();
  const version = await read(`/versions/${active.versions[0].version_id}`);
  if (version.id !== active.versions[0].version_id || !Array.isArray(version.resources?.bindings)) fail();
  const named = name => version.resources.bindings.filter(binding => binding.name === name);
  const environment = named('ENVIRONMENT'), database = named('OPS_DB');
  if (environment.length !== 1 || environment[0].type !== 'plain_text' || environment[0].text !== 'staging'
    || database.length !== 1 || database[0].type !== 'd1'
    || (database[0].id ?? database[0].database_id) !== MAINTENANCE_APPROVAL_TARGET.databaseLabel
    || database[0].id !== undefined && database[0].database_id !== undefined && database[0].id !== database[0].database_id) fail();
  const after = await read('/deployments');
  if (!same(deployment.deployments?.[0], after.deployments?.[0])) fail();
  return Object.freeze({ target: MAINTENANCE_APPROVAL_TARGET, deploymentId: active.id, versionId: version.id });
}
export async function readLiveMaintenanceBinding(input) {
  try { return await readBinding(input); } catch { fail(); }
}

/** The trusted operator must review the private artifact from the normally
 * authenticated Worker review, independently verify its live binding, and
 * recompile against that physical D1. Browser review never installs approvals.
 * compile is the existing core compiler, not a second schema implementation.
 * review is an explicit out-of-band trusted review callback, NOT a web input. */
async function installApproval({ db, artifact, approvalId,
  compile, verifyBinding, review, now = () => new Date() }) {
  artifact = structuredClone(artifact);
  exact(artifact, ['plan', 'planSha256', 'independentBindingVerificationSha256']);
  assert(uuid.test(approvalId) && typeof compile === 'function'
    && typeof verifyBinding === 'function' && typeof review === 'function');
  assert(same(artifact.plan?.target, MAINTENANCE_APPROVAL_TARGET));
  const before = structuredClone(await verifyBinding());
  assert(same(before.target, MAINTENANCE_APPROVAL_TARGET) && uuid.test(before.versionId) && uuid.test(before.deploymentId));
  const p = artifact.plan;
  const rebuilt = await compile(db, { target: p.target, staffId: p.staffId, grantId: p.grantId,
    commandId: p.commandId, operator: p.operator, approvalIssuer: p.approvalIssuer, identityEvidence: p.identityEvidence });
  assert(same(rebuilt.plan, artifact.plan) && rebuilt.canonicalPlanSha256 === artifact.planSha256
    && rebuilt.independentBindingVerificationSha256 === artifact.independentBindingVerificationSha256,
    'live plan differs from authenticated review');
  assert(sha(rebuilt.canonicalPlanJson) === artifact.planSha256
    && sha(rebuilt.independentBindingVerificationJson) === artifact.independentBindingVerificationSha256);
  assert(await review(structuredClone(artifact), structuredClone(before)) === true, 'explicit trusted review required');
  const issued = now(), expiration = new Date(Math.min(issued.getTime() + 15 * 60_000, Date.parse(p.identityEvidence.expiresAt)));
  assert(Number.isFinite(issued.getTime()) && expiration.getTime() > issued.getTime()
    && Date.parse(p.identityEvidence.verifiedAt) <= issued.getTime());
  assert(same(before, await verifyBinding()), 'live binding changed during review');
  const finalPlan = await compile(db, { target: p.target, staffId: p.staffId, grantId: p.grantId,
    commandId: p.commandId, operator: p.operator, approvalIssuer: p.approvalIssuer, identityEvidence: p.identityEvidence });
  assert(same(finalPlan, rebuilt), 'live identity or authority changed during review');
  const values = [approvalId, rebuilt.canonicalPlanJson, artifact.planSha256,
    p.operator.staffId, p.operator.accessSubject, rebuilt.independentBindingVerificationJson,
    artifact.independentBindingVerificationSha256, p.approvalIssuer.staffId, p.approvalIssuer.accessSubject,
    issued.toISOString(), expiration.toISOString()];
  // Plain INSERT intentionally rejects all ID reuse; never overwrite/revive an
  // approval. On an uncertain response, inspect the exact row before deciding.
  const inserted = await db.prepare(`INSERT INTO native_directory_maintenance_authority_approvals
    (approval_id,canonical_plan_json,canonical_plan_sha256,approved_operator_staff_id,
     approved_operator_access_subject,independent_binding_verification_json,independent_binding_verification_sha256,
     issued_by_staff_id,issued_by_access_subject,issued_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(...values).run();
  assert(inserted?.success === true && inserted.meta?.changes === 1, 'approval insert not confirmed');
  return Object.freeze({ approvalId, commandId: p.commandId, planSha256: artifact.planSha256,
    expiresAt: expiration.toISOString(), grantExecuted: false });
}
export async function installReviewedMaintenanceApproval(input) {
  try { return await installApproval(input); } catch { fail(); }
}
