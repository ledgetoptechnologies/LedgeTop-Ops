import { dispatchLogsDecoderBridge } from "./logs-decoder-bridge";
import type { Env } from "./types";

/**
 * The dedicated minimal decoder machine bridge Worker (wrangler.logs-decoder-bridge-staging.jsonc). It is a tiny
 * auth/proxy in front of the parser-only Logs DecoderService: no decoding, no staff app, no assets, no Ops database.
 * Everything that is not a valid decoder machine call on the configured host is a plain 404; nothing falls through.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await dispatchLogsDecoderBridge(request, env);
    if (response) return response;
    await request.body?.cancel().catch(() => {});
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Cache-Control": "private, no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" },
    });
  },
};
