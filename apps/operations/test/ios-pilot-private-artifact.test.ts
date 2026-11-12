import { describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }));
import * as artifact from '../src/worker/staging-ios-private-read-entrypoint';
import { IOS_PILOT_REVIEWED_ORIGINS } from '../src/worker/ios-pilot-reviewed-origins';
import { isReviewedPilotOrigin } from '../src/worker/ios-pilot-managed-entrypoint';

describe('dedicated private iOS reader artifact', () => {
  it('exports only the read service and a closed HTTP handler', () => {
    expect(Object.keys(artifact).sort()).toEqual(['IosPilotReadService', 'default']);
    expect(Object.getOwnPropertyNames(artifact.IosPilotReadService.prototype).sort()).toEqual(['constructor', 'read']);
  });
  it('never dispatches HTTP to the Operations app, including write and pilot paths', async () => {
    // The handler accepts no request/env, so no method/path can enable an HTTP data path.
    const response = artifact.default.fetch();
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Not found', code: 'not_found' });
  });
  it('keeps the same frozen reviewed origins for edge and reader without env expansion', () => {
    expect(Object.isFrozen(IOS_PILOT_REVIEWED_ORIGINS)).toBe(true);
    expect(IOS_PILOT_REVIEWED_ORIGINS).toEqual(['https://ios-pilot-staging.ledgetop.app']);
    expect(isReviewedPilotOrigin('https://unallocated-staging.example.test',
      'https://ops-staging.example.test', IOS_PILOT_REVIEWED_ORIGINS)).toBe(false);
  });
  it('bundles with exactly the private read service and closed default export', async () => {
    const built = await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true },
      build: { ssr: fileURLToPath(new URL('../src/worker/staging-ios-private-read-entrypoint.ts', import.meta.url)),
        target: 'esnext', write: false, minify: false,
        rollupOptions: { external: id => id.startsWith('cloudflare:') } } });
    const output = Array.isArray(built) ? built[0] : built;
    if (!output || !('output' in output)) throw Error('Private reader bundle missing');
    const entry = output.output.find(item => item.type === 'chunk' && item.isEntry);
    if (!entry || entry.type !== 'chunk') throw Error('Private reader entry missing');
    expect(entry.exports.sort()).toEqual(['IosPilotReadService', 'default']);
    // No broader staging entrypoint should be in the actual bundled module graph.
    expect(Object.keys(entry.modules).some(path => /staging-native-authority-entrypoint|\/worker\/index\.ts$/.test(path))).toBe(false);
  }, 30_000);
});
