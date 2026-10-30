import { handleManagedIosPilot } from './ios-pilot-managed-routes';
import { isReviewedPilotOrigin } from './ios-pilot-managed-entrypoint';
import type { Env } from './types';

type PilotEnv = Env & {
  IOS_MANAGED_PILOT_ENABLED?: string;
  IOS_MANAGED_PILOT_ORIGIN?: string;
  IOS_MANAGED_PILOT_AUDIENCE?: string;
};
type ReadHandler = typeof handleManagedIosPilot;
const MAX_INPUT = 24_576;
const MAX_OUTPUT = 1_048_576;
const denied = JSON.stringify({ version: 1, status: 404, body: { error: 'Not found', code: 'not_found' } });
const unavailable = JSON.stringify({ version: 1, status: 503, body: { error: 'Pilot temporarily unavailable', code: 'unavailable' } });

/** Internal RPC boundary. Input contains only a URL and the Access assertion;
 * it never accepts a caller-supplied principal or permissions. The named
 * entrypoint supplies its own fixed origin list and the real read handler. */
export async function readPilotRpc(input: unknown, env: PilotEnv, reviewedOrigins: readonly string[],
  handler: ReadHandler = handleManagedIosPilot): Promise<string> {
  if (env.ENVIRONMENT !== 'staging' || env.IOS_MANAGED_PILOT_ENABLED !== 'true'
    || !env.IOS_MANAGED_PILOT_ORIGIN || !env.IOS_MANAGED_PILOT_AUDIENCE
    || !isReviewedPilotOrigin(env.IOS_MANAGED_PILOT_ORIGIN, env.PUBLIC_BASE_URL, reviewedOrigins)) return denied;
  if (typeof input !== 'string' || input.length > MAX_INPUT) return denied;
  try {
    const data: unknown = JSON.parse(input);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return denied;
    const object = data as Record<string, unknown>;
    if (Object.keys(object).sort().join(',') !== 'assertion,url'
      || typeof object.url !== 'string' || object.url.length > 9000
      || typeof object.assertion !== 'string' || object.assertion.length > 16_384
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(object.assertion)) return denied;
    const url = new URL(object.url);
    if (url.origin !== env.IOS_MANAGED_PILOT_ORIGIN || url.username || url.password || url.hash) return denied;
    // The original bearer is deliberately not forwarded across the binding.
    // The signed assertion is independently checked by the facade. The public
    // edge must validate its OAuth bearer before forwarding that assertion.
    const request = new Request(url, { method: 'GET', headers: {
      Authorization: 'Bearer rpc-internal', 'Cf-Access-Jwt-Assertion': object.assertion,
    } });
    const response = await handler(request, env, { enabled: env.IOS_MANAGED_PILOT_ENABLED,
      origin: env.IOS_MANAGED_PILOT_ORIGIN, audience: env.IOS_MANAGED_PILOT_AUDIENCE });
    if (![200, 400, 401, 403, 404, 405, 503].includes(response.status) || !response.body) return unavailable;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_OUTPUT) { await reader.cancel(); return unavailable; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return unavailable;
    return JSON.stringify({ version: 1, status: response.status, body });
  } catch { return unavailable; }
}
