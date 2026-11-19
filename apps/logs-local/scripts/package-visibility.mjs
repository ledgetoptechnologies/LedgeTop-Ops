// CI only: observe the GHCR container package's visibility with the job's own GITHUB_TOKEN, fail closed.
//   node package-visibility.mjs <pre|post> <owner> <package> <out.json>
// Reads GET /orgs/{owner}/packages/container/{package} (read-only). It never creates, changes visibility or permissions.
// Beau approved PUBLIC code-only runtime images. Repository privacy does not change this package policy.
//   pre  (before the immutable push): 200 public and linked to this repository -> ok; 404 -> "absent" (allowed: it may
//        not exist yet; this is NOT proof of visibility); 200 private/internal, another repository, or ANY other answer
//        (401/403/5xx/network/timeout/malformed) -> stop.
//   post (after the immutable push, before any receipt/alias): ONLY 200 public and linked to this repository -> ok;
//        a 404 is retried a few times (the package may take a moment to appear), then stops. Anything else stops.
// Writes a durable JSON observation (no token, no response headers) and exits 0 only when the phase is satisfied.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const BODY_LIMIT = 256 * 1024;

/** The body's bytes, read as a stream and cancelled beyond `limit`; null when too large or unreadable. */
async function readBounded(response, limit = BODY_LIMIT) {
  if (Number(response.headers.get('Content-Length') ?? 0) > limit) { await response.body?.cancel().catch(() => {}); return null; }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); return null; }
      parts.push(value);
    }
  } catch { return null; }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

/** Pure decision for one answer. `body` is the parsed JSON (or null). */
export function classify(phase, status, body, { owner, name, repository }) {
  // Only a well-formed GitHub "not found" answer counts as absent; a malformed or unreadable 404 fails closed.
  if (status === 404) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.message !== 'string') return { ok: false, state: 'unknown' };
    return phase === 'pre' ? { ok: true, state: 'absent' } : { ok: false, state: 'absent', retry: true };
  }
  if (status !== 200 || !body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, state: 'unknown' };
  const visibility = typeof body?.visibility === 'string' ? body.visibility : null;
  const linked = body?.repository?.full_name ?? null;
  const facts = { visibility, repository: linked, owner: body?.owner?.login ?? null, name: body?.name ?? null, packageType: body?.package_type ?? null,
    id: Number.isSafeInteger(body?.id) ? body.id : null };
  if (facts.packageType !== 'container' || facts.name !== name || String(facts.owner ?? '').toLowerCase() !== owner.toLowerCase())
    return { ok: false, state: 'mismatch', ...facts };
  if (String(linked ?? '').toLowerCase() !== repository.toLowerCase()) return { ok: false, state: 'other_repository', ...facts };
  if (visibility !== 'public') return { ok: false, state: visibility ?? 'unknown', ...facts };
  return { ok: true, state: 'public', ...facts };
}

async function observe(phase, owner, name, { fetchImpl = fetch, token = process.env.GITHUB_TOKEN, repository = process.env.GITHUB_REPOSITORY,
  attempts = phase === 'post' ? 5 : 1, waitMs = 3000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!['pre', 'post'].includes(phase) || !NAME.test(owner ?? '') || !NAME.test(name ?? '') || !token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''))
    return { ok: false, state: 'usage' };
  let result = { ok: false, state: 'unknown' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let status = 0, body = null;
    try {
      const response = await fetchImpl(`https://api.github.com/orgs/${owner}/packages/container/${encodeURIComponent(name)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ledgetop-logs-publisher' },
        redirect: 'error', signal: AbortSignal.timeout(15_000) });
      status = response.status;
      const bytes = await readBounded(response);
      if (!bytes) { status = 0; } else { try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { body = null; } }
    } catch { status = 0; }
    result = { ...classify(phase, status, body, { owner, name, repository }), httpStatus: status, attempt };
    if (result.ok || !result.retry || attempt === attempts) break;
    await sleep(waitMs);
  }
  delete result.retry;
  return { schemaVersion: 1, phase, owner, package: name, repository, observedAt: new Date().toISOString(), ...result };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [, , phase, owner, name, out] = process.argv;
  const observation = await observe(phase, owner, name);
  if (out) fs.writeFileSync(out, `${JSON.stringify(observation)}\n`, { mode: 0o644 });
  console.log(JSON.stringify(observation));
  process.exitCode = observation.ok ? 0 : 1;
}

export { observe };
