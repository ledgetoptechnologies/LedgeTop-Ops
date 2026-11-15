export { IosPilotReadService } from './ios-pilot-read-entrypoint';
export { IosPilotBusinessReadService } from './ios-pilot-business-entrypoint';

/** Private RPC bindings only; no public HTTP router is exposed. */
export default {
  fetch(): Response {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },
};
