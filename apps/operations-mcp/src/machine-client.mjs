import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessClientError } from './access-client.mjs';

const ORIGIN = 'https://ops-staging.ledgetopdroneservices.com';
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const fail = () => new AccessClientError('Staging machine read unavailable. Check current agent registration, scope and credential file.');

export function machineConfig(env = process.env) {
  const credentialFile = env.LTDS_MCP_MACHINE_CREDENTIAL_FILE;
  if (typeof credentialFile !== 'string' || !path.isAbsolute(credentialFile) || /[\x00-\x1f\x7f]/.test(credentialFile)
    || (env.LTDS_OPS_ORIGIN !== undefined && env.LTDS_OPS_ORIGIN !== ORIGIN)) throw fail();
  return Object.freeze({ origin: ORIGIN, credentialFile });
}
async function readCredential(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20000 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw fail();
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'clientId,clientSecret'
    || ![value.clientId, value.clientSecret].every(v => typeof v === 'string' && /^[\x21-\x7e]{1,8192}$/.test(v))) throw fail();
  // Current cfast_ and older64hex secrets both work; no invented secret format.
  return value;
}

/** Independent three-read transport. Never calls cloudflared or human API routes. */
export class MachineReadClient {
  #configuration; #fetch; #readCredential;
  constructor(configuration = machineConfig(), { fetch = globalThis.fetch, loadCredential = readCredential } = {}) {
    this.#configuration = machineConfig({ LTDS_OPS_ORIGIN: configuration.origin, LTDS_MCP_MACHINE_CREDENTIAL_FILE: configuration.credentialFile });
    this.#fetch = fetch; this.#readCredential = loadCredential;
  }
  async #get(route) {
    let credential;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      credential = await this.#readCredential(this.#configuration.credentialFile);
      const response = await this.#fetch(`${this.#configuration.origin}/api/agent/v1${route}`, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', 'CF-Access-Client-Id': credential.clientId, 'CF-Access-Client-Secret': credential.clientSecret },
      });
      if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== this.#configuration.origin)
        || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body
        || Number(response.headers.get('content-length')) > 1048576) throw fail();
      const chunks = [], reader = response.body.getReader(); let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 1048576) { await reader.cancel(); throw fail(); } chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const redact = value => {
        if (typeof value === 'string') return value.split(credential.clientSecret).join('[redacted]').split(credential.clientId).join('[redacted]');
        if (Array.isArray(value)) return value.map(redact);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
          .filter(([key]) => !/(?:token|secret|credential|password|authorization|cookie|headers)/i.test(key)).map(([key, child]) => [key, redact(child)]));
        return value;
      };
      return redact(result);
    } catch { throw fail(); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  connection() { return this.#get('/connection'); }
  findClients({ sourceId, q, cursor, limit } = {}) {
    if (!SOURCE.test(sourceId ?? '') || (q !== undefined && (typeof q !== 'string' || q.length > 100 || /\p{C}/u.test(q)))
      || (cursor !== undefined && !ID.test(cursor)) || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 25))) throw fail();
    const params = new URLSearchParams(Object.entries({ sourceId, q, cursor, limit }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return this.#get(`/clients?${params}`);
  }
  getClient({ sourceId, recordId } = {}) {
    if (!SOURCE.test(sourceId ?? '') || !ID.test(recordId ?? '')) throw fail();
    return this.#get(`/clients/${encodeURIComponent(sourceId)}/${encodeURIComponent(recordId)}`);
  }
}
