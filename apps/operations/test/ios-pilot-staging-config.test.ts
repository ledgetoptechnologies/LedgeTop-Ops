import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface StagingConfigBase {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  account_id: string;
  workers_dev: boolean;
  preview_urls: boolean;
  keep_vars: boolean;
  vars: Record<string, string>;
}

interface PilotStagingConfig extends StagingConfigBase {
  routes: unknown[];
  d1_databases: Array<{ binding: string; database_name: string; database_id: string; migrations_dir: string }>;
}

interface PilotEdgeConfig extends StagingConfigBase {
  routes: Array<{ pattern: string; custom_domain?: boolean }>;
  services: Array<{ binding: string; service: string; entrypoint?: string }>;
}

const config = JSON.parse(readFileSync(
  new URL('../wrangler.ios-pilot-read-staging.jsonc', import.meta.url), 'utf8',
)) as PilotStagingConfig;
const edgeConfig = JSON.parse(readFileSync(
  new URL('../wrangler.ios-pilot-edge-staging.jsonc', import.meta.url), 'utf8',
)) as PilotEdgeConfig;

describe('iOS pilot staging Worker configuration', () => {
  it('keeps managed reads closed and requires an externally provisioned manifest', () => {
    expect(config.keep_vars).toBe(false);
    expect(config.vars.IOS_MANAGED_PILOT_ENABLED).toBe('false');
    expect(config.vars.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED).toBe('true');
    expect(config.vars).not.toHaveProperty('PROJECT_ALPHA_CONNECTOR_SOURCES');
    expect(config.vars).not.toHaveProperty('PROJECT_ALPHA_API_V2_CONNECTIONS');
  });

  it('targets only the isolated staging account and database', () => {
    expect(config.name).toBe('ledge-top-ios-read-staging');
    expect(config.main).toBe('src/worker/ios-pilot-private-entrypoint.ts');
    expect(config.account_id).toBe('df3f376bae6ee621f50cf972ebcc9484');
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toEqual([]);
    expect(config.d1_databases).toEqual([{
      binding: 'OPS_DB',
      database_name: 'ledge-top-ops-staging',
      database_id: 'a58ea102-f04d-417a-bfd1-b0654cfeb503',
      migrations_dir: 'migrations',
    }, {
      binding: 'DELIVERY_DB',
      database_name: 'ledge-top-portal-staging',
      database_id: '15d02028-8c52-40b2-9979-d67abf7d5bbf',
      migrations_dir: '../client/migrations',
    }]);
  });

  it('keeps the public edge gate closed and its route and service binding exact', () => {
    expect(edgeConfig.keep_vars).toBe(false);
    expect(edgeConfig.vars.IOS_MANAGED_PILOT_ENABLED).toBe('false');
    expect(edgeConfig.vars.IOS_OAUTH_PROBE_ENABLED).toBe('false');
    expect(edgeConfig.name).toBe('ledge-top-ios-edge-staging');
    expect(edgeConfig.main).toBe('src/worker/ios-pilot-edge-bridge.ts');
    expect(edgeConfig.account_id).toBe(config.account_id);
    expect(edgeConfig.workers_dev).toBe(false);
    expect(edgeConfig.preview_urls).toBe(false);
    expect(edgeConfig.routes).toEqual([]);
    expect(edgeConfig.services).toEqual([{
      binding: 'IOS_PILOT_READ',
      service: 'ledge-top-ios-read-staging',
      entrypoint: 'IosPilotReadService',
    }, {
      binding: 'IOS_PILOT_BUSINESS_READ',
      service: 'ledge-top-ios-read-staging',
      entrypoint: 'IosPilotBusinessReadService',
    }]);
  });

  it('uses the dedicated Access audience and issuer consistently, without admitting an origin', () => {
    for (const candidate of [config, edgeConfig]) {
      expect(candidate.vars.TEAM_DOMAIN).toBe('https://ledge-top-staging.cloudflareaccess.com');
      expect(candidate.vars.IOS_MANAGED_PILOT_ORIGIN).toBe('https://ledge-top-ios-edge-staging.ledge-top-staging.workers.dev');
      expect(candidate.vars.IOS_MANAGED_PILOT_AUDIENCE).toBe('17f32ab9f964a3e4c64864e06d3d0e1b128604192b9a7e457db1f8f88b8f5707');
      expect(candidate.vars.OPERATIONS_AUD).toBe('ffb0d85b1929560fbafd7476a987401e0e25dc5000a251fcdcf85bc2ae5d7f84');
      expect(candidate.vars.OPERATIONS_AUD).not.toBe(candidate.vars.IOS_MANAGED_PILOT_AUDIENCE);
    }
  });

  it('keeps every pilot switch closed and excludes credentials and ordinary web-session secrets', () => {
    const publicVariables = new Set(['ENVIRONMENT', 'PUBLIC_BASE_URL', 'TEAM_DOMAIN', 'OPERATIONS_AUD',
      'IOS_MANAGED_PILOT_ENABLED', 'IOS_PILOT_BUSINESS_ENABLED', 'IOS_OAUTH_PROBE_ENABLED',
      'IOS_MANAGED_PILOT_ORIGIN', 'IOS_MANAGED_PILOT_AUDIENCE', 'IOS_OAUTH_PROBE_AUDIENCE',
      'PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED']);
    for (const candidate of [config, edgeConfig]) {
      expect(candidate.compatibility_date).toBe('2026-07-22');
      expect(candidate.compatibility_flags).toEqual(['nodejs_compat']);
      expect(candidate).not.toHaveProperty('env');
      for (const flag of ['IOS_MANAGED_PILOT_ENABLED', 'IOS_PILOT_BUSINESS_ENABLED', 'IOS_OAUTH_PROBE_ENABLED'])
        expect(candidate.vars[flag]).toBe('false');
      expect(Object.keys(candidate.vars).every(name => publicVariables.has(name))).toBe(true);
      expect(candidate.vars).not.toHaveProperty('OPERATIONS_SESSION_SECRET');
      expect(candidate.vars).not.toHaveProperty('PROJECT_ALPHA_CONNECTOR_SOURCES');
      expect(candidate.vars).not.toHaveProperty('PROJECT_ALPHA_API_V2_CONNECTIONS');
    }
    expect(edgeConfig).not.toHaveProperty('d1_databases');
    expect(edgeConfig).not.toHaveProperty('assets');
    expect(config).not.toHaveProperty('services');
  });
});
