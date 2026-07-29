import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env, StaffPrincipal } from "./types";
import { DropboxImportClient } from "./dropbox-import-client";
import {
  encryptImportSecret,
  decryptImportSecret,
  cleanupDropboxImports,
} from "./dropbox-import";
import { normalizeCrudKey } from "./r2-crud-validation";
import { requirePermission } from "./acl";

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;

const OAUTH_STATE_EXPIRY_MINUTES = 10;
const JOB_EXPIRY_HOURS = 24;
const randomSecret = (bytes: number): string => {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function importTokenSecret(env: Env): string {
  if (!env.DROPBOX_IMPORT_TOKEN_SECRET) throw new HTTPException(503, { message: "Dropbox import is not configured" });
  return env.DROPBOX_IMPORT_TOKEN_SECRET;
}

function dropboxImportEnabled(env: Env): boolean {
  return env.DROPBOX_IMPORT_ENABLED === "true" && Boolean(env.DROPBOX_CLIENT_ID && env.DROPBOX_CLIENT_SECRET && env.DROPBOX_IMPORT_TOKEN_SECRET);
}

function redirectUri(env: Env): string {
  return `${env.PUBLIC_BASE_URL}/api/dropbox-import/oauth/callback`;
}

export function registerDropboxImportRoutes(app: App): void {
  // OAuth start: staff initiates Dropbox authorization
  app.post("/api/dropbox-import/oauth/start", async c => {
    const principal = c.get("principal");
    if (!dropboxImportEnabled(c.env)) throw new HTTPException(503, { message: "Dropbox import is not available" });
    await requirePermission(c.env, principal, "delivery.files.upload", {}, true);

    const secret = importTokenSecret(c.env);
    const verifier = randomSecret(64);
    const challenge = await sha256(verifier);
    const state = randomSecret(32);
    const stateHash = await sha256(state);

    const encrypted = await encryptImportSecret({ verifier, staffId: principal.id }, secret, `oauth-state:${stateHash}`);

    await c.env.OPS_DB.prepare(
      "INSERT INTO dropbox_import_oauth_states (state_hash,staff_id,pkce_ciphertext,pkce_iv,key_id,expires_at) VALUES (?,?,?,?,?,datetime('now','+10 minutes'))",
    ).bind(stateHash, principal.id, encrypted.ciphertext, encrypted.iv, "v1").run();

    const url = new URL("https://www.dropbox.com/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: c.env.DROPBOX_CLIENT_ID!,
      redirect_uri: redirectUri(c.env),
      response_type: "code",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      token_access_type: "offline",
    }).toString();

    return c.json({ authorizationUrl: url.toString() });
  });

  // OAuth callback: Dropbox redirects back here
  app.get("/api/dropbox-import/oauth/callback", async c => {
    const state = c.req.query("state") || "";
    const code = c.req.query("code") || "";
    if (!state || !code) throw new HTTPException(400, { message: "Dropbox authorization was not completed" });

    const stateHash = await sha256(state);
    const nowIso = new Date().toISOString();
    const row = await c.env.OPS_DB.prepare(
      "SELECT * FROM dropbox_import_oauth_states WHERE state_hash=? AND consumed_at IS NULL AND datetime(expires_at)>datetime(?)",
    ).bind(stateHash, nowIso).first<{ staff_id: string; pkce_ciphertext: string; pkce_iv: string; key_id: string }>();
    if (!row) throw new HTTPException(400, { message: "Dropbox authorization expired" });

    const consumed = await c.env.OPS_DB.prepare(
      "UPDATE dropbox_import_oauth_states SET consumed_at=datetime('now') WHERE state_hash=? AND consumed_at IS NULL",
    ).bind(stateHash).run();
    if (!consumed.meta.changes) throw new HTTPException(400, { message: "Dropbox authorization was already used" });

    const secret = importTokenSecret(c.env);
    const pkce = await decryptImportSecret<{ verifier: string; staffId: string }>(
      row.pkce_ciphertext, row.pkce_iv, secret, `oauth-state:${stateHash}`,
    );

    // Exchange code for tokens
    const tokenResponse = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: pkce.verifier,
        client_id: c.env.DROPBOX_CLIENT_ID!,
        client_secret: c.env.DROPBOX_CLIENT_SECRET!,
        redirect_uri: redirectUri(c.env),
      }),
    });
    if (!tokenResponse.ok) throw new HTTPException(400, { message: "Dropbox authorization failed" });
    const token = await tokenResponse.json() as { access_token: string; refresh_token?: string; expires_in?: number; account_id?: string; scope?: string };

    const authId = randomSecret(16);
    const expiresAt = new Date(Date.now() + JOB_EXPIRY_HOURS * 3600000).toISOString();
    const tokenExpiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;
    const credential = await encryptImportSecret(
      { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: tokenExpiresAt },
      secret, `authorization:${authId}`,
    );

    await c.env.OPS_DB.prepare(
      "INSERT INTO dropbox_import_authorizations (id,staff_id,provider,credential_ciphertext,credential_iv,key_id,scopes,token_expires_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind(authId, pkce.staffId, "dropbox", credential.ciphertext, credential.iv, "v1", token.scope || "", tokenExpiresAt, expiresAt).run();

    // Redirect to the operations delivery page with the authorization ID
    const url = new URL("/delivery", c.env.PUBLIC_BASE_URL);
    url.searchParams.set("dropboxImportAuthorization", authId);
    return c.redirect(url.toString(), 302);
  });

  // Browse Dropbox folders
  app.post("/api/dropbox-import/browse", async c => {
    const principal = c.get("principal");
    if (!dropboxImportEnabled(c.env)) throw new HTTPException(503, { message: "Dropbox import is not available" });
    await requirePermission(c.env, principal, "delivery.files.upload", {}, true);

    const body = await c.req.json().catch(() => ({})) as { authorizationId?: string; path?: string; cursor?: string };
    if (!body.authorizationId) throw new HTTPException(400, { message: "Authorization ID is required" });

    const secret = importTokenSecret(c.env);
    const auth = await c.env.OPS_DB.prepare(
      "SELECT credential_ciphertext,credential_iv,key_id,token_expires_at,revoked_at FROM dropbox_import_authorizations WHERE id=? AND staff_id=? AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')",
    ).bind(body.authorizationId, principal.id).first<{ credential_ciphertext: string; credential_iv: string; key_id: string; token_expires_at: string | null; revoked_at: string | null }>();
    if (!auth || auth.revoked_at) throw new HTTPException(404, { message: "Dropbox authorization not found or expired" });

    const credential = await decryptImportSecret<{ accessToken: string; refreshToken?: string }>(
      auth.credential_ciphertext, auth.credential_iv, secret, `authorization:${body.authorizationId}`,
    );
    const client = new DropboxImportClient({ accessToken: credential.accessToken });

    if (body.cursor) {
      const result = await client.listFolderContinue(body.cursor);
      return c.json(result);
    }
    const path = body.path || "";
    const result = await client.listFolder(path || "", false);
    return c.json(result);
  });

  // Start an import job
  app.post("/api/dropbox-import/jobs", async c => {
    const principal = c.get("principal");
    if (!dropboxImportEnabled(c.env)) throw new HTTPException(503, { message: "Dropbox import is not available" });
    await requirePermission(c.env, principal, "delivery.files.upload", {}, true);

    const body = await c.req.json().catch(() => ({})) as {
      authorizationId?: string;
      dropboxPath?: string;
      destinationPrefix?: string;
      conflictMode?: string;
    };
    if (!body.authorizationId || !body.destinationPrefix) throw new HTTPException(400, { message: "Authorization and destination prefix are required" });
    if (!body.dropboxPath) throw new HTTPException(400, { message: "Dropbox source path is required" });

    const conflictMode = body.conflictMode === "skip" ? "skip" : body.conflictMode === "replace" ? "replace" : body.conflictMode === "fail" ? "fail" : "autorename";

    // Verify the authorization is still valid
    const auth = await c.env.OPS_DB.prepare(
      "SELECT id FROM dropbox_import_authorizations WHERE id=? AND staff_id=? AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')",
    ).bind(body.authorizationId, principal.id).first();
    if (!auth) throw new HTTPException(404, { message: "Dropbox authorization not found or expired" });

    const jobId = randomSecret(16);
    const expiresAt = new Date(Date.now() + JOB_EXPIRY_HOURS * 3600000).toISOString();
    const r2DestPrefix = normalizeCrudKey(body.destinationPrefix, true);

    await c.env.OPS_DB.prepare(
      "INSERT INTO dropbox_import_jobs (id,staff_id,authorization_id,source_path,destination_prefix,conflict_mode,status,expires_at) VALUES (?,?,?,?,?,?,'queued',?)",
    ).bind(jobId, principal.id, body.authorizationId, body.dropboxPath, r2DestPrefix, conflictMode, expiresAt).run();

    try {
      await c.env.DROPBOX_IMPORT_WORKFLOW!.create({ id: jobId, params: { jobId } });
    } catch (error) {
      console.error(JSON.stringify({ event: "dropbox-import.workflow-create-failed", jobId, error: error instanceof Error ? error.message : String(error) }));
      await c.env.OPS_DB.prepare(
        "UPDATE dropbox_import_jobs SET status='failed',error_code='import-failed',error_message=?,updated_at=datetime('now') WHERE id=?",
      ).bind("Could not start import job", jobId).run();
      throw new HTTPException(503, { message: "The import could not be queued" });
    }

    return c.json({ id: jobId, status: "queued" }, 202);
  });

  // Get job status
  app.get("/api/dropbox-import/jobs/:id", async c => {
    const principal = c.get("principal");
    const job = await c.env.OPS_DB.prepare(
      "SELECT * FROM dropbox_import_jobs WHERE id=? AND staff_id=?",
    ).bind(c.req.param("id"), principal.id).first();
    if (!job) throw new HTTPException(404, { message: "Import job not found" });

    const items = await c.env.OPS_DB.prepare(
      "SELECT id,dropbox_path,destination_key,size,status,downloaded_bytes,uploaded_bytes,r2_etag,error_message FROM dropbox_import_items WHERE job_id=? ORDER BY ordinal",
    ).bind(c.req.param("id")).all();

    return c.json({ job, items: items.results });
  });

  // Cancel a job
  app.post("/api/dropbox-import/jobs/:id/cancel", async c => {
    const principal = c.get("principal");
    const result = await c.env.OPS_DB.prepare(
      "UPDATE dropbox_import_jobs SET status='cancelling',cancel_requested_at=COALESCE(cancel_requested_at,datetime('now')),updated_at=datetime('now') WHERE id=? AND staff_id=? AND status IN ('queued','running','cancelling')",
    ).bind(c.req.param("id"), principal.id).run();
    if (!result.meta.changes) throw new HTTPException(409, { message: "This import can no longer be cancelled" });
    return c.json({ success: true, status: "cancelled" });
  });

  // List recent jobs
  app.get("/api/dropbox-import/jobs", async c => {
    const principal = c.get("principal");
    const result = await c.env.OPS_DB.prepare(
      "SELECT id,destination_prefix,conflict_mode,status,file_count,processed_files,succeeded_files,failed_files,total_bytes,processed_bytes,error_code,error_message,created_at,updated_at,completed_at FROM dropbox_import_jobs WHERE staff_id=? ORDER BY created_at DESC LIMIT 50",
    ).bind(principal.id).all();
    return c.json({ jobs: result.results });
  });
}