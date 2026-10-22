import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(new URL('../apps/operations/package.json', import.meta.url));
export default {
  root: fileURLToPath(new URL('..', import.meta.url)),
  resolve: { alias: {
    vitest: join(dirname(require.resolve('vitest/package.json')), 'dist/index.js'),
    miniflare: require.resolve('miniflare'),
    wrangler: require.resolve('wrangler'),
  } },
  test: {
    environment: 'node',
    include: ['scripts/independent-staff-client-acceptance.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
};
