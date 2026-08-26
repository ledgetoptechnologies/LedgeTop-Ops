import {
  aggregateDeliveryLocations,
  buildServiceRequestNotificationSnapshot,
  type DeliveryLocationCollection,
} from "@ltds/shared";
import { sha256 } from "../security";
import type { Env } from "../types";
import type {
  AuthorizedClientPortalFile,
  ClientDelivery,
  ClientFilePage,
  ClientPortalFile,
  ClientPortalInvitation,
  ClientPortalMember,
  ClientPortalNotification,
  ClientPortalRepository,
  ClientPortalSession,
  ClientProject,
  ClientServiceRequest,
  ClientServiceRequestInput,
  ClientServiceRequestType,
  VerifiedClientPrincipal,
} from "./types";
import {
  createServiceRequestDraft,
  getServiceRequestDraft,
  listServiceCatalog,
  listServiceRequestDrafts,
  saveServiceRequestDraft,
  submitServiceRequestDraft,
} from "./request-v2";
import { listAuthorizedAuthenticatedDeliveryPrefixes } from "./authenticated-delivery-grants";
import { listServiceCatalogPage } from "./service-catalog-page";

const CLIENT_FILE_PAGE_SIZE = 150;
const CLIENT_FILE_QUERY_LIMIT = CLIENT_FILE_PAGE_SIZE + 1;

interface ProjectRow {
  id: string;
  external_ref: string | null;
  client_name: string;
  project_name: string;
  can_request_service: number;
  status: string | null;
  summary: string | null;
  site_address: string | null;
  service_address: string | null;
  project_contact_name: string | null;
  project_contact_email: string | null;
  project_contact_phone: string | null;
  next_milestone: string | null;
  source_updated_at: string | null;
}

interface FileRow {
  r2_key: string;
  size: number;
  uploaded_at: string;
  content_type: string | null;
  media_kind: string;
  association_prefix: string;
}

interface FolderAssociationRow {
  id: string;
  r2_prefix: string;
}

interface FileEntryRow {
  entry_kind: "file" | "folder";
  entry_name: string;
  r2_key: string | null;
  size: number | null;
  uploaded_at: string | null;
  content_type: string | null;
  media_kind: string | null;
  association_prefix: string;
}

interface DeliveryRow {
  share_id: string;
  project_id: string;
  public_id: string;
  share_version: number;
  label: string | null;
  expires_at: string | null;
  requires_password: number;
}

interface LocationRow {
  source_key: string;
  latitude: number;
  longitude: number;
}

const LOCATION_MAP_LIMIT = 500;

interface ServiceRequestRow {
  id: string;
  project_id: string | null;
  parent_request_id: string | null;
  request_type: ClientServiceRequestType;
  title: string;
  details: string;
  location_text: string | null;
  preferred_start_at: string | null;
  service_category: string | null;
  deliverables_text: string | null;
  site_contact_name: string | null;
  site_contact_email: string | null;
  site_contact_phone: string | null;
  desired_completion_at: string | null;
  latitude: number | null;
  longitude: number | null;
  area_geojson: string | null;
  poi_points_json: string | null;
  work_area_revision_number: number | null;
  work_area_change_summary: string | null;
  work_area_updated_at: string | null;
  status: ClientServiceRequest["status"];
  created_at: string;
  updated_at: string;
  quote_document_number: string | null;
  quote_status: string | null;
  quote_total_minor: number | null;
  quote_currency: string | null;
  quote_verified_at: string | null;
  estimate_id: string | null;
  estimate_version: number | null;
  estimate_scope: string | null;
  estimate_amount_minor: number | null;
  estimate_currency: string | null;
  estimate_status: "draft" | "ready" | "accepted" | "change_requested" | null;
  estimate_proposed_fields_json: string | null;
  estimate_client_response_note: string | null;
  estimate_updated_at: string | null;
}

interface IdempotentServiceRequestRow extends ServiceRequestRow {
  request_fingerprint: string;
}

interface MemberRow {
  identity_id: string;
  email: string | null;
  role: ClientPortalMember["role"];
  can_view_billing: number;
}

interface InvitationRow {
  id: string;
  email: string;
  project_ids_json: string;
  expires_at: string;
}

function portalDb(env: Env): D1Database {
  const candidate = env.DELIVERY_DB as D1Database & {
    withSession?: (consistency: "first-primary") => D1Database;
  };
  return typeof candidate.withSession === "function"
    ? candidate.withSession("first-primary")
    : env.DELIVERY_DB;
}

