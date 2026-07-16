import { authenticateIntegration, authenticateStaff, requireAdmin, requireScope } from "./auth";
import { constantTimeEqual, hmac, randomToken, sha256, verifyPassword } from "./crypto";
import { html, HttpError, json, parseCookies, readJson } from "./http";
import { createShare, getShareByToken, listShares, revokeShare } from "./shares";
import type { Env, Principal, ShareRecord } from "./types";
import { renderAdmin, renderError, renderLanding, renderPortal, renderUnlock } from "./views";

const SHARE_ROUTE = /^\/s\/([^/]+)(?:\/(unlock|download))?$/;

function errorResponse(error: unknown, wantsHtml = false): Response {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error && status < 500 ? error.message : "An unexpected error occurred";
  if (!(error instanceof HttpError)) console.error(error);
  return wantsHtml ? html(renderError(status === 404 ? "Not found" : "Request failed", message, status), status) : json({ error: message }, status);
}

async function sessionIsValid(request: Request, env: Env, share: ShareRecord): Promise<boolean> {
  if (!share.password_hash) return true;
  const value = parseCookies(request)[`ltds_share_${share.id}`];
  if (!value) return false;
  const [expires, signature] = value.split(".");
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  const expected = await hmac(env.APP_SECRET, `share-session:${share.id}:${expires}`);
  return constantTimeEqual(expected, signature);
}

async function handleShare(request: Request, env: Env, url: URL, token: string, action?: string): Promise<Response> {
  const share = await getShareByToken(env, token);
  if (!share) throw new HttpError(404, "This delivery link is invalid, expired, or revoked.");

  if (action === "unlock" && request.method === "POST") {
    if (!share.password_hash || !share.password_salt || !share.password_iterations) return Response.redirect(`/s/${token}`, 303);
    const rateLimit = await env.ACCESS_CODE_RATE_LIMITER.limit({ key: share.id });
    if (!rateLimit.success) throw new HttpError(429, "Too many access-code attempts. Please wait one minute and try again.");
    const form = await request.formData();
    const code = String(form.get("access_code") || "");
    const accepted = await verifyPassword(code, share.password_hash, share.password_salt, share.password_iterations);
    if (!accepted) return html(renderUnlock(share, token, true), 401);
    const expires = Date.now() + 12 * 60 * 60 * 1000;
    const signature = await hmac(env.APP_SECRET, `share-session:${share.id}:${expires}`);
    return new Response(null, {
      status: 303,
      headers: {
        Location: `/s/${token}`,
        "Set-Cookie": `ltds_share_${share.id}=${expires}.${signature}; Path=/s/${token}; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`,
        "Cache-Control": "no-store",
      },
    });
  }

  const unlocked = await sessionIsValid(request, env, share);
  if (!unlocked) return html(renderUnlock(share, token));

  if (action === "download" && request.method === "GET") {
    const key = url.searchParams.get("key") || "";
    if (!key.startsWith(share.r2_prefix) || key === share.r2_prefix) throw new HttpError(403, "File is outside this delivery");
    const range = request.headers.get("range") ? request.headers : undefined;
    const object = await env.DATA_BUCKET.get(key, range ? { range } : undefined);
    if (!object) throw new HttpError(404, "File not found");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(key.split("/").pop() || "download")}`);
    headers.set("X-Content-Type-Options", "nosniff");
    if (range && object.range) {
      const offset = ("offset" in object.range ? object.range.offset : 0) ?? 0;
      const length = ("length" in object.range ? object.range.length : object.size) ?? object.size;
      headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set("Content-Length", String(length));
    }
    return new Response(object.body, { status: range ? 206 : 200, headers });
  }

  if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
  const cursor = url.searchParams.get("cursor") || undefined;
  const listed = await env.DATA_BUCKET.list({ prefix: share.r2_prefix, limit: 250, cursor });
  await env.DB.prepare("UPDATE shares SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?").bind(share.id).run();
  return html(renderPortal(share, token, listed.objects, listed.truncated ? listed.cursor : undefined));
}

async function createApiKey(env: Env, staffId: string, body: { name?: string; scopes?: string }) {
  const name = body.name?.trim();
  const scopes = [...new Set((body.scopes || "").split(/\s+/).filter((scope) => ["shares:read", "shares:write"].includes(scope)))];
  if (!name || !scopes.length) throw new HttpError(400, "name and at least one valid scope are required");
  const key = `ltds_${randomToken(32)}`;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO api_keys (id, name, key_prefix, key_hash, scopes, created_by) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, name, key.slice(0, 13), await sha256(key), scopes.join(" "), staffId).run();
  return { id, name, scopes, api_key: key };
}

async function handleStaffApi(request: Request, env: Env, url: URL): Promise<Response> {
  const principal = await authenticateStaff(request, env);
  const subpath = url.pathname.slice("/api/v1/admin".length) || "/";
  if (subpath === "/me" && request.method === "GET") return json({ user: principal });
  if (subpath === "/shares" && request.method === "GET") return json({ shares: await listShares(env) });
  if (subpath === "/shares" && request.method === "POST") return json({ share: await createShare(env, principal, await readJson(request)) }, 201);
  const revokeMatch = subpath.match(/^\/shares\/([0-9a-f-]+)$/i);
  if (revokeMatch && request.method === "DELETE") {
    const revoked = await revokeShare(env, principal, revokeMatch[1] || "");
    return revoked ? json({ success: true }) : json({ error: "Share not found or already revoked" }, 404);
  }
  if (subpath === "/staff" && request.method === "POST") {
    requireAdmin(principal);
    const body = await readJson<{ email?: string; display_name?: string; role?: string }>(request);
    const email = body.email?.trim().toLowerCase();
    const role = body.role === "admin" ? "admin" : "staff";
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, "A valid email is required");
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO staff_users (id, email, display_name, role) VALUES (?, ?, ?, ?)",
    ).bind(id, email, body.display_name?.trim() || null, role).run();
    return json({ staff: { id, email, role } }, 201);
  }
  if (subpath === "/api-keys" && request.method === "POST") {
    requireAdmin(principal);
    return json(await createApiKey(env, principal.id, await readJson(request)), 201);
  }
  throw new HttpError(404, "API route not found");
}

async function handleIntegrationApi(request: Request, env: Env, url: URL): Promise<Response> {
  const principal = await authenticateIntegration(request, env);
  const subpath = url.pathname.slice("/api/v1/integrations".length) || "/";
  if (subpath === "/shares" && request.method === "POST") {
    requireScope(principal, "shares:write");
    return json({ share: await createShare(env, principal, await readJson(request)) }, 201);
  }
  if (subpath === "/shares" && request.method === "GET") {
    requireScope(principal, "shares:read");
    return json({ shares: await listShares(env) });
  }
  throw new HttpError(404, "Integration API route not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") return json({ status: "ok", service: "client-data-server" });
      if (url.pathname === "/" && request.method === "GET") return html(renderLanding());
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
        return html(renderAdmin(await authenticateStaff(request, env)));
      }
      if (url.pathname.startsWith("/api/v1/admin/")) return await handleStaffApi(request, env, url);
      if (url.pathname.startsWith("/api/v1/integrations/")) return await handleIntegrationApi(request, env, url);
      const shareMatch = url.pathname.match(SHARE_ROUTE);
      if (shareMatch) return await handleShare(request, env, url, decodeURIComponent(shareMatch[1] || ""), shareMatch[2]);
      throw new HttpError(404, "Page not found");
    } catch (error) {
      return errorResponse(error, !url.pathname.startsWith("/api/"));
    }
  },
} satisfies ExportedHandler<Env>;
