import { HTTPException } from "hono/http-exception";
import type { Env, StaffPrincipal } from "./types";
import { isMovedSourceMarker } from "@ltds/shared";

const CONTROL = /[\0-\x1f\x7f]/;
const ALIAS_QUERY_BATCH = 75;

export interface AliasRow { physical_key: string; parent_key: string; display_name: string }

export function aliasParent(key: string): string {
  const clean = key.endsWith("/") ? key.slice(0, -1) : key;
  const index = clean.lastIndexOf("/");
  return index < 0 ? "" : clean.slice(0, index + 1);
}

export function validateDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new HTTPException(400, { message: "displayName is required" });
  const name = value.trim();
  const lower = name.toLowerCase();
  const windowsDevice = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
  if (!name || name.length > 160 || CONTROL.test(name) || name === "." || name === ".." || /[\\/:*?"<>|]/.test(name) ||
    name.endsWith(".") || name.endsWith(" ") || lower === "_ltds" || lower === ".previews" || lower === "dump" || windowsDevice) {
    throw new HTTPException(400, { message: "Display name is invalid" });
  }
  return name;
}

export function normalizeAliasKey(value: string): string {
  const clean = value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const parts = clean.replace(/\/$/, "").split("/");
  if (!clean || parts.some(part => !part || part === "." || part === ".." || part.toLowerCase() === "dump" || part.toLowerCase() === "_ltds" || part.toLowerCase() === ".previews")) throw new HTTPException(400, { message: "Physical key is invalid" });
  return clean.endsWith("/") ? `${clean.replace(/\/+$/, "")}/` : clean;
}

export async function resolveAliasKey(env: Env, value: string): Promise<string> {
  const key = normalizeAliasKey(value).replace(/\/$/, "");
  const head=await env.DATA_BUCKET.head(key);
  if (head&&!isMovedSourceMarker(head)) return key;
  const folder = `${key}/`;
  let cursor:string|undefined;
  do{
    const listed=await env.DATA_BUCKET.list({prefix:folder,limit:1000,cursor,include:["customMetadata"]});
    if(listed.objects.some(object=>!isMovedSourceMarker(object))||listed.delimitedPrefixes.length)return folder;
    cursor=listed.truncated?listed.cursor:undefined;
  }while(cursor);
  throw new HTTPException(404, { message: "File or folder not found" });
}

export async function aliasMap(env: Env, keys: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(keys)]; const map = new Map<string, string>();
  if (!unique.length) return map;
  for (let offset = 0; offset < unique.length; offset += ALIAS_QUERY_BATCH) {
    const batch = unique.slice(offset, offset + ALIAS_QUERY_BATCH);
    const rows = await env.DELIVERY_DB.prepare(`SELECT physical_key,display_name FROM file_aliases WHERE physical_key IN (${batch.map(() => "?").join(",")})`).bind(...batch).all<{ physical_key: string; display_name: string }>();
    for (const row of rows.results) map.set(row.physical_key, row.display_name);
  }
  return map;
}

export async function upsertAlias(env: Env, principal: StaffPrincipal, keyValue: string, displayValue: unknown): Promise<AliasRow> {
  const key = await resolveAliasKey(env, keyValue); const displayName = validateDisplayName(displayValue); const parentKey = aliasParent(key);
  const siblings = await env.DATA_BUCKET.list({ prefix: parentKey, delimiter: "/", limit: 1000 });
  const siblingNames = [
    ...siblings.delimitedPrefixes.map((value) => value.slice(parentKey.length).replace(/\/$/, "")),
    ...siblings.objects.filter((object) => object.key !== parentKey && !object.key.endsWith("/")).map((object) => object.key.slice(parentKey.length)),
  ];
  const physicalName = key.replace(/\/$/, "").slice(parentKey.length);
  if (siblingNames.some((name) => name !== physicalName && name.localeCompare(displayName, undefined, { sensitivity: "accent" }) === 0)) {
    throw new HTTPException(409, { message: "Another file or folder already uses that display name" });
  }
  try {
    await env.DELIVERY_DB.prepare(`INSERT INTO file_aliases(physical_key,parent_key,display_name,created_by,updated_by) VALUES(?,?,?,?,?)
      ON CONFLICT(physical_key) DO UPDATE SET parent_key=excluded.parent_key,display_name=excluded.display_name,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .bind(key, parentKey, displayName, principal.id, principal.id).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new HTTPException(409, { message: "Another file or folder already uses that display name" });
    throw error;
  }
  return { physical_key: key, parent_key: parentKey, display_name: displayName };
}

export async function deleteAlias(env: Env, keyValue: string): Promise<void> {
  const key = normalizeAliasKey(keyValue);
  if (key.endsWith("/")) await env.DELIVERY_DB.prepare("DELETE FROM file_aliases WHERE physical_key=? OR physical_key LIKE ? ESCAPE '\\'").bind(key, `${key.replace(/([%_\\])/g, "\\$1")}%`).run();
  else await env.DELIVERY_DB.prepare("DELETE FROM file_aliases WHERE physical_key=?").bind(key).run();
}
