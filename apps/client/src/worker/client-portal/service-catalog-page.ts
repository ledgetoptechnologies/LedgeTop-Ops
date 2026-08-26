import { z } from "zod";
import { base64Url, sha256 } from "../security";
import type { Env } from "../types";
import { mapServiceCatalogItem } from "./request-v2";
import type { ClientServiceCatalogPage, ClientServiceCatalogPageInput } from "./types";

export class ServiceCatalogPageError extends Error {
  constructor(readonly status: 400 | 409 | 503, readonly code: "catalog_cursor_invalid" | "catalog_changed" | "catalog_not_ready" | "catalog_unavailable") {
    super(code === "catalog_cursor_invalid" ? "The service library page is invalid."
      : code === "catalog_changed" ? "The service library changed. Refresh it before loading more."
        : code === "catalog_not_ready" ? "Versioned service library browsing is not ready."
          : "The service library is temporarily unavailable.");
  }
}

interface Checkpoint { active_generation_id: string; source_generation: string; source_sequence: number }
type CatalogRow = Parameters<typeof mapServiceCatalogItem>[0];
const cursorSchema = z.object({
  v: z.literal(1), proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  category: z.string().min(1).max(100), displayOrder: z.number().int().min(0).max(1_000_000),
  name: z.string().min(1).max(160), publicId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
}).strict();

function parseCursor(encoded: string | undefined): z.infer<typeof cursorSchema> | null {
  if (encoded === undefined) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(encoded)) throw new Error("encoding");
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - encoded.length % 4) % 4));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (base64Url(bytes) !== encoded) throw new Error("noncanonical");
    return cursorSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { throw new ServiceCatalogPageError(400, "catalog_cursor_invalid"); }
}

async function checkpoint(database: D1DatabaseSession): Promise<Checkpoint> {
  let row: Checkpoint | null;
  try {
    row = await database.prepare(`SELECT checkpoint.active_generation_id,checkpoint.source_generation,checkpoint.source_sequence
      FROM pa_service_catalog_checkpoint checkpoint
      JOIN pa_service_catalog_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.status='active' AND generation.complete=1 AND generation.source_generation=checkpoint.source_generation
      WHERE checkpoint.singleton=1 AND checkpoint.source_sequence>=generation.source_sequence`).first<Checkpoint>();
  } catch (error) {
    if (/no such table:\s*(?:main\.)?pa_service_catalog_(?:checkpoint|generations)\b/i.test(error instanceof Error ? error.message : String(error))) {
      throw new ServiceCatalogPageError(503, "catalog_not_ready");
    }
    throw error;
  }
  if (!row || !row.active_generation_id || !row.source_generation || !Number.isSafeInteger(row.source_sequence) || row.source_sequence < 1) {
    // The legacy table has no revision contract. Its compatibility endpoint is
    // retained, but a static synthetic checkpoint must not bless continuation.
    throw new ServiceCatalogPageError(503, "catalog_not_ready");
  }
  return row;
}

/** Global client-safe catalog, not a per-client service entitlement or price list. */
export async function listServiceCatalogPage(env: Env, input: ClientServiceCatalogPageInput = {}): Promise<ClientServiceCatalogPage> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ServiceCatalogPageError(400, "catalog_cursor_invalid");
  const cursor = parseCursor(input.cursor);
  const database = env.DELIVERY_DB.withSession("first-primary");
  const before = await checkpoint(database).catch(error => {
    if (cursor && error instanceof ServiceCatalogPageError && error.code === "catalog_not_ready") {
      throw new ServiceCatalogPageError(409, "catalog_changed");
    }
    throw error;
  });
  const proof = await sha256(JSON.stringify([env.PROJECT_ALPHA_CATALOG_APPLICATION_KEY ?? null, before]));
  if (cursor && cursor.proof !== proof) throw new ServiceCatalogPageError(409, "catalog_changed");
  const bindings: (string | number)[] = cursor ? [cursor.category, cursor.displayOrder, cursor.name, cursor.publicId] : [];
  const rows = await database.prepare(`SELECT public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json
    FROM pa_service_catalog_items WHERE active=1${cursor ? ` AND
      (category COLLATE NOCASE,display_order,name COLLATE NOCASE,public_id) > (? COLLATE NOCASE,?,? COLLATE NOCASE,?)` : ""}
    ORDER BY category COLLATE NOCASE,display_order,name COLLATE NOCASE,public_id LIMIT ?`)
    .bind(...bindings, limit + 1).all<CatalogRow>();
  const after = await checkpoint(database).catch(error => {
    if (error instanceof ServiceCatalogPageError && error.code === "catalog_not_ready") {
      throw new ServiceCatalogPageError(409, "catalog_changed");
    }
    throw error;
  });
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new ServiceCatalogPageError(409, "catalog_changed");
  const visibleRows = rows.results.slice(0, limit);
  const services = visibleRows.map(mapServiceCatalogItem);
  if (services.some(service => service === null)) throw new ServiceCatalogPageError(503, "catalog_unavailable");
  const last = visibleRows.at(-1);
  const hasMore = rows.results.length > limit;
  return {
    services: services as ClientServiceCatalogPage["services"], complete: !hasMore,
    nextCursor: hasMore && last ? base64Url(new TextEncoder().encode(JSON.stringify({
      v: 1, proof, category: last.category, displayOrder: last.display_order, name: last.name, publicId: last.public_id,
    }))) : null,
    source: { generation: before.source_generation, sequence: before.source_sequence },
  };
}
