import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import base from '../playwright.config';
import dualDomain from '../playwright.j7.config';

describe('Client browser suite partitions', () => {
  it('keeps hostname assertions in the dedicated two-domain configuration', () => {
    expect(base.testIgnore).toContain('**/dual-domain-daily-use.spec.ts');
    expect(dualDomain.testMatch).toBe('dual-domain-daily-use.spec.ts');
    expect(dualDomain.testIgnore).toBeUndefined();
    expect(dualDomain.projects?.map(project => project.use?.baseURL)).toEqual([
      'http://portal.drone.test:4173', 'http://portal.technology.test:4173',
      'http://portal.drone.test:4173', 'http://portal.technology.test:4173',
    ]);
  });

  it('runs both partitions in the complete browser test command', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.scripts['test:browser']).toContain('playwright test --config playwright.config.ts');
    expect(manifest.scripts['test:browser']).toContain('&& playwright test --config playwright.j7.config.ts');
  });
});
