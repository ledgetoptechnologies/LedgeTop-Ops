import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }));
import edge from '../src/worker/staging-ios-edge-entrypoint';
import { readPilotRpc } from '../src/worker/ios-pilot-read-rpc';
import { IOS_PILOT_REVIEWED_ORIGINS } from '../src/worker/ios-pilot-reviewed-origins';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const edgeConfig = read('wrangler.ios-pilot-edge-staging-account.jsonc');
const readerConfig = read('wrangler.ios-pilot-read-staging-account.jsonc');
const origin = 'https://ledge-top-ios-edge-staging.ledge-top-staging.workers.dev';
const iosAudience = '17f32ab9f964a3e4c64864e06d3d0e1b128604192b9a7e457db1f8f88b8f5707';
const operationsAudience = 'ffb0d85b1929560fbafd7476a987401e0e25dc5000a251fcdcf85bc2ae5d7f84';

describe('separate Staging-account iOS candidates', () => {
  it('uses the allocated account and graph names without production authority', () => {
    expect(edgeConfig.name).toBe('ledge-top-ios-edge-staging');
    expect(readerConfig.name).toBe('ledge-top-ios-read-staging');
    for (const config of [edgeConfig, readerConfig]) {
      expect(config.account_id).toBe('df3f376bae6ee621f50cf972ebcc9484');
      expect(config.vars.ENVIRONMENT).toBe('staging');
      for (const legacy of ['846c924bf17bf4f3dd15c97a4c5d1d51', '78b34173-b168-4e3d-9832-bb9d245cc6b8',
        '559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b',
        'e982d104616a480315256a577ef5ad5ce089f382c0b5453ce9db4cd9df7cf89d'])
        expect(JSON.stringify(config)).not.toContain(legacy);
    }
  });
  it('keeps all public exposure and pilot/probe enablement off', () => {
    for (const config of [edgeConfig, readerConfig]) {
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config.keep_vars).toBe(false);
      expect(config.routes).toEqual([]);
      expect(config.vars.IOS_MANAGED_PILOT_ENABLED).toBe('false');
      expect(config.triggers).toBeUndefined();
      expect(config.queues).toBeUndefined();
      expect(config.vars.PROJECT_ALPHA_CONNECTOR_SOURCES).toBeUndefined();
    }
    expect(edgeConfig.vars.IOS_OAUTH_PROBE_ENABLED).toBe('false');
  });
  it('pins reviewed pilot and distinct Ops audiences to the Staging issuer', () => {
    for (const config of [edgeConfig, readerConfig]) {
      expect(config.vars.TEAM_DOMAIN).toBe('https://ledge-top-staging.cloudflareaccess.com');
      expect(config.vars.IOS_MANAGED_PILOT_ORIGIN).toBe(origin);
      expect(config.vars.IOS_MANAGED_PILOT_AUDIENCE).toBe(iosAudience);
      expect(config.vars.OPERATIONS_AUD).toBe(operationsAudience);
    }
    expect(iosAudience).not.toBe(operationsAudience);
    expect(readerConfig.vars.PUBLIC_BASE_URL).toBe('https://ledge-top-ops-staging.ledge-top-staging.workers.dev');
  });
  it('binds only the minimal private reader and allocated Ops database', () => {
    expect(edgeConfig.main).toBe('src/worker/staging-ios-edge-entrypoint.ts');
    expect(edgeConfig.services).toEqual([{ binding: 'IOS_PILOT_READ', service: readerConfig.name, entrypoint: 'IosPilotReadService' }]);
    expect(edgeConfig.d1_databases).toBeUndefined();
    expect(readerConfig.main).toBe('src/worker/staging-ios-private-read-entrypoint.ts');
    expect(readerConfig.d1_databases).toEqual([{ binding: 'OPS_DB', database_name: 'ledge-top-ops-staging', database_id: 'a58ea102-f04d-417a-bfd1-b0654cfeb503' }]);
    expect(readerConfig.services).toBeUndefined();
    expect(readerConfig.vars.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED).toBe('true');
  });
  it('preserves the two legacy config bodies with checkout line endings normalized', () => {
    for (const [file, digest] of [
      ['wrangler.ios-pilot-read-staging.jsonc', 'e21c5c8a28ab62accf8578836d07f3937415b6c5d32bb5543351b6d695f47d20'],
      ['wrangler.ios-pilot-edge-staging.jsonc', 'd13cbc2e878d9da5dfa06539e6952f8fe8c691e094a0f6a48352cb4e01094ed5'],
    ]) {
      const body = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      expect(createHash('sha256').update(body).digest('hex')).toBe(digest);
    }
  });
  it('keeps the actual new edge handler closed even on its reviewed host', async () => {
    for (const path of ['/mobile-pilot/v1/session', '/mobile-pilot/v1/operations', '/oauth-probe/v1', '/api/operations']) {
      const response = await edge.fetch(new Request(`${origin}${path}`), edgeConfig.vars);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    const result = JSON.parse(await readPilotRpc('{}', readerConfig.vars, IOS_PILOT_REVIEWED_ORIGINS));
    expect(result).toEqual({ version: 1, status: 404, body: { error: 'Not found', code: 'not_found' } });
  });
});
