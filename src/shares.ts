import { hashPassword, hmac, randomToken, sha256 } from "./crypto";
import { HttpError } from "./http";
import type { Env, Principal, ShareRecord } from "./types";

interface CreateShareInput {
  client_name?: string;
  project_name?: string;
  r2_prefix?: string;
  external_ref?: string;
  label?: string;
  password?: string;
  generate_access_code?: boolean;
  expires_at?: string;
  idempotency_key?: string;
}

export function normalizePrefix(value: string): string {
  const prefix = value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!prefix || prefix === "/" || prefix.split("/").includes("..")) {
    throw new HttpError(400, "r2_prefix must be a safe, non-root object prefix");
  }
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function validateExpiration(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new HttpError(400, "expires_at must be a valid future date");
  }
  return date.toISOString();
}

export async function createShare(env: Env, principal: Principal, input: CreateShareInput) {
  const clientName = input.client_name?.trim();
  const projectName = input.project_name?.trim();
  if (!clientName || !projectName || !input.r2_prefix) {
    throw new HttpError(400, "client_name, project_name, and r2_prefix are required");
  }
  if (clientName.length > 160 || projectName.length > 160) throw new HttpError(400, "Names are too long");
  const r2Prefix = normalizePrefix(input.r2_prefix);
  const expiresAt = validateExpiration(input.expires_at);
  const externalRef = input.external_ref?.trim() || null;

  if (principal.type === "integration" && !input.idempotency_key) {
    throw new HttpError(400, "idempotency_key is required for integration-created shares");
  }
  const shareToken = principal.type === "integration"
    ? await hmac(env.APP_SECRET, `integration-share:${principal.id}:${input.idempotency_key}`)
    : randomToken();
  const tokenHash = await sha256(shareToken);

  const existing = await env.DB.prepare(
    `SELECT s.id, p.id AS project_id FROM shares s JOIN projects p ON p.id = s.project_id WHERE s.token_hash = ?`,
  ).bind(tokenHash).first<{ id: string; project_id: string }>();
  if (existing) {
    return {
      id: existing.id,
      project_id: existing.project_id,
      share_url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/s/${shareToken}`,
      access_code: null,
      idempotent_replay: true,
    };
  }

  let accessCode = input.generate_access_code ? randomToken(12) : input.password?.trim() || null;
  if (accessCode && accessCode.length < 8) throw new HttpError(400, "password must be at least 8 characters");
  const password = accessCode ? await hashPassword(accessCode) : null;
  const existingProject = externalRef
    ? await env.DB.prepare(
        "SELECT id, client_name, project_name, r2_prefix FROM projects WHERE external_ref = ?",
      ).bind(externalRef).first<{ id: string; client_name: string; project_name: string; r2_prefix: string }>()
    : null;
  if (existingProject && (
    existingProject.client_name !== clientName ||
    existingProject.project_name !== projectName ||
    existingProject.r2_prefix !== r2Prefix
  )) {
    throw new HttpError(409, "external_ref already belongs to a different client, project, or R2 prefix");
  }
  const projectId = existingProject?.id || crypto.randomUUID();
  const shareId = crypto.randomUUID();

  const statements = [];
  if (!existingProject) {
    statements.push(env.DB.prepare(
      `INSERT INTO projects (id, external_ref, client_name, project_name, r2_prefix, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(projectId, externalRef, clientName, projectName, r2Prefix, principal.type === "staff" ? principal.id : null));
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO shares
       (id, project_id, token_hash, label, password_hash, password_salt, password_iterations, expires_at, created_by_type, created_by_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      shareId,
      projectId,
      tokenHash,
      input.label?.trim() || null,
      password?.hash || null,
      password?.salt || null,
      password?.iterations || null,
      expiresAt,
      principal.type,
      principal.id,
    ),
    env.DB.prepare(
      `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details_json)
       VALUES (?, ?, 'share.created', 'share', ?, ?)`
    ).bind(principal.type, principal.id, shareId, JSON.stringify({ projectId, externalRef, r2Prefix })),
  );
  await env.DB.batch(statements);

  return {
    id: shareId,
    project_id: projectId,
    share_url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/s/${shareToken}`,
    access_code: input.generate_access_code ? accessCode : null,
    idempotent_replay: false,
  };
}

export async function getShareByToken(env: Env, token: string): Promise<ShareRecord | null> {
  if (token.length < 32 || token.length > 128) return null;
  const tokenHash = await sha256(token);
  return env.DB.prepare(
    `SELECT s.*, p.client_name, p.project_name, p.r2_prefix, p.external_ref
     FROM shares s JOIN projects p ON p.id = s.project_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND p.active = 1
       AND (s.expires_at IS NULL OR datetime(s.expires_at) > datetime('now'))`,
  ).bind(tokenHash).first<ShareRecord>();
}

export async function listShares(env: Env) {
  const result = await env.DB.prepare(
    `SELECT s.id, s.label, s.expires_at, s.revoked_at, s.created_at, s.access_count,
            (s.password_hash IS NOT NULL) AS password_protected,
            p.client_name, p.project_name, p.r2_prefix, p.external_ref
     FROM shares s JOIN projects p ON p.id = s.project_id
     ORDER BY s.created_at DESC LIMIT 100`,
  ).all();
  return result.results;
}

export async function revokeShare(env: Env, principal: Principal, shareId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE shares SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL",
  ).bind(shareId).run();
  if (result.meta.changes) {
    await env.DB.prepare(
      `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id)
       VALUES (?, ?, 'share.revoked', 'share', ?)`,
    ).bind(principal.type, principal.id, shareId).run();
  }
  return Boolean(result.meta.changes);
}
