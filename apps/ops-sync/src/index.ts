import { ZodError } from "zod";
import { reconcileAccessGroup } from "./access-group";
import { accessCircuitIsOpen, completeEvent, applyEntitlementEvent, applyProjectionEvent, recordAccessFailure, recordAccessSuccess, recordEventFailure } from "./projection";
import { parseIntegrationEvent } from "./schema";
import { MAX_BODY_BYTES, sha256Hex, validateRequestTimestamp, verifyAccessAssertion, verifyWebhookSignature } from "./security";
import type { Env } from "./types";
import { PRIMARY_PROJECT_ALPHA_SOURCE } from "../../operations/src/worker/project-alpha-source";

type AccessVerifier = (request: Request, env: Env) => Promise<unknown>;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "internal-error";
  if (error instanceof SyntaxError) return 400;
  if (message === "event-id-conflict") return 409;
  if (message === "projection-entity-busy" || message === "projection-global-busy") return 503;
  if (message.startsWith("access-group-")) return 503;
  if (error instanceof ZodError || message.includes("mismatch")) return 422;
  if (message.startsWith("projection-data-")) return 422;
  if (message.includes("required") || message.includes("invalid")) return 401;
  return 500;
}

export async function handleRequest(request: Request, env: Env, accessVerifier: AccessVerifier = verifyAccessAssertion): Promise<Response> {
  let eventId: string | null = null;
  try {
    const url = new URL(request.url);
    if (env.EXPECTED_HOST && url.hostname !== env.EXPECTED_HOST) return json(421,{error:"unexpected-host"});
    await accessVerifier(request,env);
    if (request.method === "GET" && url.pathname === "/health") {
      const state = await env.OPS_DB.prepare("SELECT last_event_at,last_access_success_at,last_access_error,access_consecutive_failures,access_circuit_open_until,updated_at FROM integration_reconciliation WHERE projection_source_id=? AND integration='project-alpha'").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId).first();
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
    // The authenticated deployment is the primary producer. Neither application
    // keys, body properties nor request headers select another projection source.
    const event = parseIntegrationEvent(parsed,env.APPLICATION_KEY);
    eventId = event.event_id;
    if (request.headers.get("X-PA-Event-ID") !== event.event_id) return json(422,{error:"event-id-mismatch"});
    const result = event.event_type === "projection.changed"
      ? await applyProjectionEvent(env,event,await sha256Hex(rawBody))
      : await applyEntitlementEvent(env,event,await sha256Hex(rawBody));
    if (result === "duplicate" || result === "ignored") return json(200,{ok:true,event_id:event.event_id,status:result});
    let accessMembers = 0;
    let accessPending = false;
    if (event.event_type !== "projection.changed") {
      try {
        if(await accessCircuitIsOpen(env))throw new Error("access-group-circuit-open");
        const emails = await reconcileAccessGroup(env);
        accessMembers = emails.length;
        await recordAccessSuccess(env);
      } catch (error) {
        const message = error instanceof Error?error.message:"access-group-error";
        if(message==="access-group-circuit-open")await recordEventFailure(env,event.event_id,message);
        else await recordAccessFailure(env,event.event_id,message);
        console.error(JSON.stringify({event:"ops_sync_access_reconciliation_pending",error:message}));
        accessPending = true;
      }
    }
    await completeEvent(env,event,accessPending);
    return json(accessPending?202:200,{ok:true,event_id:event.event_id,status:accessPending?"completed-access-reconciliation-pending":"completed",access_members:accessMembers});
  } catch (error) {
    const message = error instanceof ZodError ? "event-schema-invalid" : error instanceof SyntaxError ? "json-invalid" : error instanceof Error ? error.message : "internal-error";
    if(eventId)await recordEventFailure(env,eventId,message).catch(()=>undefined);
    console.error(JSON.stringify({event:"ops_sync_request_failed",error:message}));
    return json(errorStatus(error),{error:message});
  }
}

export async function reconcileScheduledAccess(env: Env): Promise<number> {
  try {
    if(await accessCircuitIsOpen(env))throw new Error("access-group-circuit-open");
    const emails = await reconcileAccessGroup(env);
    await recordAccessSuccess(env);
    return emails.length;
  } catch (error) {
    const message = error instanceof Error?error.message:"access-group-error";
    if(message!=="access-group-circuit-open")await recordAccessFailure(env,null,message);
    console.error(JSON.stringify({event:"ops_sync_scheduled_access_reconciliation_failed",error:message}));
    throw error;
  }
}

export default {
  fetch(request,env): Promise<Response> { return handleRequest(request,env); },
  scheduled(_event,env,ctx): void { ctx.waitUntil(reconcileScheduledAccess(env)); },
} satisfies ExportedHandler<Env>;
