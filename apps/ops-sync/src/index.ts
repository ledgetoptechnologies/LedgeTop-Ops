import { ZodError } from "zod";
import { reconcileAccessGroup } from "./access-group";
import { completeEvent, applyEntitlementEvent, recordAccessFailure } from "./projection";
import { parseEntitlementEvent } from "./schema";
import { MAX_BODY_BYTES, sha256Hex, validateRequestTimestamp, verifyAccessAssertion, verifyWebhookHmac } from "./security";
import type { Env } from "./types";

type AccessVerifier = (request: Request, env: Env) => Promise<unknown>;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "internal-error";
  if (error instanceof SyntaxError) return 400;
  if (message === "event-id-conflict") return 409;
  if (message.startsWith("access-group-")) return 503;
  if (error instanceof ZodError || message.includes("mismatch")) return 422;
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
    await verifyWebhookHmac(rawBody,timestamp,request.headers.get("X-PA-Signature"),env.PROJECT_ALPHA_WEBHOOK_HMAC_SECRET);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
    const event = parseEntitlementEvent(parsed,env.APPLICATION_KEY);
    if (request.headers.get("X-PA-Event-ID") !== event.event_id) return json(422,{error:"event-id-mismatch"});
    const result = await applyEntitlementEvent(env,event,await sha256Hex(rawBody));
    if (result === "duplicate" || result === "ignored") return json(200,{ok:true,event_id:event.event_id,status:result});
    try {
      const emails = await reconcileAccessGroup(env);
      await completeEvent(env,event);
      return json(200,{ok:true,event_id:event.event_id,status:"completed",access_members:emails.length});
    } catch (error) {
      const message = error instanceof Error?error.message:"access-group-error";
      await recordAccessFailure(env,event.event_id,message);
      throw error;
    }
  } catch (error) {
    const message = error instanceof ZodError ? "event-schema-invalid" : error instanceof SyntaxError ? "json-invalid" : error instanceof Error ? error.message : "internal-error";
    console.error(JSON.stringify({event:"ops_sync_request_failed",error:message}));
    return json(errorStatus(error),{error:message});
  }
}

export default {
  fetch(request,env): Promise<Response> { return handleRequest(request,env); },
} satisfies ExportedHandler<Env>;
