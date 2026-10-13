import type { Env } from "./types";

const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;

export type ProjectAlphaDirectoryReadAdoptionCandidate = Readonly<{
  source: Readonly<{
    sourceId: string;
    sourceInstanceId: string;
    applicationId: string;
    historyEpoch: string;
  }>;
  resourceType: "client" | "organization";
  projectAlphaPublicId: string;
  resourceRevision: string;
  authorizationGeneration: string;
  binding: Readonly<{
    externalId: string;
    status: "active";
    resourceRevision: string;
  }>;
  conflictState: "clear";
}>;

export type ProjectAlphaDirectoryReadAdoptionCandidatePage = Readonly<{
  items: readonly ProjectAlphaDirectoryReadAdoptionCandidate[];
  nextCursor: string | null;
}>;

type CandidateCursor = Readonly<{
  sourceId: string;
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  resourceType: "client" | "organization";
  projectAlphaPublicId: string;
}>;

type CandidateRow = Readonly<{
  sourceId: string;
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  resourceType: "client" | "organization";
  projectAlphaPublicId: string;
  resourceRevision: string;
  authorizationGeneration: string;
  bindingExternalId: string;
  bindingStatus: "active";
  bindingResourceRevision: string;
}>;

function encodeCursor(row: CandidateCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify({
    s: row.sourceId,
    i: row.sourceInstanceId,
    a: row.applicationId,
    h: row.historyEpoch,
    t: row.resourceType,
    p: row.projectAlphaPublicId,
  }));
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(value: string | undefined): CandidateCursor | null | undefined {
  if (value === undefined) return null;
  if (value.length < 1 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const object = parsed as Record<string, unknown>;
    if (Reflect.ownKeys(object).length !== 6
      || typeof object.s !== "string" || !SOURCE_ID.test(object.s)
      || typeof object.i !== "string" || !UUID.test(object.i)
      || typeof object.a !== "string" || !UUID.test(object.a)
      || typeof object.h !== "string" || !UUID.test(object.h)
      || (object.t !== "client" && object.t !== "organization")
      || typeof object.p !== "string" || !PUBLIC_ID.test(object.p)) return undefined;
    return { sourceId: object.s, sourceInstanceId: object.i, applicationId: object.a, historyEpoch: object.h,
      resourceType: object.t, projectAlphaPublicId: object.p };
  } catch { return undefined; }
}

/**
 * Lists only conflict-free, active-bound observations that remain eligible for
 * an explicit exact-pair review. This is a bounded evidence read: it does not
 * inspect profile fields, infer a local match, reserve a claim, or write state.
 */
export async function listProjectAlphaDirectoryReadAdoptionCandidates(
  env: Pick<Env, "OPS_DB">,
  input: Readonly<{ sourceId: string; limit: number; cursor?: string }>,
): Promise<ProjectAlphaDirectoryReadAdoptionCandidatePage | null> {
  const cursor = decodeCursor(input.cursor);
  if (!SOURCE_ID.test(input.sourceId) || !Number.isSafeInteger(input.limit)
    || input.limit < 1 || input.limit > 100 || cursor === undefined
    || (cursor !== null && cursor.sourceId !== input.sourceId)) return null;

  const rows = await env.OPS_DB.withSession("first-primary").prepare(`SELECT
      observation.source_id sourceId,observation.source_instance_id sourceInstanceId,
      observation.application_id applicationId,observation.history_epoch_id historyEpoch,
      observation.resource_type resourceType,observation.project_alpha_public_id projectAlphaPublicId,
      observation.resource_revision resourceRevision,receipt.authorization_generation authorizationGeneration,
      observation.binding_external_id bindingExternalId,observation.binding_status bindingStatus,
      observation.binding_resource_revision bindingResourceRevision
    FROM project_alpha_api_v2_directory_observations_current observation
    JOIN project_alpha_api_v2_inventory_receipts receipt
      ON receipt.source_id=observation.source_id AND receipt.source_instance_id=observation.source_instance_id
     AND receipt.application_id=observation.application_id AND receipt.history_epoch_id=observation.history_epoch_id
     AND receipt.inventory_kind='directory' AND receipt.request_id=observation.request_id
    WHERE observation.source_id=? AND observation.present=1 AND observation.last_action='upsert'
      AND observation.binding_external_id IS NOT NULL AND observation.binding_status='active'
      AND observation.binding_resource_revision=observation.resource_revision AND observation.has_conflict=0
      AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
        WHERE conflict.source_id=observation.source_id AND conflict.inventory_kind='directory'
          AND (conflict.resource_type='source' OR (conflict.source_instance_id=observation.source_instance_id
            AND conflict.application_id=observation.application_id
            AND conflict.history_epoch_id=observation.history_epoch_id
            AND conflict.resource_type=observation.resource_type
            AND (conflict.project_alpha_public_id=observation.project_alpha_public_id
              OR conflict.external_id=observation.binding_external_id))))
      AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_mappings mapping
        WHERE mapping.source_id=observation.source_id AND mapping.source_instance_id=observation.source_instance_id
          AND mapping.application_id=observation.application_id AND mapping.resource_type=observation.resource_type
          AND (mapping.external_id=observation.binding_external_id
            OR mapping.project_alpha_public_id=observation.project_alpha_public_id))
      AND NOT EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings mapping
        WHERE mapping.source_id=observation.source_id AND mapping.source_instance_id=observation.source_instance_id
          AND mapping.application_id=observation.application_id AND mapping.resource_type=observation.resource_type
          AND (mapping.external_id=observation.binding_external_id
            OR mapping.project_alpha_public_id=observation.project_alpha_public_id))
      AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_reviews review
        WHERE review.source_id=observation.source_id AND review.source_instance_id=observation.source_instance_id
          AND review.application_id=observation.application_id AND review.resource_type=observation.resource_type
          AND (review.external_id=observation.binding_external_id
            OR review.project_alpha_public_id=observation.project_alpha_public_id))
      AND (? IS NULL OR (observation.source_instance_id,observation.application_id,observation.history_epoch_id,
        observation.resource_type,observation.project_alpha_public_id)>(?,?,?,?,?))
    ORDER BY observation.source_instance_id,observation.application_id,observation.history_epoch_id,
      observation.resource_type,observation.project_alpha_public_id LIMIT ?`)
    .bind(input.sourceId, cursor?.sourceInstanceId ?? null, cursor?.sourceInstanceId ?? "",
      cursor?.applicationId ?? "", cursor?.historyEpoch ?? "", cursor?.resourceType ?? "client",
      cursor?.projectAlphaPublicId ?? "", input.limit + 1).all<CandidateRow>();

  const selected = rows.results.slice(0, input.limit);
  const items = selected.map(row => Object.freeze({
    source: Object.freeze({ sourceId: row.sourceId, sourceInstanceId: row.sourceInstanceId,
      applicationId: row.applicationId, historyEpoch: row.historyEpoch }),
    resourceType: row.resourceType,
    projectAlphaPublicId: row.projectAlphaPublicId,
    resourceRevision: row.resourceRevision,
    authorizationGeneration: row.authorizationGeneration,
    binding: Object.freeze({ externalId: row.bindingExternalId, status: row.bindingStatus,
      resourceRevision: row.bindingResourceRevision }),
    conflictState: "clear" as const,
  }));
  const last = selected.at(-1);
  return Object.freeze({ items: Object.freeze(items),
    nextCursor: rows.results.length > input.limit && last ? encodeCursor(last) : null });
}
