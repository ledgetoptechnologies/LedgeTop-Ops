import { HTTPException } from "hono/http-exception";
import { isMovedSourceMarker } from "@ltds/shared";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const MIME: Record<string, string> = {
  avif: "image/avif", bmp: "image/bmp", gif: "image/gif", heic: "image/heic", heif: "image/heif", jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", tif: "image/tiff", tiff: "image/tiff", webp: "image/webp",
  mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8",
};

function reservedSegment(segment: string): boolean {
  const value = segment.toLowerCase();
  return value === "dump" || value === "_ltds" || value === ".previews";
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function encodeItemRef(relativePath: string): string { return bytesToBase64Url(encoder.encode(relativePath)); }

export function decodeItemRef(value: string): string {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new HTTPException(400, { message: "Invalid item reference" });
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64); const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return validateRelativePath(decoder.decode(bytes));
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: "Invalid item reference" });
  }
}

export function validateRelativePath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || /[\0-\x1f\x7f]/.test(value)) throw new HTTPException(400, { message: "Invalid item path" });
  const segments = value.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || reservedSegment(segment))) {
    throw new HTTPException(404, { message: "Item not found" });
  }
  return segments.join("/");
}

export function normalizeRoot(value: string): string {
  const root = value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  if (!root || root.split("/").some(segment => !segment || segment === "." || segment === ".." || reservedSegment(segment))) {
    throw new HTTPException(500, { message: "Delivery folder is invalid" });
  }
  return root.endsWith("/") ? root : `${root}/`;
}

export function keyWithinRoot(rootValue: string, relative: string): string {
  const root = normalizeRoot(rootValue); const clean = validateRelativePath(relative);
  const key = `${root}${clean}`;
  if (!key.startsWith(root)) throw new HTTPException(404, { message: "Item not found" });
  return key;
}

export function isHiddenKey(key: string): boolean {
  const segments = key.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments.some(reservedSegment);
}

export interface VisibleContentBucket {
  list(options:{prefix:string;delimiter:"/";limit:number;cursor?:string;include?:Array<"customMetadata">}):Promise<{objects:Array<{key:string;customMetadata?:Record<string,string>}>;delimitedPrefixes:string[];truncated:boolean;cursor?:string}>;
}

export async function prefixHasVisibleContent(bucket: VisibleContentBucket, rootValue: string): Promise<boolean> {
  const root = normalizeRoot(rootValue);
  const pending = [root];
  const visited = new Set<string>();
  while (pending.length) {
    const directory = pending.shift()!;
    if (visited.has(directory) || isHiddenKey(directory)) continue;
    visited.add(directory);
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({ prefix: directory, delimiter: "/", limit: 1000, cursor, include:["customMetadata"] });
      if (listed.objects.some(object => object.key !== directory && !object.key.endsWith("/") && !isHiddenKey(object.key) && !isMovedSourceMarker(object))) return true;
      for (const child of listed.delimitedPrefixes) if (!isHiddenKey(child)) pending.push(child);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
  return false;
}

/** Scans each descendant directory at most once and avoids per-folder fan-out. */
export async function visibleImmediateChildPrefixes(bucket:VisibleContentBucket,rootValue:string,candidates:readonly string[]):Promise<Set<string>>{
  const root=normalizeRoot(rootValue),allowed=new Set(candidates),visible=new Set<string>();
  const pending=candidates.filter(value=>value.startsWith(root)).map(value=>({directory:value,child:value}));
  const visited=new Set<string>();
  while(pending.length){const item=pending.shift()!;if(visible.has(item.child)||visited.has(item.directory)||isHiddenKey(item.directory))continue;visited.add(item.directory);let cursor:string|undefined;do{
    const listed=await bucket.list({prefix:item.directory,delimiter:"/",limit:1000,cursor,include:["customMetadata"]});
    if(listed.objects.some(object=>object.key!==item.directory&&!object.key.endsWith("/")&&!isHiddenKey(object.key)&&!isMovedSourceMarker(object))){visible.add(item.child);break;}
    for(const child of listed.delimitedPrefixes)if(!isHiddenKey(child))pending.push({directory:child,child:item.child});
    cursor=listed.truncated?listed.cursor:undefined;
  }while(cursor);}
  return new Set([...visible].filter(value=>allowed.has(value)));
}

function extension(key: string): string { const name = key.split("/").pop() || ""; return name.includes(".") ? (name.split(".").pop() || "").toLowerCase() : ""; }
export function mimeForKey(key: string): string { return MIME[extension(key)] || "application/octet-stream"; }
export function kindForKey(key: string): "image" | "video" | "audio" | "pdf" | "text" | "other" {
  const mime = mimeForKey(key); if (mime.startsWith("image/")) return "image"; if (mime.startsWith("video/")) return "video"; if (mime.startsWith("audio/")) return "audio"; if (mime === "application/pdf") return "pdf"; if (mime.startsWith("text/") || mime.startsWith("application/json")) return "text"; return "other";
}

export function safeFileName(key: string): string { return (key.split("/").pop() || "file").replace(/[\0-\x1f\x7f"\\]/g, "_").slice(0, 180) || "file"; }

export interface ByteRange { offset: number; length: number }
export function parseRange(value: string | undefined, size: number): ByteRange | undefined {
  if (!value) return undefined;
  if (!value.startsWith("bytes=") || value.includes(",")) throw new HTTPException(416, { message: "Unsupported range" });
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new HTTPException(416, { message: "Invalid range" });
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new HTTPException(416); return { offset: Math.max(0, size - suffix), length: Math.min(size, suffix) }; }
  const start = Number(match[1]); const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) throw new HTTPException(416, { message: "Range is outside the file" });
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}
