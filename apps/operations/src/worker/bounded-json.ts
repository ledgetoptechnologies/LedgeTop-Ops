import { HTTPException } from "hono/http-exception";

/** Read a small JSON mutation body without letting Content-Length omission or
 * chunked transfer encoding bypass the limit. */
export async function readBoundedJson(request: Request, maximumBytes: number, label = "Request"): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json"))
    throw new HTTPException(400, { message: `${label} body must be JSON` });
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new HTTPException(400, { message: "Content-Length is invalid" });
    const size = Number(declared);
    if (!Number.isSafeInteger(size)) throw new HTTPException(400, { message: "Content-Length is invalid" });
    if (size > maximumBytes) throw new HTTPException(413, { message: `${label} body is too large` });
  }
  if (!request.body) throw new HTTPException(400, { message: `${label} body must be JSON` });
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("request_body_too_large");
        throw new HTTPException(413, { message: `${label} body is too large` });
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: `${label} body must be JSON` });
  }
}