function validPrincipalPart(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function mapProject(row: ProjectRow): ClientProject {
  return {
    id: row.id,
    externalRef: row.external_ref,
    clientName: row.client_name,
    projectName: row.project_name,
    canRequestService: row.can_request_service === 1,
    status: row.status,
    summary: row.summary,
    siteAddress: row.site_address,
    serviceAddress: row.service_address,
    projectContactName: row.project_contact_name,
    projectContactEmail: row.project_contact_email,
    projectContactPhone: row.project_contact_phone,
    nextMilestone: row.next_milestone,
    lastUpdateAt: row.source_updated_at,
  };
}

const FILE_HANDLE_PREFIX = "cf1_";
const PROJECT_FOLDER_HANDLE_PREFIX = "pf2_";
const PROJECT_CURSOR_HANDLE_PREFIX = "pc2_";
const PAST_DELIVERY_CURSOR_HANDLE_PREFIX = "pa1_";
const HANDLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HANDLE_CONTEXT = new TextEncoder().encode("ltds-client-portal-handle:v1");
const handleKeyCache = new WeakMap<object, Map<string, Promise<CryptoKey>>>();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function deliveryGrantPrefixes(env: Env, session: ClientPortalSession): Promise<Set<string> | null> {
  if (env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED !== "true") return session.workspaceId ? new Set() : null;
  if (!session.workspaceId || !session.principalIssuer || !session.principalSubject) return new Set();
  return listAuthorizedAuthenticatedDeliveryPrefixes(env, {
    issuer: session.principalIssuer,
    subject: session.principalSubject,
    email: "",
  }, session.workspaceId);
}

function prefixSqlFilter(prefixes: Set<string> | null, column: string): { sql: string; bindings: string[] } {
  if (prefixes === null) return { sql: "", bindings: [] };
  const values = [...prefixes];
  if (!values.length) return { sql: " AND 0", bindings: [] };
  return { sql: ` AND ${column} IN (${values.map(() => "?").join(",")})`, bindings: values };
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    // atob accepts aliases with non-zero trailing pad bits. Requiring the
    // canonical spelling keeps every authenticated ciphertext bound to one
    // opaque URL and prevents equivalent handles from bypassing equality,
    // replay, or cache-key checks elsewhere in the portal.
    return base64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function handleEncryptionKey(env: Env, secret: string, purpose: string, slot: "current" | "previous"): Promise<CryptoKey> {
  let keys = handleKeyCache.get(env as object);
  if (!keys) {
    keys = new Map();
    handleKeyCache.set(env as object, keys);
  }
  const cacheKey = `${purpose}:${slot}`;
  let key = keys.get(cacheKey);
  if (!key) {
    key = crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${purpose}\0${secret}`))
      .then(digest => crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]));
    keys.set(cacheKey, key);
  }
  return key;
}

async function encodeHandle(env: Env, prefix: string, purpose: string, values: string[]): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await handleEncryptionKey(env, env.DELIVERY_SESSION_SECRET, purpose, "current");
  const plaintext = new TextEncoder().encode(JSON.stringify(values));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: HANDLE_CONTEXT },
    key,
    plaintext,
  ));
  const payload = new Uint8Array(iv.length + encrypted.length);
  payload.set(iv);
  payload.set(encrypted, iv.length);
  return `${prefix}${base64Url(payload)}`;
}

async function decodeHandle(env: Env, value: string, prefix: string, purpose: string): Promise<string[] | null> {
  if (!value.startsWith(prefix) || value.length > 4096) return null;
  const payload = fromBase64Url(value.slice(prefix.length));
  if (!payload || payload.length <= 28) return null;
  const iv = payload.slice(0, 12);
  const encrypted = payload.slice(12);
  const secrets = [
    { secret: env.DELIVERY_SESSION_SECRET, slot: "current" as const },
    { secret: env.DELIVERY_PREVIOUS_SESSION_SECRET, slot: "previous" as const },
  ].filter((entry, index, all): entry is { secret: string; slot: "current" | "previous" } =>
    Boolean(entry.secret) && all.findIndex(candidate => candidate.secret === entry.secret) === index);
  for (const { secret, slot } of secrets) {
    try {
      const key = await handleEncryptionKey(env, secret, purpose, slot);
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: HANDLE_CONTEXT },
        key,
        encrypted,
      );
      const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) return parsed;
    } catch {
      // Try the previous session secret during an intentional rotation.
    }
  }
  return null;
}

async function encodeFileId(env: Env, key: string): Promise<string> {
  return encodeHandle(env, FILE_HANDLE_PREFIX, "file", [key]);
}

/** Internal contract-test helper. The returned value is authenticated and
 * encrypted; it never exposes the storage key to a browser. */
export function createClientPortalFileHandle(env: Env, key: string): Promise<string> {
  return encodeFileId(env, key);
}

async function decodeFileId(env: Env, value: string): Promise<string | null> {
  const values = await decodeHandle(env, value, FILE_HANDLE_PREFIX, "file");
  const key = values?.length === 1 ? values[0]! : "";
  return key.length > 0 && key.length <= 1000 && !key.startsWith("/") && !key.includes("\\") && !/[\u0000-\u001f\u007f]/.test(key)
    ? key
    : null;
}

function validRelativeFolderPath(value: string): boolean {
  if (value === "") return true;
  if (value.length > 2048 || !value.endsWith("/") || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const segments = value.slice(0, -1).split("/");
  return segments.every(segment => segment.length > 0 && segment.length <= 255 && segment !== "." && segment !== "..");
}

function encodeProjectFolderHandle(env: Env, associationId: string, relativePath: string): Promise<string> {
  return encodeHandle(env, PROJECT_FOLDER_HANDLE_PREFIX, "project-folder", [associationId, relativePath]);
}

async function decodeProjectFolderHandle(env: Env, value: string): Promise<{ associationId: string; relativePath: string } | null> {
  const values = await decodeHandle(env, value, PROJECT_FOLDER_HANDLE_PREFIX, "project-folder");
  return values?.length === 2 && HANDLE_ID.test(values[0]!) && validRelativeFolderPath(values[1]!)
    ? { associationId: values[0]!, relativePath: values[1]! }
    : null;
}

type ProjectCursor =
  | { kind: "root"; associationId: string }
  | { kind: "folder"; associationId: string; relativePath: string; name: string; entryKind: "file" | "folder" };

function encodeProjectCursor(env: Env, cursor: ProjectCursor): Promise<string> {
  return cursor.kind === "root"
    ? encodeHandle(env, PROJECT_CURSOR_HANDLE_PREFIX, "project-cursor", ["root", cursor.associationId])
    : encodeHandle(env, PROJECT_CURSOR_HANDLE_PREFIX, "project-cursor", ["folder", cursor.associationId, cursor.relativePath, cursor.name, cursor.entryKind]);
}

async function decodeProjectCursor(env: Env, value: string | null | undefined): Promise<ProjectCursor | null> {
  if (!value) return null;
  const values = await decodeHandle(env, value, PROJECT_CURSOR_HANDLE_PREFIX, "project-cursor");
  if (values?.length === 2 && values[0] === "root" && HANDLE_ID.test(values[1]!))
    return { kind: "root", associationId: values[1]! };
  if (values?.length === 5 && values[0] === "folder" && HANDLE_ID.test(values[1]!)
    && validRelativeFolderPath(values[2]!) && values[3]!.length > 0 && values[3]!.length <= 1024
    && !/[\u0000-\u001f\u007f]/.test(values[3]!) && (values[4] === "file" || values[4] === "folder")) {
    return { kind: "folder", associationId: values[1]!, relativePath: values[2]!, name: values[3]!, entryKind: values[4] };
  }
  return null;
}

function prefixUpperBound(prefix: string): string {
  return `${prefix.slice(0, -1)}0`;
}

function associationName(prefix: string): string {
  return fileName(prefix.replace(/\/+$/, "")) || "Project files";
}

async function projectBreadcrumbs(env: Env, association: FolderAssociationRow, relativePath: string) {
  const breadcrumbs: Array<{ id: string | null; name: string }> = [{ id: null, name: "Project files" }];
  breadcrumbs.push({ id: await encodeProjectFolderHandle(env, association.id, ""), name: associationName(association.r2_prefix) });
  let path = "";
  for (const segment of relativePath.split("/").filter(Boolean)) {
    path += `${segment}/`;
    breadcrumbs.push({ id: await encodeProjectFolderHandle(env, association.id, path), name: segment });
  }
  return breadcrumbs;
}

function fileName(key: string): string {
  return key.split("/").filter(Boolean).pop() || key;
}

function mapFile(row: FileRow, projectId: string | null, id: string): ClientPortalFile {
  const base = `/api/client/files/${encodeURIComponent(id)}`;
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const kind = ["image", "video", "audio", "pdf", "text"].includes(row.media_kind)
    ? row.media_kind as ClientPortalFile["kind"]
    : "other";
  return {
    id,
    name: fileName(row.r2_key),
    size: row.size,
    uploadedAt: row.uploaded_at,
    contentType: row.content_type,
    kind,
    previewPath: kind !== "other"
      ? `${base}/preview${query}`
      : null,
    thumbnailPath: ["image", "pdf", "video"].includes(kind)
      ? `${base}/thumbnail${query}`
      : null,
    downloadPath: `${base}/download${query}`,
  };
}

function mapDelivery(row: DeliveryRow): ClientDelivery {
  return {
    shareId: row.share_id,
    publicId: row.public_id,
    shareVersion: row.share_version,
    label: row.label,
    expiresAt: row.expires_at,
    requiresPassword: row.requires_password === 1,
    handoffPath: `/api/client/projects/${encodeURIComponent(row.project_id ?? "")}/deliveries/${encodeURIComponent(row.share_id)}/handoff`,
  };
}

function mapServiceRequest(
  row: ServiceRequestRow,
  includeBilling: boolean,
): ClientServiceRequest {
  let areaGeoJson: ClientServiceRequest["areaGeoJson"] = null;
  if (row.area_geojson) {
    try {
      const parsed = JSON.parse(row.area_geojson) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as { type?: unknown }).type === "Polygon"
      )
        areaGeoJson = parsed as ClientServiceRequest["areaGeoJson"];
    } catch {
      /* legacy malformed data stays unavailable */
    }
  }
  let poiPoints: ClientServiceRequest["poiPoints"] = [];
  if (row.poi_points_json) {
    try {
      const parsed = JSON.parse(
        row.poi_points_json,
      ) as ClientServiceRequest["poiPoints"];
      if (Array.isArray(parsed)) poiPoints = parsed;
    } catch {
      /* malformed legacy data stays unavailable */
    }
  }
  let proposedFields: Record<string, unknown> | null = null;
  if (row.estimate_proposed_fields_json) {
    try {
      const parsed = JSON.parse(row.estimate_proposed_fields_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        proposedFields = parsed as Record<string, unknown>;
    } catch {
      /* malformed proposal data is not exposed */
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    parentRequestId: row.parent_request_id,
    requestType: row.request_type,
    title: row.title,
    details: row.details,
    location: row.location_text,
    preferredStartAt: row.preferred_start_at,
    serviceCategory: row.service_category ?? null,
    deliverables: row.deliverables_text ?? null,
    siteContactName: row.site_contact_name ?? null,
    siteContactEmail: row.site_contact_email ?? null,
    siteContactPhone: row.site_contact_phone ?? null,
    desiredCompletionAt: row.desired_completion_at ?? null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    areaGeoJson,
    poiPoints,
    ...(row.work_area_revision_number == null
      ? {}
      : { workAreaRevision: {
            revisionNumber: row.work_area_revision_number,
            changeSummary: row.work_area_change_summary!,
            updatedAt: row.work_area_updated_at!,
          } }),
    status: row.status,
    acceptedQuote:
      includeBilling && row.quote_status
        ? {
            documentNumber: row.quote_document_number,
            status: row.quote_status,
            total:
              row.quote_total_minor === null
                ? null
                : row.quote_total_minor / 100,
            currency: row.quote_currency,
            verifiedAt: row.quote_verified_at!,
          }
        : null,
    operationalEstimate:
      row.estimate_id && row.estimate_status
        ? {
            id: row.estimate_id,
            version: row.estimate_version!,
            scope: row.estimate_scope!,
            amount:
              row.estimate_amount_minor === null
                ? null
                : row.estimate_amount_minor / 100,
            currency: row.estimate_currency,
            status: row.estimate_status,
            proposedFields,
            clientResponseNote: row.estimate_client_response_note,
            updatedAt: row.estimate_updated_at!,
          }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMember(row: MemberRow): ClientPortalMember {
  return {
    identityId: row.identity_id,
    email: row.email,
    role: row.role,
    canViewBilling: row.can_view_billing === 1,
  };
}

function mapInvitation(row: InvitationRow): ClientPortalInvitation {
  let projectIds: string[] = [];
  try {
    const parsed = JSON.parse(row.project_ids_json) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (value) =>
          typeof value === "string" && value.length > 0 && value.length <= 128,
      )
    )
      projectIds = parsed;
  } catch {
    /* a malformed legacy row must not expand access */
  }
  return {
    id: row.id,
    email: row.email,
    projectIds,
    expiresAt: row.expires_at,
  };
}

const sessionJoin = `
  JOIN client_accounts a ON a.id=? AND a.status='active'
  JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
  JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL`;

const memberProjectConstraint = `
  AND (m.role='manager' OR EXISTS (
    SELECT 1 FROM client_member_project_grants member_grant
    WHERE member_grant.account_id=a.id AND member_grant.identity_id=i.id
      AND member_grant.project_id=g.project_id AND member_grant.revoked_at IS NULL
  ))`;

const baseServiceRequestColumns = `r.id,r.project_id,r.parent_request_id,r.request_type,r.title,r.details,r.location_text,r.preferred_start_at,
   r.service_category,r.deliverables_text,r.site_contact_name,r.site_contact_email,r.site_contact_phone,
   r.desired_completion_at,r.latitude,r.longitude`;

const currentServiceRequestColumns = `${baseServiceRequestColumns},
   CASE WHEN effective_area.id IS NULL THEN r.area_geojson ELSE effective_area.area_geojson END area_geojson,
   CASE WHEN effective_area.id IS NULL THEN r.poi_points_json ELSE effective_area.poi_points_json END poi_points_json,
   effective_area.revision_number work_area_revision_number,
   effective_area.change_summary work_area_change_summary,effective_area.created_at work_area_updated_at,
   r.status,r.created_at,r.updated_at,
   quote.document_number quote_document_number,quote.artifact_status quote_status,
   quote.total_minor quote_total_minor,quote.currency quote_currency,quote.verified_at quote_verified_at,
   estimate.id estimate_id,estimate.version estimate_version,estimate.scope_text estimate_scope,
   estimate.estimate_amount_minor,estimate.currency estimate_currency,estimate.status estimate_status,
   estimate.proposed_fields_json estimate_proposed_fields_json,estimate.client_response_note estimate_client_response_note,
   estimate.updated_at estimate_updated_at`;

const legacyServiceRequestColumns = `${baseServiceRequestColumns},
   r.area_geojson,r.poi_points_json,
   NULL work_area_revision_number,NULL work_area_change_summary,NULL work_area_updated_at,
   r.status,r.created_at,r.updated_at,
   quote.document_number quote_document_number,quote.artifact_status quote_status,
   quote.total_minor quote_total_minor,quote.currency quote_currency,quote.verified_at quote_verified_at,
   estimate.id estimate_id,estimate.version estimate_version,estimate.scope_text estimate_scope,
   estimate.estimate_amount_minor,estimate.currency estimate_currency,estimate.status estimate_status,
   estimate.proposed_fields_json estimate_proposed_fields_json,estimate.client_response_note estimate_client_response_note,
   estimate.updated_at estimate_updated_at`;

const currentAcceptedQuoteJoin = `LEFT JOIN request_pa_artifacts quote ON quote.request_id=r.id
  AND quote.artifact_type='quote' AND quote.superseded_at IS NULL AND quote.scope_stale_at IS NULL
  AND quote.artifact_status IN ('approved','accepted')`;

const legacyAcceptedQuoteJoin = `LEFT JOIN request_pa_artifacts quote ON quote.request_id=r.id
  AND quote.artifact_type='quote' AND quote.superseded_at IS NULL
  AND quote.artifact_status IN ('approved','accepted')`;

const effectiveAreaJoin = `LEFT JOIN client_service_request_area_revisions effective_area ON effective_area.request_id=r.id
  AND effective_area.revision_number=(SELECT MAX(area_revision.revision_number)
    FROM client_service_request_area_revisions area_revision WHERE area_revision.request_id=r.id)`;

const operationalEstimateJoin = `LEFT JOIN request_operational_estimates estimate ON estimate.request_id=r.id
  AND estimate.status IN ('ready','accepted','change_requested')`;

function missingStaffWorkAreaSchema(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*client_service_request_area_revisions\b/i.test(message) ||
    /no such column:\s*(?:quote\.)?scope_stale_at\b/i.test(message);
}

function serviceRequestReadSql(legacy: boolean): {
  columns: string;
  quoteJoin: string;
  areaJoin: string;
} {
  return legacy
    ? {
        columns: legacyServiceRequestColumns,
        quoteJoin: legacyAcceptedQuoteJoin,
        areaJoin: "",
      }
    : {
        columns: currentServiceRequestColumns,
        quoteJoin: currentAcceptedQuoteJoin,
        areaJoin: effectiveAreaJoin,
      };
}

async function serviceRequestRead<T>(
  env: Env,
  run: (database: D1Database, sql: ReturnType<typeof serviceRequestReadSql>) => Promise<T>,
): Promise<T> {
  const database = portalDb(env);
  try {
    return await run(database, serviceRequestReadSql(false));
  } catch (error) {
    if (!missingStaffWorkAreaSchema(error)) throw error;
    return run(database, serviceRequestReadSql(true));
  }
}

const requestAccessConstraint = `AND (
  (r.project_id IS NULL AND (m.role='manager' OR r.created_by_identity_id=i.id)) OR
  (r.project_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM client_project_grants request_grant
    JOIN projects request_project ON request_project.id=request_grant.project_id AND request_project.active=1
    WHERE request_grant.account_id=a.id AND request_grant.project_id=r.project_id AND request_grant.revoked_at IS NULL
      AND (m.role='manager' OR EXISTS (
        SELECT 1 FROM client_member_project_grants request_member_grant
        WHERE request_member_grant.account_id=a.id AND request_member_grant.identity_id=i.id
          AND request_member_grant.project_id=r.project_id AND request_member_grant.revoked_at IS NULL
      ))
  ))
)`;

async function serviceRequestFingerprint(
  input: ClientServiceRequestInput,
): Promise<string> {
  const legacyFields = [
    input.projectId,
    input.requestType,
    input.title,
    input.details,
    input.location,
    input.preferredStartAt,
  ];
  // Keep an exact retry of a pre-0101 request replayable. New scope details
  // become part of the identity only when the caller actually supplies one.
  const scope = [
    input.parentRequestId,
    input.serviceCategory,
    input.deliverables,
    input.siteContactName,
    input.siteContactEmail,
    input.siteContactPhone,
    input.desiredCompletionAt,
    input.latitude,
    input.longitude,
    input.areaGeoJson,
    input.poiPoints?.length ? input.poiPoints : null,
  ].map((value) => value ?? null);
  return sha256(
    JSON.stringify(
      scope.every((value) => value === null)
        ? legacyFields
        : [...legacyFields, ...scope],
    ),
  );
}

function serviceRequestSnapshot(
  input: ClientServiceRequestInput,
  status = "submitted",
): string {
  return JSON.stringify({
    requestType: input.requestType,
    title: input.title,
    details: input.details,
    location: input.location,
    preferredStartAt: input.preferredStartAt,
    serviceCategory: input.serviceCategory ?? null,
    deliverables: input.deliverables ?? null,
    siteContactName: input.siteContactName ?? null,
    siteContactEmail: input.siteContactEmail ?? null,
    siteContactPhone: input.siteContactPhone ?? null,
    desiredCompletionAt: input.desiredCompletionAt ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    areaGeoJson: input.areaGeoJson ?? null,
    poiPoints: input.poiPoints ?? [],
    status,
  });
}

async function getServiceRequestByIdempotency(
  env: Env,
  session: ClientPortalSession,
  idempotency: string,
): Promise<IdempotentServiceRequestRow | null> {
  return serviceRequestRead(env, (database, sql) => database.prepare(`
    SELECT ${sql.columns},r.request_fingerprint
    FROM client_service_requests r
    ${sessionJoin}
    ${sql.quoteJoin}
    ${operationalEstimateJoin}
    ${sql.areaJoin}
    WHERE r.idempotency_key=? AND r.account_id=a.id ${requestAccessConstraint}`)
    .bind(session.accountId, session.identityId, idempotency)
    .first<IdempotentServiceRequestRow>());
}

export const d1ClientPortalRepository: ClientPortalRepository = {
  async listServiceCatalog(env) {
    return listServiceCatalog(env);
  },

  async listServiceCatalogPage(env, _session, input) {
    return listServiceCatalogPage(env, input);
  },

  async getServiceRequestDraft(env, session, draftId) {
    return getServiceRequestDraft(env, session, draftId);
  },

  async listServiceRequestDrafts(env, session) {
    return listServiceRequestDrafts(env, session);
  },

  async createServiceRequestDraft(env, session, input, mutationKey) {
    return createServiceRequestDraft(env, session, input, mutationKey);
  },

  async saveServiceRequestDraft(env, session, draftId, expectedVersion, input, mutationKey) {
    return saveServiceRequestDraft(env, session, draftId, expectedVersion, input, mutationKey);
  },

  async submitServiceRequestDraft(env, session, draftId, expectedVersion, mutationKey) {
    return submitServiceRequestDraft(env, session, draftId, expectedVersion, mutationKey);
  },

  async resolveSession(
    env: Env,
    principal: VerifiedClientPrincipal,
  ): Promise<ClientPortalSession | null> {
    if (
      !validPrincipalPart(principal.issuer) ||
      !validPrincipalPart(principal.subject)
    )
      return null;
    const row = await portalDb(env)
      .prepare(
        `
      SELECT a.id AS account_id,i.id AS identity_id,a.display_name,m.role,m.can_view_billing
      FROM client_identity_links i
      JOIN client_accounts a ON a.id=i.account_id
      JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
      WHERE i.issuer=? AND i.subject=? AND i.revoked_at IS NULL AND a.status='active'`,
      )
      .bind(principal.issuer, principal.subject)
      .first<{
        account_id: string;
        identity_id: string;
        display_name: string;
        role: ClientPortalSession["role"];
        can_view_billing: number;
      }>();
    return row
      ? {
          accountId: row.account_id,
          identityId: row.identity_id,
          principalIssuer: principal.issuer,
          principalSubject: principal.subject,
          displayName: row.display_name,
          role: row.role,
          canViewBilling: row.can_view_billing === 1,
        }
      : null;
  },

  async listProjects(
    env: Env,
    session: ClientPortalSession,
  ): Promise<ClientProject[]> {
    const result = await portalDb(env)
      .prepare(
        `
      SELECT p.id,p.external_ref,p.client_name,p.project_name,g.can_request_service,p.status,p.summary,
        p.site_address,p.service_address,p.project_contact_name,p.project_contact_email,
        p.project_contact_phone,p.next_milestone,p.source_updated_at
      FROM client_project_grants g
      ${sessionJoin}
      JOIN projects p ON p.id=g.project_id AND p.active=1
      WHERE g.account_id=a.id AND g.revoked_at IS NULL ${memberProjectConstraint}
      ORDER BY p.client_name COLLATE NOCASE,p.project_name COLLATE NOCASE,p.id`,
      )
      .bind(session.accountId, session.identityId)
      .all<ProjectRow>();
    return result.results.map(mapProject);
  },

  async getProject(
    env: Env,
    session: ClientPortalSession,
    projectId: string,
  ): Promise<ClientProject | null> {
    const row = await portalDb(env)
      .prepare(
        `
      SELECT p.id,p.external_ref,p.client_name,p.project_name,g.can_request_service,p.status,p.summary,
        p.site_address,p.service_address,p.project_contact_name,p.project_contact_email,
        p.project_contact_phone,p.next_milestone,p.source_updated_at
      FROM client_project_grants g
      ${sessionJoin}
      JOIN projects p ON p.id=g.project_id AND p.active=1
      WHERE g.account_id=a.id AND g.project_id=? AND g.revoked_at IS NULL ${memberProjectConstraint}`,
      )
      .bind(session.accountId, session.identityId, projectId)
      .first<ProjectRow>();
    return row ? mapProject(row) : null;
  },

  async listProjectFiles(
    env: Env,
    session: ClientPortalSession,
    projectId: string,
    cursor?: string | null,
    folderId?: string | null,
  ): Promise<ClientFilePage | null> {
    const project = await this.getProject(env, session, projectId);
    if (!project) return null;
    const grantPrefixes = await deliveryGrantPrefixes(env, session);
    const associationGrantFilter = prefixSqlFilter(grantPrefixes, "association.r2_prefix");
    let folder = folderId ? await decodeProjectFolderHandle(env, folderId) : null;
    let resolvedAssociation: FolderAssociationRow | null = null;
    if (folderId && !folder) return null;
    const decodedCursor = await decodeProjectCursor(env, cursor);
    if (cursor && !decodedCursor) return null;

    if (!folder) {
      if (decodedCursor && decodedCursor.kind !== "root") return null;
      const result = await portalDb(env).prepare(`
        SELECT association.id,association.r2_prefix
        FROM client_folder_associations association
        ${sessionJoin}
        JOIN client_project_grants g ON g.account_id=a.id AND g.project_id=association.project_id AND g.revoked_at IS NULL
        JOIN projects p ON p.id=g.project_id AND p.active=1
        WHERE association.account_id=a.id AND association.scope_type='project' AND association.project_id=?
          AND association.revoked_at IS NULL AND association.id>? ${memberProjectConstraint}
          ${associationGrantFilter.sql}
        ORDER BY association.id LIMIT ${CLIENT_FILE_QUERY_LIMIT}`)
        .bind(session.accountId, session.identityId, projectId, decodedCursor?.kind === "root" ? decodedCursor.associationId : "",
          ...associationGrantFilter.bindings)
        .all<FolderAssociationRow>();
      if (!decodedCursor && result.results.length === 1) {
        resolvedAssociation = result.results[0]!;
        folder = { associationId: resolvedAssociation.id, relativePath: "" };
        folderId = await encodeProjectFolderHandle(env, resolvedAssociation.id, "");
      } else {
        const page = result.results.slice(0, CLIENT_FILE_PAGE_SIZE);
        return {
          files: [],
          folders: await Promise.all(page.map(async association => ({
            id: await encodeProjectFolderHandle(env, association.id, ""),
            name: associationName(association.r2_prefix),
          }))),
          breadcrumbs: [{ id: null, name: "Project files" }],
          folderId: null,
          prefix: "",
          cursor: result.results.length > CLIENT_FILE_PAGE_SIZE
            ? await encodeProjectCursor(env, { kind: "root", associationId: page.at(-1)!.id })
            : null,
        };
      }
    }

    if (!folder) return null;
    if (decodedCursor && (decodedCursor.kind !== "folder"
      || decodedCursor.associationId !== folder.associationId
      || decodedCursor.relativePath !== folder.relativePath)) return null;
    const association = resolvedAssociation ?? await portalDb(env).prepare(`
      SELECT association.id,association.r2_prefix
      FROM client_folder_associations association
      ${sessionJoin}
      JOIN client_project_grants g ON g.account_id=a.id AND g.project_id=association.project_id AND g.revoked_at IS NULL
      JOIN projects p ON p.id=g.project_id AND p.active=1
      WHERE association.id=? AND association.account_id=a.id AND association.scope_type='project'
        AND association.project_id=? AND association.revoked_at IS NULL ${memberProjectConstraint}
        ${associationGrantFilter.sql}
      LIMIT 1`)
      .bind(session.accountId, session.identityId, folder.associationId, projectId,
        ...associationGrantFilter.bindings)
      .first<FolderAssociationRow>();
    if (!association) return null;

    const targetPrefix = `${association.r2_prefix}${folder.relativePath}`;
    const cursorName = decodedCursor?.kind === "folder" ? decodedCursor.name : "";
    const cursorKind = decodedCursor?.kind === "folder" ? decodedCursor.entryKind : "";
    const result = await portalDb(env).prepare(`
      WITH candidates AS (
        SELECT f.r2_key,f.size,f.uploaded_at,f.content_type,f.media_kind,
          substr(f.r2_key,?) relative_key
        FROM file_index f
        WHERE f.r2_key>=? AND f.r2_key<?
          AND f.r2_key NOT LIKE '_ltds/%' AND f.r2_key NOT LIKE '%/_ltds/%'
          AND f.r2_key NOT LIKE '.previews/%' AND f.r2_key NOT LIKE '%/.previews/%'
          AND f.r2_key NOT LIKE 'dump/%' AND f.r2_key NOT LIKE '%/dump/%'
          AND NOT EXISTS (
            SELECT 1 FROM delivery_tombstones tombstone
            WHERE tombstone.restored_at IS NULL
              AND (tombstone.physical_key=f.r2_key OR
                (tombstone.tombstone_kind='prefix' AND substr(f.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key))
          )
      ), entries AS (
        SELECT 'folder' entry_kind,
          substr(relative_key,1,instr(relative_key,'/')-1) entry_name,
          NULL r2_key,NULL size,NULL uploaded_at,NULL content_type,NULL media_kind
        FROM candidates WHERE instr(relative_key,'/')>0
        GROUP BY substr(relative_key,1,instr(relative_key,'/')-1)
        UNION ALL
        SELECT 'file' entry_kind,relative_key entry_name,r2_key,size,uploaded_at,content_type,media_kind
        FROM candidates WHERE relative_key<>'' AND instr(relative_key,'/')=0
      )
      SELECT entry_kind,entry_name,r2_key,size,uploaded_at,content_type,media_kind,? association_prefix
      FROM entries
      WHERE lower(entry_name)>lower(?)
        OR (lower(entry_name)=lower(?) AND entry_name>?)
        OR (lower(entry_name)=lower(?) AND entry_name=? AND entry_kind>?)
      ORDER BY lower(entry_name),entry_name,entry_kind LIMIT ${CLIENT_FILE_QUERY_LIMIT}`)
      .bind(targetPrefix.length + 1, targetPrefix, prefixUpperBound(targetPrefix), association.r2_prefix,
        cursorName, cursorName, cursorName, cursorName, cursorName, cursorKind)
      .all<FileEntryRow>();
    const page = result.results.slice(0, CLIENT_FILE_PAGE_SIZE);
    const files = await Promise.all(page.filter((row): row is FileEntryRow & { entry_kind: "file"; r2_key: string; size: number; uploaded_at: string; media_kind: string } =>
      row.entry_kind === "file" && row.r2_key !== null && row.size !== null && row.uploaded_at !== null && row.media_kind !== null)
      .map(async row => mapFile({
        r2_key: row.r2_key,
        size: row.size,
        uploaded_at: row.uploaded_at,
        content_type: row.content_type,
        media_kind: row.media_kind,
        association_prefix: row.association_prefix,
      }, projectId, await encodeFileId(env, row.r2_key))));
    const folders = await Promise.all(page.filter(row => row.entry_kind === "folder").map(async row => ({
      id: await encodeProjectFolderHandle(env, association.id, `${folder.relativePath}${row.entry_name}/`),
      name: row.entry_name,
    })));
    const last = page.at(-1);
    return {
      files,
      folders,
      breadcrumbs: await projectBreadcrumbs(env, association, folder.relativePath),
      folderId,
      prefix: "",
      cursor: result.results.length > CLIENT_FILE_PAGE_SIZE && last
        ? await encodeProjectCursor(env, {
            kind: "folder",
            associationId: association.id,
            relativePath: folder.relativePath,
            name: last.entry_name,
            entryKind: last.entry_kind,
          })
        : null,
    };
  },

  async listPastDeliveries(
    env: Env,
    session: ClientPortalSession,
    cursor?: string | null,
  ): Promise<ClientFilePage> {
    const grantPrefixes = await deliveryGrantPrefixes(env, session);
    const associationGrantFilter = prefixSqlFilter(grantPrefixes, "association.r2_prefix");
    const decodedCursor = cursor
      ? await decodeHandle(env, cursor, PAST_DELIVERY_CURSOR_HANDLE_PREFIX, "past-delivery-cursor")
      : null;
    if (cursor && (!decodedCursor || decodedCursor.length !== 1)) {
      return { files: [], prefix: "", cursor: null };
    }
    const cursorKey = decodedCursor?.[0] || "";
    const result = await portalDb(env)
      .prepare(
        `
      SELECT DISTINCT f.r2_key,f.size,f.uploaded_at,f.content_type,f.media_kind,association.r2_prefix association_prefix
      FROM client_folder_associations association
      ${sessionJoin}
      JOIN file_index f ON substr(f.r2_key,1,length(association.r2_prefix))=association.r2_prefix
      WHERE association.account_id=a.id AND association.scope_type='client' AND association.project_id IS NULL
        AND association.revoked_at IS NULL AND f.r2_key>?
        ${associationGrantFilter.sql}
        AND f.r2_key NOT LIKE '_ltds/%' AND f.r2_key NOT LIKE '%/_ltds/%'
        AND f.r2_key NOT LIKE '.previews/%' AND f.r2_key NOT LIKE '%/.previews/%'
        AND f.r2_key NOT LIKE 'dump/%' AND f.r2_key NOT LIKE '%/dump/%'
        AND NOT EXISTS (
          SELECT 1 FROM delivery_tombstones tombstone
          WHERE tombstone.restored_at IS NULL
            AND (tombstone.physical_key=f.r2_key OR
              (tombstone.tombstone_kind='prefix' AND substr(f.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key))
        )
      ORDER BY f.r2_key LIMIT ${CLIENT_FILE_QUERY_LIMIT}`,
      )
      .bind(session.accountId, session.identityId, cursorKey, ...associationGrantFilter.bindings)
      .all<FileRow>();
    const rows = result.results;
    const page = rows.slice(0, CLIENT_FILE_PAGE_SIZE);
    return {
      files: await Promise.all(page.map(async row => mapFile(row, null, await encodeFileId(env, row.r2_key)))),
      prefix: "",
      cursor: rows.length > CLIENT_FILE_PAGE_SIZE
        ? await encodeHandle(env, PAST_DELIVERY_CURSOR_HANDLE_PREFIX, "past-delivery-cursor", [page.at(-1)!.r2_key])
        : null,
    };
  },

  async listProjectFileLocations(
    env: Env,
    session: ClientPortalSession,
    projectId: string,
  ): Promise<DeliveryLocationCollection | null> {
    const project = await this.getProject(env, session, projectId);
    if (!project) return null;
    const grantPrefixes = await deliveryGrantPrefixes(env, session);
    const associationGrantFilter = prefixSqlFilter(grantPrefixes, "association.r2_prefix");
    const result = await portalDb(env).prepare(`
      SELECT DISTINCT location.source_key,location.latitude,location.longitude
      FROM client_folder_associations association
      ${sessionJoin}
      JOIN client_project_grants g
        ON g.account_id=a.id AND g.project_id=association.project_id AND g.revoked_at IS NULL
      JOIN projects p ON p.id=g.project_id AND p.active=1
      JOIN file_index file ON substr(file.r2_key,1,length(association.r2_prefix))=association.r2_prefix
      JOIN image_asset_locations location
        ON location.source_key=file.r2_key AND location.source_etag=trim(file.etag,'"') AND location.status='ready'
      WHERE association.account_id=a.id AND association.scope_type='project' AND association.project_id=?
        AND association.revoked_at IS NULL ${memberProjectConstraint}
        ${associationGrantFilter.sql}
        AND file.media_kind='image'
        AND file.r2_key NOT LIKE '_ltds/%' AND file.r2_key NOT LIKE '%/_ltds/%'
        AND file.r2_key NOT LIKE '.previews/%' AND file.r2_key NOT LIKE '%/.previews/%'
        AND file.r2_key NOT LIKE 'dump/%' AND file.r2_key NOT LIKE '%/dump/%'
        AND NOT EXISTS (
          SELECT 1 FROM delivery_tombstones tombstone
          WHERE tombstone.restored_at IS NULL AND (
            tombstone.physical_key=file.r2_key OR
            (tombstone.tombstone_kind='prefix' AND substr(file.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key)
          )
        )
      ORDER BY location.source_key LIMIT ?`)
      .bind(session.accountId, session.identityId, projectId,
        ...associationGrantFilter.bindings, LOCATION_MAP_LIMIT + 1)
      .all<LocationRow>();
    return aggregateDeliveryLocations(result.results, LOCATION_MAP_LIMIT);
  },

  async listPastDeliveryLocations(
    env: Env,
    session: ClientPortalSession,
  ): Promise<DeliveryLocationCollection> {
    const grantPrefixes = await deliveryGrantPrefixes(env, session);
    const associationGrantFilter = prefixSqlFilter(grantPrefixes, "association.r2_prefix");
    const result = await portalDb(env).prepare(`
      SELECT DISTINCT location.source_key,location.latitude,location.longitude
      FROM client_folder_associations association
      ${sessionJoin}
      JOIN file_index file ON substr(file.r2_key,1,length(association.r2_prefix))=association.r2_prefix
      JOIN image_asset_locations location
        ON location.source_key=file.r2_key AND location.source_etag=trim(file.etag,'"') AND location.status='ready'
      WHERE association.account_id=a.id AND association.scope_type='client' AND association.project_id IS NULL
        AND association.revoked_at IS NULL AND file.media_kind='image'
        ${associationGrantFilter.sql}
        AND file.r2_key NOT LIKE '_ltds/%' AND file.r2_key NOT LIKE '%/_ltds/%'
        AND file.r2_key NOT LIKE '.previews/%' AND file.r2_key NOT LIKE '%/.previews/%'
        AND file.r2_key NOT LIKE 'dump/%' AND file.r2_key NOT LIKE '%/dump/%'
        AND NOT EXISTS (
          SELECT 1 FROM delivery_tombstones tombstone
          WHERE tombstone.restored_at IS NULL AND (
            tombstone.physical_key=file.r2_key OR
            (tombstone.tombstone_kind='prefix' AND substr(file.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key)
          )
        )
      ORDER BY location.source_key LIMIT ?`)
      .bind(session.accountId, session.identityId,
        ...associationGrantFilter.bindings, LOCATION_MAP_LIMIT + 1)
      .all<LocationRow>();
    return aggregateDeliveryLocations(result.results, LOCATION_MAP_LIMIT);
  },

  async getAuthorizedFile(
    env: Env,
    session: ClientPortalSession,
    fileId: string,
    projectId?: string | null,
  ): Promise<AuthorizedClientPortalFile | null> {
    const key = await decodeFileId(env, fileId);
    if (!key) return null;
    const grantPrefixes = await deliveryGrantPrefixes(env, session);
    const associationGrantFilter = prefixSqlFilter(grantPrefixes, "association.r2_prefix");
    const scope = projectId ? "project" : "client";
    const row = await portalDb(env)
      .prepare(
        `
      SELECT f.r2_key,f.size,f.uploaded_at,f.content_type,f.media_kind,association.r2_prefix association_prefix
      FROM client_folder_associations association
      JOIN file_index f ON f.r2_key=? AND substr(f.r2_key,1,length(association.r2_prefix))=association.r2_prefix
      ${sessionJoin}
      ${projectId ? `JOIN client_project_grants g ON g.account_id=a.id AND g.project_id=association.project_id AND g.revoked_at IS NULL
      JOIN projects p ON p.id=g.project_id AND p.active=1` : ""}
      WHERE association.account_id=a.id AND association.scope_type=?
        AND ${projectId ? "association.project_id=?" : "association.project_id IS NULL"}
        AND association.revoked_at IS NULL
        ${associationGrantFilter.sql}
        AND NOT EXISTS (
          SELECT 1 FROM delivery_tombstones tombstone
          WHERE tombstone.restored_at IS NULL
            AND (tombstone.physical_key=f.r2_key OR
              (tombstone.tombstone_kind='prefix' AND substr(f.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key))
        )
        ${projectId ? memberProjectConstraint : ""}
      ORDER BY length(association.r2_prefix) DESC LIMIT 1`,
      )
      .bind(
        ...(projectId
          ? [key, session.accountId, session.identityId, scope, projectId, ...associationGrantFilter.bindings]
          : [key, session.accountId, session.identityId, scope, ...associationGrantFilter.bindings]),
      )
      .first<FileRow>();
    return row ? { ...mapFile(row, projectId || null, fileId), storageKey: key } : null;
  },

  async listDeliveries(
    env: Env,
    session: ClientPortalSession,
    projectId: string,
  ): Promise<ClientDelivery[]> {
    const result = await portalDb(env)
      .prepare(
        `
      SELECT s.id AS share_id,d.project_id,s.public_id,s.share_version,s.label,s.expires_at,
        CASE WHEN s.password_hash IS NULL THEN 0 ELSE 1 END AS requires_password
      FROM client_delivery_grants d
      ${sessionJoin}
      JOIN client_project_grants g ON g.account_id=a.id AND g.project_id=d.project_id AND g.revoked_at IS NULL
      JOIN projects p ON p.id=g.project_id AND p.active=1
      JOIN shares s ON s.id=d.share_id AND s.project_id=d.project_id AND s.share_version=d.share_version
      WHERE d.account_id=a.id AND d.project_id=? AND d.revoked_at IS NULL
        ${memberProjectConstraint}
        AND (d.expires_at IS NULL OR datetime(d.expires_at)>datetime('now'))
        AND s.public_id IS NOT NULL AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))
      ORDER BY s.created_at DESC,s.id DESC`,
      )
      .bind(session.accountId, session.identityId, projectId)
      .all<DeliveryRow>();
    return result.results.map(mapDelivery);
  },

  async getDeliveryHandoff(
    env: Env,
    session: ClientPortalSession,
    projectId: string,
    shareId: string,
  ): Promise<{ publicId: string } | null> {
    const row = await portalDb(env)
      .prepare(
        `
      SELECT s.public_id
      FROM client_delivery_grants d
      ${sessionJoin}
      JOIN client_project_grants g ON g.account_id=a.id AND g.project_id=d.project_id AND g.revoked_at IS NULL
      JOIN projects p ON p.id=g.project_id AND p.active=1
      JOIN shares s ON s.id=d.share_id AND s.project_id=d.project_id AND s.share_version=d.share_version
      WHERE d.account_id=a.id AND d.project_id=? AND d.share_id=? AND d.revoked_at IS NULL
        ${memberProjectConstraint}
        AND (d.expires_at IS NULL OR datetime(d.expires_at)>datetime('now'))
        AND s.public_id IS NOT NULL AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`,
      )
      .bind(session.accountId, session.identityId, projectId, shareId)
      .first<{ public_id: string }>();
    return row ? { publicId: row.public_id } : null;
  },

  async listNotifications(
    env: Env,
    session: ClientPortalSession,
    cursor?: string | null,
  ): Promise<{ notifications: ClientPortalNotification[]; unreadCount: number; cursor: string | null }> {
    const rows = await portalDb(env).prepare(`SELECT n.id,n.event_type,n.title,n.body,n.action_path,n.read_at,n.created_at
      FROM client_portal_notifications n ${sessionJoin}
      WHERE n.account_id=a.id AND n.recipient_identity_id=i.id AND n.dismissed_at IS NULL
        AND (n.source_type<>'service_request' OR EXISTS (
          SELECT 1 FROM client_service_requests authorized_notification
          WHERE authorized_notification.id=n.source_id AND authorized_notification.account_id=a.id
            AND ((authorized_notification.project_id IS NULL AND (m.role='manager' OR authorized_notification.created_by_identity_id=i.id)) OR
              (authorized_notification.project_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM client_project_grants notification_grant
                JOIN projects notification_project ON notification_project.id=notification_grant.project_id AND notification_project.active=1
                WHERE notification_grant.account_id=a.id AND notification_grant.project_id=authorized_notification.project_id
                  AND notification_grant.revoked_at IS NULL AND (m.role='manager' OR EXISTS (
                    SELECT 1 FROM client_member_project_grants notification_member_grant
                    WHERE notification_member_grant.account_id=a.id AND notification_member_grant.identity_id=i.id
                      AND notification_member_grant.project_id=authorized_notification.project_id AND notification_member_grant.revoked_at IS NULL
                  ))
              )))
        ))
        AND (?='' OR (n.created_at,n.id)<(
          SELECT cursor.created_at,cursor.id FROM client_portal_notifications cursor
          WHERE cursor.id=? AND cursor.account_id=a.id AND cursor.recipient_identity_id=i.id))
      ORDER BY n.created_at DESC,n.id DESC LIMIT 51`)
      .bind(session.accountId, session.identityId, cursor || "", cursor || "")
      .all<{ id: string; event_type: ClientPortalNotification["eventType"]; title: string; body: string; action_path: string | null; read_at: string | null; created_at: string }>();
    const unread = await portalDb(env).prepare(`SELECT COUNT(*) count FROM client_portal_notifications n ${sessionJoin}
      WHERE n.account_id=a.id AND n.recipient_identity_id=i.id AND n.dismissed_at IS NULL AND n.read_at IS NULL
        AND (n.source_type<>'service_request' OR EXISTS (
          SELECT 1 FROM client_service_requests authorized_notification
          WHERE authorized_notification.id=n.source_id AND authorized_notification.account_id=a.id
            AND ((authorized_notification.project_id IS NULL AND (m.role='manager' OR authorized_notification.created_by_identity_id=i.id)) OR
              (authorized_notification.project_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM client_project_grants notification_grant
                JOIN projects notification_project ON notification_project.id=notification_grant.project_id AND notification_project.active=1
                WHERE notification_grant.account_id=a.id AND notification_grant.project_id=authorized_notification.project_id
                  AND notification_grant.revoked_at IS NULL AND (m.role='manager' OR EXISTS (
                    SELECT 1 FROM client_member_project_grants notification_member_grant
                    WHERE notification_member_grant.account_id=a.id AND notification_member_grant.identity_id=i.id
                      AND notification_member_grant.project_id=authorized_notification.project_id AND notification_member_grant.revoked_at IS NULL
                  ))
              )))
        ))`)
      .bind(session.accountId, session.identityId).first<{ count: number }>();
    const page = rows.results.slice(0, 50);
    return {
      notifications: page.map(row => ({ id: row.id, eventType: row.event_type, title: row.title, body: row.body,
        actionPath: row.action_path?.startsWith("/portal/") ? row.action_path : null, readAt: row.read_at, createdAt: row.created_at })),
      unreadCount: unread?.count || 0,
      cursor: rows.results.length > 50 ? page.at(-1)!.id : null,
    };
  },

  async updateNotification(env: Env, session: ClientPortalSession, notificationId: string, action: "read" | "dismiss"): Promise<boolean> {
    const result = await portalDb(env).prepare(action === "read"
      ? `UPDATE client_portal_notifications SET read_at=COALESCE(read_at,datetime('now')) WHERE id=? AND account_id=? AND recipient_identity_id=? AND dismissed_at IS NULL
          AND EXISTS (SELECT 1 FROM client_accounts a JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
            JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL WHERE a.id=? AND a.status='active')`
      : `UPDATE client_portal_notifications SET dismissed_at=COALESCE(dismissed_at,datetime('now')) WHERE id=? AND account_id=? AND recipient_identity_id=? AND dismissed_at IS NULL
          AND EXISTS (SELECT 1 FROM client_accounts a JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
            JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL WHERE a.id=? AND a.status='active')`)
      .bind(notificationId, session.accountId, session.identityId, session.identityId, session.accountId).run();
    return Boolean(result.meta.changes);
  },

  async listServiceRequests(
    env: Env,
    session: ClientPortalSession,
  ): Promise<ClientServiceRequest[]> {
    const result = await serviceRequestRead(env, (database, sql) => database.prepare(`
      SELECT ${sql.columns}
      FROM client_service_requests r
      ${sessionJoin}
      ${sql.quoteJoin}
      ${operationalEstimateJoin}
      ${sql.areaJoin}
      WHERE r.account_id=a.id ${requestAccessConstraint}
      ORDER BY r.created_at DESC,r.id DESC
      LIMIT 100`)
      .bind(session.accountId, session.identityId)
      .all<ServiceRequestRow>());
    return result.results.map((row) =>
      mapServiceRequest(row, session.canViewBilling),
    );
  },

  async getServiceRequest(
    env: Env,
    session: ClientPortalSession,
    requestId: string,
  ): Promise<ClientServiceRequest | null> {
    const row = await serviceRequestRead(env, (database, sql) => database.prepare(`
      SELECT ${sql.columns}
      FROM client_service_requests r
      ${sessionJoin}
      ${sql.quoteJoin}
      ${operationalEstimateJoin}
      ${sql.areaJoin}
      WHERE r.id=? AND r.account_id=a.id ${requestAccessConstraint}`)
      .bind(session.accountId, session.identityId, requestId)
      .first<ServiceRequestRow>());
    return row ? mapServiceRequest(row, session.canViewBilling) : null;
  },

  async createServiceRequest(
    env: Env,
    session: ClientPortalSession,
    input: ClientServiceRequestInput,
  ) {
    const requestId = crypto.randomUUID();
    const fingerprint = await serviceRequestFingerprint(input);
    const existing = await getServiceRequestByIdempotency(
      env,
      session,
      input.idempotencyKey,
    );
    if (existing) {
      if (existing.request_fingerprint !== fingerprint)
        return { kind: "conflict" as const };
      return {
        kind: "replayed" as const,
        request: mapServiceRequest(existing, session.canViewBilling),
      };
    }
    const db = portalDb(env);
    const notificationProject = input.projectId
      ? await db
          .prepare(
            `SELECT p.project_name FROM projects p
             JOIN client_project_grants g ON g.project_id=p.id AND g.account_id=? AND g.revoked_at IS NULL
             WHERE p.id=? AND p.active=1`,
          )
          .bind(session.accountId, input.projectId)
          .first<{ project_name: string }>()
      : null;
    const notificationPayload = buildServiceRequestNotificationSnapshot({
      title: input.title,
      projectId: input.projectId,
      projectName: notificationProject?.project_name,
      serviceCategory: input.serviceCategory,
      locationLabel: input.location,
      latitude: input.latitude,
      longitude: input.longitude,
      lifecycle: "submitted",
      action: "review_in_operations",
    });
    const sharedValues = [
      requestId,
      input.parentRequestId ?? null,
      input.requestType,
      input.title,
      input.details,
      input.location,
      input.preferredStartAt,
      input.serviceCategory ?? null,
      input.deliverables ?? null,
      input.siteContactName ?? null,
      input.siteContactEmail ?? null,
      input.siteContactPhone ?? null,
      input.desiredCompletionAt ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
      input.areaGeoJson ? JSON.stringify(input.areaGeoJson) : null,
      input.poiPoints?.length ? JSON.stringify(input.poiPoints) : null,
      input.idempotencyKey,
      fingerprint,
    ];
    const insert = input.projectId
      ? db
          .prepare(
            `
      INSERT INTO client_service_requests
        (id,account_id,project_id,parent_request_id,created_by_identity_id,request_type,title,details,location_text,preferred_start_at,service_category,deliverables_text,site_contact_name,site_contact_email,site_contact_phone,desired_completion_at,latitude,longitude,area_geojson,poi_points_json,idempotency_key,request_fingerprint)
      SELECT ?,a.id,g.project_id,?,i.id,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      FROM client_accounts a
      JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
      JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
      JOIN client_project_grants g ON g.account_id=a.id AND g.project_id=? AND g.revoked_at IS NULL AND g.can_request_service=1
      JOIN projects p ON p.id=g.project_id AND p.active=1
      WHERE a.id=? AND a.status='active' ${memberProjectConstraint}
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM client_service_requests parent
          WHERE parent.id=? AND parent.account_id=a.id AND parent.project_id=g.project_id
            AND parent.status IN ('under_review','accepted_pending_pa_linkage','accepted_linked')
        ))`,
          )
          .bind(
            ...sharedValues,
            session.identityId,
            input.projectId,
            session.accountId,
            input.parentRequestId ?? null,
            input.parentRequestId ?? null,
          )
      : db
          .prepare(
            `
      INSERT INTO client_service_requests
        (id,account_id,project_id,parent_request_id,created_by_identity_id,request_type,title,details,location_text,preferred_start_at,service_category,deliverables_text,site_contact_name,site_contact_email,site_contact_phone,desired_completion_at,latitude,longitude,area_geojson,poi_points_json,idempotency_key,request_fingerprint)
      SELECT ?,a.id,NULL,?,i.id,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      FROM client_accounts a
      JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
      JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
      WHERE a.id=? AND a.status='active'
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM client_service_requests parent
          WHERE parent.id=? AND parent.account_id=a.id AND parent.project_id IS NULL
            AND parent.status IN ('under_review','accepted_pending_pa_linkage','accepted_linked')
        ))`,
          )
          .bind(
            ...sharedValues,
            session.identityId,
            session.accountId,
            input.parentRequestId ?? null,
            input.parentRequestId ?? null,
          );
    let batch: D1Result<unknown>[];
    try {
      batch = await db.batch([
        insert,
        db
          .prepare(
            `INSERT INTO client_portal_notification_outbox
          (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json)
          SELECT ?,?,'request_submitted','submitted','staff_triage','request_submitted:submitted:staff_triage',? WHERE changes()=1`,
          )
          .bind(
            crypto.randomUUID(),
            requestId,
            JSON.stringify(notificationPayload),
          ),
        db
          .prepare(
            `INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json)
          SELECT 'client',?,'client.service_request.submitted','client_service_request',?,? WHERE changes()=1`,
          )
          .bind(
            session.identityId,
            requestId,
            JSON.stringify({
              accountId: session.accountId,
              projectId: input.projectId,
              requestType: input.requestType,
            }),
          ),
        db
          .prepare(
            `INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json)
          SELECT ?,?,1,'client',?,?,? WHERE changes()=1`,
          )
          .bind(
            crypto.randomUUID(),
            requestId,
            session.identityId,
            input.parentRequestId ? "change_request" : "submitted",
            serviceRequestSnapshot(input),
          ),
      ]);
    } catch {
      const raced = await getServiceRequestByIdempotency(
        env,
        session,
        input.idempotencyKey,
      );
      if (!raced) return null;
      return raced.request_fingerprint === fingerprint
        ? {
            kind: "replayed" as const,
            request: mapServiceRequest(raced, session.canViewBilling),
          }
        : { kind: "conflict" as const };
    }
    if (batch[0]?.meta.changes === 1) {
      const request = await this.getServiceRequest(env, session, requestId);
      if (!request) return null;
      return { kind: "created" as const, request };
    }
    return null;
  },

  async updateServiceRequest(
    env: Env,
    session: ClientPortalSession,
    requestId: string,
    input: ClientServiceRequestInput,
  ): Promise<ClientServiceRequest | null> {
    const current = await this.getServiceRequest(env, session, requestId);
    if (
      !current ||
      current.status !== "submitted" ||
      current.projectId !== input.projectId
    )
      return null;
    const fingerprint = await serviceRequestFingerprint(input);
    const db = portalDb(env);
    const replay = await db
      .prepare(
        "SELECT mutation_fingerprint FROM request_revisions WHERE request_id=? AND mutation_key=?",
      )
      .bind(requestId, input.idempotencyKey)
      .first<{ mutation_fingerprint: string }>();
    if (replay)
      return replay.mutation_fingerprint === fingerprint ? current : null;
    if (!input.expectedUpdatedAt || input.expectedUpdatedAt !== current.updatedAt)
      return null;
    let results: D1Result<unknown>[];
    try {
      results = await db.batch([
      db
        .prepare(
          `UPDATE client_service_requests SET request_type=?,title=?,details=?,location_text=?,preferred_start_at=?,
        service_category=?,deliverables_text=?,site_contact_name=?,site_contact_email=?,site_contact_phone=?,
        desired_completion_at=?,latitude=?,longitude=?,area_geojson=?,poi_points_json=?,request_fingerprint=?,updated_at=strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE id=? AND account_id=? AND status='submitted' AND updated_at=?
          AND EXISTS (
            SELECT 1 FROM client_service_requests authorized
            ${sessionJoin}
            WHERE authorized.id=client_service_requests.id AND authorized.account_id=a.id
              AND (
                (authorized.project_id IS NULL AND (m.role='manager' OR authorized.created_by_identity_id=i.id)) OR
                (authorized.project_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM client_project_grants request_grant
                  JOIN projects request_project ON request_project.id=request_grant.project_id AND request_project.active=1
                  WHERE request_grant.account_id=a.id AND request_grant.project_id=authorized.project_id
                    AND request_grant.revoked_at IS NULL
                    AND (m.role='manager' OR EXISTS (
                      SELECT 1 FROM client_member_project_grants request_member_grant
                      WHERE request_member_grant.account_id=a.id AND request_member_grant.identity_id=i.id
                        AND request_member_grant.project_id=authorized.project_id AND request_member_grant.revoked_at IS NULL
                    ))
                ))
              )
          )`,
        )
        .bind(
          input.requestType,
          input.title,
          input.details,
          input.location,
          input.preferredStartAt,
          input.serviceCategory ?? null,
          input.deliverables ?? null,
          input.siteContactName ?? null,
          input.siteContactEmail ?? null,
          input.siteContactPhone ?? null,
          input.desiredCompletionAt ?? null,
          input.latitude ?? null,
          input.longitude ?? null,
          input.areaGeoJson ? JSON.stringify(input.areaGeoJson) : null,
          input.poiPoints?.length ? JSON.stringify(input.poiPoints) : null,
          fingerprint,
          requestId,
          session.accountId,
          input.expectedUpdatedAt,
          session.accountId,
          session.identityId,
        ),
      db
        .prepare(
          `INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json)
        SELECT 'client',?,'client.service_request.updated','client_service_request',?,? WHERE changes()=1`,
        )
        .bind(
          session.identityId,
          requestId,
          JSON.stringify({ accountId: session.accountId }),
        ),
      db
        .prepare(
          `INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json,mutation_key,mutation_fingerprint)
        SELECT ?,?,COALESCE((SELECT MAX(revision_number)+1 FROM request_revisions WHERE request_id=?),1),'client',?,'client_edit',?,?,?
        WHERE changes()=1`,
        )
        .bind(
          crypto.randomUUID(),
          requestId,
          requestId,
          session.identityId,
          serviceRequestSnapshot(input),
          input.idempotencyKey,
          fingerprint,
        ),
      ]);
    } catch {
      const raced = await db
        .prepare(
          "SELECT mutation_fingerprint FROM request_revisions WHERE request_id=? AND mutation_key=?",
        )
        .bind(requestId, input.idempotencyKey)
        .first<{ mutation_fingerprint: string }>();
      if (raced?.mutation_fingerprint === fingerprint)
        return this.getServiceRequest(env, session, requestId);
      return null;
    }
    if (!results[0]?.meta.changes) return null;
    return this.getServiceRequest(env, session, requestId);
  },

  async createChangeRequest(
    env: Env,
    session: ClientPortalSession,
    parentRequestId: string,
    input: ClientServiceRequestInput,
  ) {
    const parent = await this.getServiceRequest(env, session, parentRequestId);
    if (
      !parent ||
      parent.status === "submitted" ||
      parent.status === "cancelled" ||
      parent.status === "declined" ||
      parent.status === "completed"
    )
      return null;
    if (input.projectId !== parent.projectId) return null;
    return this.createServiceRequest(env, session, {
      ...input,
      parentRequestId,
    });
  },

  async respondToOperationalEstimate(
    env,
    session,
    requestId,
    estimateId,
    response,
    note,
    mutationKey,
  ) {
    const current = await this.getServiceRequest(env, session, requestId);
    const responseFingerprint = await sha256(
      JSON.stringify([estimateId, response, note?.trim() || null]),
    );
    const replay = await portalDb(env)
      .prepare(
        "SELECT mutation_fingerprint FROM request_revisions WHERE request_id=? AND mutation_key=?",
      )
      .bind(requestId, mutationKey)
      .first<{ mutation_fingerprint: string }>();
    if (replay)
      return replay.mutation_fingerprint === responseFingerprint ? current : null;
    if (
      !current ||
      current.operationalEstimate?.id !== estimateId ||
      current.operationalEstimate.status !== "ready"
    )
      return null;
    if (response === "request_change" && !note?.trim()) return null;
    const notificationProject = current.projectId
      ? await this.getProject(env, session, current.projectId)
      : null;
    const notificationPayload = buildServiceRequestNotificationSnapshot({
      title: current.title,
      projectId: current.projectId,
      projectName: notificationProject?.projectName,
      serviceCategory: current.serviceCategory,
      locationLabel: current.location,
      latitude: current.latitude,
      longitude: current.longitude,
      lifecycle: "client_response_received",
      action: "review_in_operations",
    });
    const nextStatus = response === "accept" ? "accepted" : "change_requested";
    const db = portalDb(env);
    const results = await db.batch([
      db
        .prepare(
          `UPDATE request_operational_estimates SET status=?,client_response_note=?,responded_at=datetime('now'),updated_at=datetime('now')
        WHERE id=? AND request_id=? AND status='ready'
          AND EXISTS (
            SELECT 1 FROM client_service_requests authorized
            ${sessionJoin}
            WHERE authorized.id=request_operational_estimates.request_id AND authorized.account_id=a.id
              AND (
                (authorized.project_id IS NULL AND (m.role='manager' OR authorized.created_by_identity_id=i.id)) OR
                (authorized.project_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM client_project_grants request_grant
                  JOIN projects request_project ON request_project.id=request_grant.project_id AND request_project.active=1
                  WHERE request_grant.account_id=a.id AND request_grant.project_id=authorized.project_id
                    AND request_grant.revoked_at IS NULL
                    AND (m.role='manager' OR EXISTS (
                      SELECT 1 FROM client_member_project_grants request_member_grant
                      WHERE request_member_grant.account_id=a.id AND request_member_grant.identity_id=i.id
                        AND request_member_grant.project_id=authorized.project_id AND request_member_grant.revoked_at IS NULL
                    ))
                ))
              )
          )`,
        )
        .bind(
          nextStatus,
          note?.trim() || null,
          estimateId,
          requestId,
          session.accountId,
          session.identityId,
        ),
      db
        .prepare(
          `INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json,note,mutation_key,mutation_fingerprint)
        SELECT ?,?,COALESCE((SELECT MAX(revision_number)+1 FROM request_revisions WHERE request_id=?),1),'client',?,'client_response',?,?,?,?
        WHERE changes()=1`,
        )
        .bind(
          crypto.randomUUID(),
          requestId,
          requestId,
          session.identityId,
          JSON.stringify({ estimateId, response, status: current.status }),
          note?.trim() || null,
          mutationKey,
          responseFingerprint,
        ),
      db
        .prepare(
          `INSERT OR IGNORE INTO client_portal_notification_outbox(id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json)
        SELECT ?,?,'request_client_response',NULL,'staff_triage',?,? WHERE changes()=1`,
        )
        .bind(
          crypto.randomUUID(),
          requestId,
          `request_client_response:${estimateId}:${response}:staff_triage`,
          JSON.stringify(notificationPayload),
        ),
      db
        .prepare(
          `INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
        SELECT 'client',?,'client.service_request.estimate_response','client_service_request',?,? WHERE changes()=1`,
        )
        .bind(
          session.identityId,
          requestId,
          JSON.stringify({ estimateId, response }),
        ),
    ]);
    if (!results[0]?.meta.changes) return null;
    return this.getServiceRequest(env, session, requestId);
  },

  async listMembers(
    env: Env,
    session: ClientPortalSession,
  ): Promise<ClientPortalMember[] | null> {
    if (session.role !== "manager") return null;
    const result = await portalDb(env)
      .prepare(
        `
      SELECT m.identity_id,i.email,m.role,m.can_view_billing
      FROM client_account_members m
      JOIN client_accounts a ON a.id=? AND a.status='active'
      JOIN client_identity_links actor_identity ON actor_identity.id=? AND actor_identity.account_id=a.id AND actor_identity.revoked_at IS NULL
      JOIN client_account_members actor ON actor.account_id=a.id AND actor.identity_id=actor_identity.id AND actor.role='manager' AND actor.revoked_at IS NULL
      JOIN client_identity_links listed_identity ON listed_identity.id=m.identity_id AND listed_identity.account_id=a.id AND listed_identity.revoked_at IS NULL
      LEFT JOIN client_identity_links i ON i.id=listed_identity.id
      WHERE m.account_id=a.id AND m.revoked_at IS NULL
      ORDER BY CASE m.role WHEN 'manager' THEN 0 ELSE 1 END,i.email COLLATE NOCASE,m.identity_id`,
      )
      .bind(session.accountId, session.identityId)
      .all<MemberRow>();
    return result.results.map(mapMember);
  },

  async listInvitations(
    env: Env,
    session: ClientPortalSession,
  ): Promise<ClientPortalInvitation[] | null> {
    if (session.role !== "manager") return null;
    const result = await portalDb(env)
      .prepare(
        `
      SELECT invitation.id,invitation.email,invitation.project_ids_json,invitation.expires_at
      FROM client_account_invitations invitation
      ${sessionJoin}
      WHERE invitation.account_id=a.id AND invitation.revoked_at IS NULL AND invitation.accepted_at IS NULL
        AND datetime(invitation.expires_at)>datetime('now')
      ORDER BY invitation.created_at DESC,invitation.id DESC`,
      )
      .bind(session.accountId, session.identityId)
      .all<InvitationRow>();
    return result.results.map(mapInvitation);
  },

  async createInvitation(
    env: Env,
    session: ClientPortalSession,
    input: { email: string; projectIds: string[] },
  ): Promise<ClientPortalInvitation | null> {
    if (session.role !== "manager") return null;
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320)
      return null;
    const projectIds = [...new Set(input.projectIds)].sort();
    if (
      projectIds.some(
        (projectId) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId),
      )
    )
      return null;
    if (projectIds.length > 100) return null;

    // A manager may only select projects already activated by LTDS for this account.
    if (projectIds.length > 0) {
      const placeholders = projectIds.map(() => "?").join(",");
      const active = await portalDb(env)
        .prepare(
          `
        SELECT COUNT(*) AS count FROM client_project_grants g
        ${sessionJoin}
        WHERE g.account_id=a.id AND g.revoked_at IS NULL AND g.project_id IN (${placeholders})`,
        )
        .bind(session.accountId, session.identityId, ...projectIds)
        .first<{ count: number }>();
      if (!active || active.count !== projectIds.length) return null;
    }

    const invitation: ClientPortalInvitation = {
      id: crypto.randomUUID(),
      email,
      projectIds,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const db = portalDb(env);
    const created = await db
      .prepare(
        `
      INSERT INTO client_account_invitations
        (id,account_id,email,project_ids_json,expires_at,invited_by_identity_id)
      SELECT ?,a.id,?,?,?,i.id
      FROM client_accounts a
      JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
      JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
      WHERE a.id=? AND m.role='manager'
        AND NOT EXISTS (
          SELECT 1 FROM client_account_invitations pending
          WHERE pending.account_id=a.id AND pending.email=? AND pending.revoked_at IS NULL AND pending.accepted_at IS NULL
        )`,
      )
      .bind(
        invitation.id,
        email,
        JSON.stringify(projectIds),
        invitation.expiresAt,
        session.identityId,
        session.accountId,
        email,
      )
      .run();
    if (created.meta.changes !== 1) return null;

    await Promise.all([
      db
        .prepare(
          "INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('client_manager',?,'client.invitation.created','client_account_invitation',?,?)",
        )
        .bind(
          session.identityId,
          invitation.id,
          JSON.stringify({
            accountId: session.accountId,
            projectCount: projectIds.length,
          }),
        )
        .run(),
      db
        .prepare(
          "INSERT INTO client_access_sync_outbox (id,account_id,email,action,source_type,source_id) VALUES (?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          session.accountId,
          email,
          "provision",
          "invite",
          invitation.id,
        )
        .run(),
    ]);
    return invitation;
  },

  async revokeMember(
    env: Env,
    session: ClientPortalSession,
    identityId: string,
  ): Promise<boolean> {
    if (session.role !== "manager" || identityId === session.identityId)
      return false;
    const db = portalDb(env);
    const revoked = await db
      .prepare(
        `
      UPDATE client_account_members SET revoked_at=datetime('now'),updated_at=datetime('now')
      WHERE account_id=? AND identity_id=? AND role='member' AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM client_account_members actor
          WHERE actor.account_id=? AND actor.identity_id=? AND actor.role='manager' AND actor.revoked_at IS NULL
        )`,
      )
      .bind(
        session.accountId,
        identityId,
        session.accountId,
        session.identityId,
      )
      .run();
    if (revoked.meta.changes !== 1) return false;
    // Local membership revocation is authoritative immediately. The outbox is
    // only a later coarse Cloudflare Access eligibility reconciliation.
    await Promise.all([
      db
        .prepare(
          "UPDATE client_identity_links SET revoked_at=datetime('now') WHERE id=? AND account_id=? AND revoked_at IS NULL",
        )
        .bind(identityId, session.accountId)
        .run(),
      db
        .prepare(
          "INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('client_manager',?,'client.member.revoked','client_account_member',?,?)",
        )
        .bind(
          session.identityId,
          identityId,
          JSON.stringify({ accountId: session.accountId }),
        )
        .run(),
      db
        .prepare(
          `INSERT INTO client_access_sync_outbox (id,account_id,email,action,source_type,source_id)
        SELECT ?,?,lower(email),'revoke','membership',? FROM client_identity_links
        WHERE id=? AND account_id=? AND email IS NOT NULL`,
        )
        .bind(
          crypto.randomUUID(),
          session.accountId,
          identityId,
          identityId,
          session.accountId,
        )
        .run(),
    ]);
    return true;
  },

  async revokeInvitation(
    env: Env,
    session: ClientPortalSession,
    invitationId: string,
  ): Promise<boolean> {
    if (session.role !== "manager") return false;
    const db = portalDb(env);
    const revoked = await db
      .prepare(
        `
      UPDATE client_account_invitations SET revoked_at=datetime('now')
      WHERE id=? AND account_id=? AND revoked_at IS NULL AND accepted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM client_account_members actor
          WHERE actor.account_id=? AND actor.identity_id=? AND actor.role='manager' AND actor.revoked_at IS NULL
        )`,
      )
      .bind(
        invitationId,
        session.accountId,
        session.accountId,
        session.identityId,
      )
      .run();
    if (revoked.meta.changes !== 1) return false;
    await db.batch([
      db
        .prepare(
          "INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('client_manager',?,'client.invitation.revoked','client_account_invitation',?,?)",
        )
        .bind(
          session.identityId,
          invitationId,
          JSON.stringify({ accountId: session.accountId }),
        ),
      db
        .prepare(
          `INSERT INTO client_access_sync_outbox (id,account_id,email,action,source_type,source_id)
        SELECT ?,account_id,lower(email),'revoke','invite',id
        FROM client_account_invitations WHERE id=? AND account_id=? AND revoked_at IS NOT NULL`,
        )
        .bind(crypto.randomUUID(), invitationId, session.accountId),
    ]);
    return true;
  },
};
