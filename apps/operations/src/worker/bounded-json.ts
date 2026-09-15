import { HTTPException } from "hono/http-exception";

/**
 * Decode JSON only after rejecting duplicate object members. JSON.parse uses
 * last-member-wins, which is unsafe at a protocol boundary because a sender
 * can make two readers disagree about the value that was signed or checked.
 * The scanner also bounds nesting so malformed remote input cannot consume an
 * unbounded call stack before the caller's byte limit applies.
 */
class DuplicateMemberScanner {
  private index = 0;
  private depth = 0;
  constructor(private readonly input: string) {}
  scan(): void { this.space(); this.value(); this.space(); if (this.index !== this.input.length) throw new SyntaxError(); }
  private space(): void { while (/[\x20\x09\x0a\x0d]/.test(this.input[this.index] ?? "")) this.index += 1; }
  private value(): void {
    if (this.depth++ >= 32) throw new SyntaxError();
    try {
      const current = this.input[this.index];
      if (current === "{") this.object();
      else if (current === "[") this.array();
      else if (current === "\"") this.string();
      else if (this.input.startsWith("true", this.index)) this.index += 4;
      else if (this.input.startsWith("false", this.index)) this.index += 5;
      else if (this.input.startsWith("null", this.index)) this.index += 4;
      else this.number();
    } finally { this.depth -= 1; }
  }
  private object(): void {
    this.index += 1; this.space(); const keys = new Set<string>();
    if (this.input[this.index] === "}") { this.index += 1; return; }
    for (;;) {
      if (this.input[this.index] !== "\"") throw new SyntaxError();
      const key = this.string(); if (keys.has(key)) throw new SyntaxError(); keys.add(key);
      this.space(); if (this.input[this.index++] !== ":") throw new SyntaxError(); this.space(); this.value(); this.space();
      const separator = this.input[this.index++]; if (separator === "}") return; if (separator !== ",") throw new SyntaxError(); this.space();
    }
  }
  private array(): void {
    this.index += 1; this.space(); if (this.input[this.index] === "]") { this.index += 1; return; }
    for (;;) { this.value(); this.space(); const separator = this.input[this.index++]; if (separator === "]") return; if (separator !== ",") throw new SyntaxError(); this.space(); }
  }
  private string(): string {
    const start = this.index++;
    while (this.index < this.input.length) {
      const code = this.input.charCodeAt(this.index++);
      if (code < 0x20) throw new SyntaxError();
      if (code === 0x22) {
        const token = this.input.slice(start, this.index);
        try { return JSON.parse(token) as string; } catch { throw new SyntaxError(); }
      }
      if (code === 0x5c) {
        const escape = this.input[this.index++];
        if (!escape || !'"\\\\/bfnrtu'.includes(escape)) throw new SyntaxError();
        if (escape === "u") {
          const hex = this.input.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError();
          this.index += 4;
        }
      }
    }
    throw new SyntaxError();
  }
  private number(): void {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = this.index; const value = match.exec(this.input); if (!value) throw new SyntaxError(); this.index += value[0].length;
  }
}

export function parseDuplicateFreeJson(input: string): unknown {
  new DuplicateMemberScanner(input).scan();
  return JSON.parse(input) as unknown;
}

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
  try { return parseDuplicateFreeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: `${label} body must be JSON` });
  }
}
