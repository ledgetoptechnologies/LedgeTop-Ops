import { ZodError } from "zod";
import { reconcileAccessGroup } from "./access-group";
import { completeEvent, applyEntitlementEvent, applyProjectionEvent, recordAccessFailure, recordAccessSuccess } from "./projection";
import { parseIntegrationEvent } from "./schema";
import { MAX_BODY_BYTES, sha256Hex, validateRequestTimestamp, verifyAccessAssertion, verifyWebhookSignature } from "./security";
import type { Env } from "./types";

type AccessVerifier = (request: Request, env: Env) => Promise<unknown>;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "internal-error";
  if (error instanceof SyntaxError) return 400;
  if (message === "event-id-conflict") return 409;
  if (message === "projection-entity-busy") return 503;
  if (message.startsWith("access-group-")) return 503;
  if (error instanceof ZodError || message.includes("mismatch")) return 422;
  if (message.startsWith("projection-data-")) return 422;
  if (message.includes("required") || message.includes("invalid")) return 401;
  return 500;
}

export async function handleRequest(request: Request, env: Env, accessVerifier: AccessVerifier = verifyAccessAssertion): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (env.EXPECTED_HOST && url.hostname !== env.EXPECTED_HOST) return json(421,{error:"unexpected-host"});
    await accessVerifier(request,env);
    if (request.method === "GET" && url.pathname === "/health") {
      const state = await env.OPS_DB.prepare("SELECT last_event_at,last_access_success_at,last_access_error,updated_at FROM integration_reconciliation WHERE integration='project-alpha'").first();
      return json(200,{status:"ok",integration:state??null});
    }
    if (request.method !== "POST" || url.pathname !== "/v1/project-alpha/events") return json(404,{error:"not-found"});
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json(415,{error:"content-type-required"});
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_BODY_BYTES) return json(413,{error:"payload-too-large"});
    const rawBody = new Uint8Array(await request.arrayBuffer());
    if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_BODY_BYTES) return json(413,{error:"payload-size-invalid"});
    const timestamp = validateRequestTimestamp(request.headers.get("X-PA-Timestamp"));
    await verifyWebhookSignature(
      rawBody,
      timestamp,
      request.headers.get("X-PA-Signature-Ed25519"),
      env.PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY,
      env.PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY,
      request.headers.get("X-PA-Signature"),
      env.PROJECT_ALPHA_WEBHOOK_HMAC_SECRET,
      env.PROJECT_ALPHA_ALLOW_LEGACY_HMAC === "true",
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
    const event = parseIntegrationEvent(parsed,env.APPLICATION_KEY);
    if (request.headers.get("X-PA-Event-ID") !== event.event_id) return json(422,{error:"event-id-mismatch"});
    const result = event.event_type === "projection.changed"
      ? await applyProjectionEvent(env,event,await sha256Hex(rawBody))
      : await applyEntitlementEvent(env,event,await sha256Hex(rawBody));
    if (result === "duplicate" || result === "ignored") return json(200,{ok:true,event_id:event.event_id,status:result});
    let accessMembers = 0;
    let accessPending = false;
    if (event.event_type !== "projection.changed") {
      try {
        const emails = await reconcileAccessGroup(env);
        accessMembers = emails.length;
        await recordAccessSuccess(env);
      } catch (error) {
        const message = error instanceof Error?error.message:"access-group-error";
        await recordAccessFailure(env,event.event_id,message);
        console.error(JSON.stringify({event:"ops_sync_access_reconciliation_pending",error:message}));
        accessPending = true;
      }
    }
    await completeEvent(env,event);
    return json(accessPending?202:200,{ok:true,event_id:event.event_id,status:accessPending?"completed-access-reconciliation-pending":"completed",access_members:accessMembers});
  } catch (error) {
    const message = error instanceof ZodError ? "event-schema-invalid" : error instanceof SyntaxError ? "json-invalid" : error instanceof Error ? error.message : "internal-error";
    console.error(JSON.stringify({event:"ops_sync_request_failed",error:message}));
    return json(errorStatus(error),{error:message});
  }
}

export async function reconcileScheduledAccess(env: Env): Promise<number> {
  try {
    const emails = await reconcileAccessGroup(env);
    await recordAccessSuccess(env);
    return emails.length;
  } catch (error) {
    const message = error instanceof Error?error.message:"access-group-error";
    await recordAccessFailure(env,null,message);
    console.error(JSON.stringify({event:"ops_sync_scheduled_access_reconciliation_failed",error:message}));
    throw error;
  }
}

export default {
  fetch(request,env): Promise<Response> { return handleRequest(request,env); },
  scheduled(_event,env,ctx): void { ctx.waitUntil(reconcileScheduledAccess(env)); },
} satisfies ExportedHandler<Env>;
