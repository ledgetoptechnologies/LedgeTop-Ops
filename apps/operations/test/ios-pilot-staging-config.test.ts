import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PilotStagingConfig {
  name: string;
  account_id: string;
  workers_dev: boolean;
  preview_urls: boolean;
  keep_vars: boolean;
  vars: Record<string, string>;
  d1_databases: Array<{ binding: string; database_name: string; database_id: string }>;
}

const config = JSON.parse(readFileSync(
  new URL('../wrangler.ios-pilot-read-staging.jsonc', import.meta.url), 'utf8',
)) as PilotStagingConfig;

describe('iOS pilot staging Worker configuration', () => {
  it('keeps managed reads closed and requires an externally provisioned manifest', () => {
    expect(config.keep_vars).toBe(false);
    expect(config.vars.IOS_MANAGED_PILOT_ENABLED).toBe('false');
    expect(config.vars.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED).toBe('true');
    expect(config.vars).not.toHaveProperty('PROJECT_ALPHA_CONNECTOR_SOURCES');
  });

  it('targets only the isolated staging account and database', () => {
    expect(config.name).toBe('lt-ops-ios-pilot-read-staging');
    expect(config.account_id).toBe('846c924bf17bf4f3dd15c97a4c5d1d51');
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.d1_databases).toEqual([{
      binding: 'OPS_DB',
      database_name: 'ltds-ops-staging',
      database_id: '78b34173-b168-4e3d-9832-bb9d245cc6b8',
    }]);
  });
});
