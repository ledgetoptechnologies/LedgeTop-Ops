// Private, static-only service. Deployment approval and namespace verification
// are separate from this handler's path/MIME/size policy.
import { servePrivateUiReleaseAsset, uiReleasePrefix, type UiAssetFetcher } from '../../../packages/shared/src/ui-release-assets.ts';
import { uiReleaseForRequest } from '../../../packages/shared/src/ui-release-catalog.ts';

export default {
  async fetch(request: Request, env: UiReleaseAssetsEnv): Promise<Response> {
    const url = new URL(request.url);
    const deny = () => new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    if (url.origin !== 'https://ui-release.invalid' || url.search || url.hash
      || ['cookie', 'authorization', 'cf-access-jwt-assertion', 'referer'].some(name => request.headers.has(name))) return deny();
    const manifest = uiReleaseForRequest('operations', request.url) ?? uiReleaseForRequest('client', request.url);
    if (!manifest) return deny();
    // Both applications share one physical collection. Reapply the fixed,
    // validated prefix after the shared policy resolves a relative asset path.
    const assets: UiAssetFetcher = {
      fetch(input, init) {
        const original = new Request(input, init);
        const relative = new URL(original.url).pathname;
        return env.ASSETS.fetch(new Request(`https://ui-release.invalid${uiReleasePrefix(manifest)}${relative}`, {
          method: original.method, redirect: 'manual', signal: original.signal,
        }));
      },
    };
    return servePrivateUiReleaseAsset(request, assets, manifest);
  },
};
