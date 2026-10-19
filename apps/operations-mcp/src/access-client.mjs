import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MAX_BYTES = 1024 * 1024;
const READONLY_POST = '/api/delivery/authenticated-grants/preview';

/** Diagnostics safe to display to the local operator or an MCP caller. */
export class AccessClientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccessClientError';
  }
}

export function loadConfig(env = process.env) {
  const raw = env.LTDS_OPS_ORIGIN ?? 'https://ops.ledgetopdroneservices.com';
  let url;
  try { url = new URL(raw); } catch { throw new AccessClientError('LTDS_OPS_ORIGIN must be an HTTPS origin.'); }
  if (typeof raw !== 'string' || !/^https:\/\/[^/?#]+\/?$/i.test(raw) || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || raw.includes('\\') || /[\s\x00-\x1f\x7f]/.test(raw)) {
    throw new AccessClientError('LTDS_OPS_ORIGIN must be an HTTPS origin without credentials, a path, query, or fragment.');
  }
  const agentId = env.LTDS_MCP_AGENT_ID ?? 'local-agent';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(agentId)) throw new AccessClientError('LTDS_MCP_AGENT_ID must be a 1–64 character label.');
  const cloudflaredPath = env.LTDS_CLOUDFLARED_PATH ?? 'cloudflared';
  if (typeof cloudflaredPath !== 'string' || !cloudflaredPath.trim() || /[\x00-\x1f\x7f]/.test(cloudflaredPath)) throw new AccessClientError('Invalid cloudflared executable path.');
  return Object.freeze({ origin: url.origin, allowWrites: env.LTDS_MCP_ALLOW_WRITES === 'true', agentId, cloudflaredPath });
}

async function command(config, args, timeout) {
  try {
    const result = await execute(config.cloudflaredPath, args, { shell: false, windowsHide: true, timeout, maxBuffer: 64 * 1024, encoding: 'utf8' });
    return result.stdout;
  } catch {
    // Child-process errors include command arguments and captured output: never propagate them.
    throw new AccessClientError('Cloudflare Access command failed. Check cloudflared installation and run the explicit login command.');
  }
}

export async function login(config = loadConfig()) {
  await command(config, ['access', 'login', '--quiet', config.origin], 120_000);
  return { authenticated: true };
}

function checkedToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  try {
    if (token.length > 32_768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new AccessClientError();
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000) + 5) throw new AccessClientError();
    return token;
  } catch { throw new AccessClientError('Cloudflare Access session is missing or expired. Run the explicit login command.'); }
}

function apiUrl(origin, path) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\\#\x00-\x20\x7f]/.test(path)) throw new AccessClientError('Invalid Operations API path.');
  // Reject encoded separators and dot segments before URL normalization can hide them.
  const pathname = path.split('?')[0];
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new AccessClientError('Invalid Operations API path.'); }
  if (decoded.includes('%') || decoded.includes('\\') || decoded.includes('//') || /[?#\x00-\x20\x7f]/.test(decoded)
      || decoded.split('/').some(segment => segment === '.' || segment === '..') || /%2f/i.test(pathname)) throw new AccessClientError('Invalid Operations API path.');
  const url = new URL(path, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/api/')) throw new AccessClientError('Invalid Operations API path.');
  return url;
}

const secretKey = /^(?:csrf.*|.*(?:token|secret|password)|authorization|cookie|set-cookie|headers|cf-access.*)$/i;
function sanitized(value, token, csrf) {
  if (typeof value === 'string') return value.split(token).join('[redacted]').split(csrf || '\u0000').join('[redacted]');
  if (Array.isArray(value)) return value.map(item => sanitized(item, token, csrf));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKey.test(key)).map(([key, item]) => [key, sanitized(item, token, csrf)]));
  return value;
}

