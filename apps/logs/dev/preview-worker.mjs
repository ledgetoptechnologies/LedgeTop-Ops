// Local-preview Worker: runs the real logs service inside workerd, so each preview request is one call
// into the runtime instead of hundreds of Node-to-runtime database round trips. Test only.
import * as service from '../src/worker/service.mjs';

const CALLS = new Set(['inventory', 'startImport', 'importFlights', 'completeImport', 'listFlights', 'facets', 'overview', 'getFlight']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const rpc = /^\/rpc\/(\w+)$/.exec(url.pathname);
      if (rpc && CALLS.has(rpc[1]) && request.method === 'POST') {
        const { actor, args = [] } = await request.json();
        return Response.json({ ok: true, value: await service[rpc[1]](env, actor, ...args) });
      }
      const put = /^\/track\/([\w-]+)\/([\w-]+)$/.exec(url.pathname);
      if (put && request.method === 'PUT') {
        const actor = JSON.parse(request.headers.get('x-actor'));
        return Response.json({ ok: true, value: await service.putTelemetry(env, actor, put[1], put[2], new Uint8Array(await request.arrayBuffer())) });
      }
      const get = /^\/track\/([\w-]+)$/.exec(url.pathname);
      if (get) {
        const actor = JSON.parse(request.headers.get('x-actor'));
        return new Response(await service.getTelemetry(env, actor, get[1]), { headers: { 'Content-Type': 'application/octet-stream' } });
      }
      if (url.pathname === '/sql' && request.method === 'POST') {
        const { sql } = await request.json();
        for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await env.LOGS_DB.prepare(statement).run();
        return Response.json({ ok: true });
      }
      if (url.pathname === '/state') {
        const flights = await env.LOGS_DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='flights'").first();
        const done = flights ? await env.LOGS_DB.prepare("SELECT COUNT(*) AS n FROM imports WHERE status = 'completed'").first() : null;
        return Response.json({ migrated: Boolean(flights), completedImports: done?.n ?? 0 });
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      return Response.json({ ok: false, error: { code: error.code ?? 'internal', status: error.status ?? 500, message: error.message } }, { status: error.status ?? 500 });
    }
  },
};
