// Dedicated private reader candidate for the separate-account migration.
// No current deployment config selects it. Unlike the older broad staging
// wrapper, it exposes no Operations handler, write RPC or Workflow entrypoint.
export { IosPilotReadService } from './ios-pilot-read-entrypoint';

export default {
  fetch(): Response {
    return Response.json({ error: 'Not found', code: 'not_found' }, {
      status: 404,
      headers: { 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store' },
    });
  },
};