export class AccessClient {
  #config; #fetch; #getToken;
  constructor(config = loadConfig(), { fetch = globalThis.fetch, getToken } = {}) {
    // Validate even hand-built config objects; callers cannot bypass origin/write parsing.
    this.#config = loadConfig({ LTDS_OPS_ORIGIN: config.origin, LTDS_MCP_AGENT_ID: config.agentId,
      LTDS_MCP_ALLOW_WRITES: config.allowWrites === true ? 'true' : 'false', LTDS_CLOUDFLARED_PATH: config.cloudflaredPath });
    this.#fetch = fetch;
    this.#getToken = getToken ?? (() => command(this.#config, ['access', 'token', '--app', this.#config.origin], 15_000));
  }

  async #token() {
    try { return checkedToken(await this.#getToken()); }
    catch (error) {
      if (error instanceof AccessClientError && error.message === 'Cloudflare Access command failed. Check cloudflared installation and run the explicit login command.') throw error;
      throw new AccessClientError('Cloudflare Access session unavailable. Run the explicit login command.');
    }
  }

  async #send(url, token, method = 'GET', body, csrf, idempotencyKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const headers = { Accept: 'application/json', 'Cf-Access-Token': token, 'X-LTDS-Agent-Id': this.#config.agentId };
      if (csrf) { headers.Origin = this.#config.origin; headers['X-CSRF-Token'] = csrf; }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
      const response = await this.#fetch(url.href, { method, headers, body, redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new AccessClientError(`Operations request failed (HTTP ${response.status}).`);
      if (response.redirected || (response.url && new URL(response.url).origin !== this.#config.origin)) throw new AccessClientError('Unexpected Operations response.');
      if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new AccessClientError('Operations returned a non-JSON response.');
      if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new AccessClientError('Operations response exceeded the size limit.');
      if (!response.body) throw new AccessClientError('Operations returned an empty response.');
      const reader = response.body.getReader();
      const chunks = []; let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_BYTES) { await reader.cancel(); throw new AccessClientError('Operations response exceeded the size limit.'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new AccessClientError('Operations returned invalid JSON.'); }
    } catch (error) {
      // Only errors constructed here are safe; fetch/stream errors may contain credentials.
      const allowed = /^(?:Operations request failed \(HTTP \d{3}\)\.|Unexpected Operations response\.|Operations returned (?:a non-JSON response|an empty response|invalid JSON)\.|Operations response exceeded the size limit\.)$/;
      if (error instanceof AccessClientError && allowed.test(error.message)) throw new AccessClientError(error.message);
      throw new AccessClientError('Operations connection failed or timed out.');
    } finally { clearTimeout(timer); controller.abort(); }
  }

  async session() {
    const token = await this.#token();
    const value = await this.#send(apiUrl(this.#config.origin, '/api/session'), token);
    if (!value?.user || typeof value.user.id !== 'string') throw new AccessClientError('Operations returned an invalid session.');
    const user = Object.fromEntries(['id', 'email', 'displayName', 'status', 'profileType', 'isAdministrator', 'permissions', 'divisions'].filter(key => Object.hasOwn(value.user, key)).map(key => [key, value.user[key]]));
    const capabilities = value.capabilities && typeof value.capabilities === 'object' && !Array.isArray(value.capabilities)
      ? sanitized(value.capabilities, token, value.csrfToken) : {};
    return { user: sanitized(user, token, value.csrfToken), capabilities, agentId: this.#config.agentId, allowWrites: this.#config.allowWrites };
  }

  async request(path, { method = 'GET', body, idempotencyKey } = {}) {
    if (typeof method !== 'string' || !['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase())) throw new AccessClientError('Unsupported Operations HTTP method.');
    method = method.toUpperCase();
    const mutation = method !== 'GET';
    if (mutation && !(method === 'POST' && path === READONLY_POST) && !this.#config.allowWrites) throw new AccessClientError('Operations writes are disabled. Set LTDS_MCP_ALLOW_WRITES=true to enable them.');
    const url = apiUrl(this.#config.origin, path);
    if (method === 'GET' && body !== undefined) throw new AccessClientError('GET requests cannot have a body.');
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey))) throw new AccessClientError('Invalid idempotency key.');
    let serialized;
    try { serialized = body === undefined ? undefined : JSON.stringify(body); }
    catch { throw new AccessClientError('Operations request body must be JSON.'); }
    if (serialized !== undefined && Buffer.byteLength(serialized) > MAX_BYTES) throw new AccessClientError('Operations request body exceeded the size limit.');
    const token = await this.#token();
    let csrf;
    if (mutation) {
      const session = await this.#send(apiUrl(this.#config.origin, '/api/session'), token);
      if (typeof session?.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(session.csrfToken)) throw new AccessClientError('Operations returned an invalid session.');
      csrf = session.csrfToken;
    }
    return sanitized(await this.#send(url, token, method, serialized, csrf, idempotencyKey), token, csrf);
  }
}
