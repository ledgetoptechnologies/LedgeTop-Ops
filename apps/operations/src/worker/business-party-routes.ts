import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { mutateBusinessParty, previewBusinessParty, readBusinessParty } from "./business-parties";
import type { Env, StaffPrincipal } from "./types";

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
async function body(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new HTTPException(415, { message: "Business link requests must use application/json" });
  if (!request.body) throw new HTTPException(400, { message: "Business link request must contain JSON" });
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + 5000;
  try {
    await Promise.race([
      (async () => { while (true) {
        if (Date.now() >= deadline) throw new HTTPException(408, { message: "Business link request timed out" });
        const next = await reader.read(); if (next.done) return;
        size += next.value.byteLength;
        if (size > 64 * 1024) throw new HTTPException(413, { message: "Business link request is too large" });
        if (next.value.byteLength) chunks.push(next.value);
      } })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HTTPException(408, { message: "Business link request timed out" })), 5000); }),
    ]);
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new HTTPException(400, { message: "Business link request must contain valid JSON" }); }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([reader.cancel().catch(() => undefined), new Promise<void>(resolve => { cancelTimer = setTimeout(resolve, 50); })]);
    if (cancelTimer !== undefined) clearTimeout(cancelTimer);
    reader.releaseLock();
  }
}
/** Mount under the existing authenticated Operations origin/CSRF middleware.
 * Store functions recheck live staff authority, including inside write batches. */
export function registerBusinessPartyRoutes(app: App): void {
  const root = "/api/business-parties";
  app.use(`${root}/*`, async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.post(`${root}/preview`, async context => context.json({ preview: await previewBusinessParty(context.env,
    context.get("principal"), await body(context.req.raw)) }));
  app.post(root, async context => context.json(await mutateBusinessParty(context.env, context.get("principal"), await body(context.req.raw))));
  app.get(`${root}/:partyId`, async context => context.json({ party: await readBusinessParty(context.env,
    context.get("principal"), context.req.param("partyId")) }));
}
