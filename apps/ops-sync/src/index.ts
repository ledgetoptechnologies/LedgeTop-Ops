import { ZodError } from "zod";
import { reconcileAccessGroup } from "./access-group";
import { accessCircuitIsOpen, completeEvent, applyEntitlementEventForSource, applyProjectionEventForSource, recordAccessFailure, recordAccessSuccess, recordEventFailure, routeDeliveryIntentEventForSource, routePortalProjectionEventForSource } from "./projection";
import { parseIntegrationEvent } from "./schema";
import { readWebhookBody, requireAccessServiceTokenIdentity, sha256Hex, validateRequestTimestamp, verifyAccessAssertion, verifyWebhookSignature, type AccessEnvironment } from "./security";
import type { Env } from "./types";
import { clientPortalProjectionFailureDiagnostic } from "./client-portal-projection-diagnostic";
import { PRIMARY_PROJECT_ALPHA_SOURCE, type ProjectAlphaSourceContext } from "../../operations/src/worker/project-alpha-source";
import { assertProjectAlphaConnectorProof, ProjectAlphaConnectorError, resolveProjectAlphaConnector, type ProjectAlphaConnectorProof } from "../../operations/src/worker/project-alpha-connectors";

type AccessVerifier = (request: Request, env: AccessEnvironment) => Promise<unknown>;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "internal-error";
  if (error instanceof ProjectAlphaConnectorError) return error.code === "invalid" ? 400 : error.code === "changed" || error.code === "conflict" ? 409 : 503;
  if (message.includes("pa_connector_active_revision_guard")) return 409;
  if (error instanceof SyntaxError) return 400;
  if (message === "payload-too-large" || message === "payload-size-invalid") return 413;
  if (message === "payload-read-timeout") return 408;
  if (message.startsWith("project-alpha-connector-")) return 409;
  if (message === "projection-source-authority-unsupported") return 403;
  if (message === "event-id-conflict") return 409;
  if (message === "projection-entity-busy" || message === "projection-global-busy") return 503;
  if (message === "client-portal-binding-unavailable" || message === "client-portal-forward-failed") return 503;
  if (message === "operations-delivery-binding-unavailable" || message === "operations-delivery-forward-failed") return 503;
  if (message === "operations-delivery-authority-conflict") return 409;
  if (message === "operations-delivery-intent-rejected") return 422;
  if (message === "client-portal-projection-rejected") return 422;
  if (message.startsWith("access-group-")) return 503;
  if (error instanceof ZodError || message.includes("mismatch")) return 422;
  if (message.startsWith("projection-data-")) return 422;
  if (message.includes("required") || message.includes("invalid")) return 401;
  return 500;
}

export async function handleRequest(request: Request, env: Env, accessVerifier: AccessVerifier = verifyAccessAssertion): Promise<Response> {
  let eventId: string | null = null;
  let source: ProjectAlphaSourceContext | undefined;
  let proof: ProjectAlphaConnectorProof | undefined;
  try {
    const url = new URL(request.url);
    if (env.EXPECTED_HOST && url.hostname !== env.EXPECTED_HOST) return json(421,{error:"unexpected-host"});
    if (request.method === "GET" && url.pathname === "/health") {
      await accessVerifier(request,env);
      const state = await env.OPS_DB.prepare("SELECT last_event_at,last_access_success_at,last_access_error,access_consecutive_failures,access_circuit_open_until,updated_at FROM integration_reconciliation WHERE projection_source_id=? AND integration='project-alpha'").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId).first();
      return json(200,{status:"ok",integration:state??null});
    }
    const sourceRoute = /^\/v1\/project-alpha\/sources\/([^/]+)\/events$/.exec(url.pathname);
    if (request.method !== "POST" || (url.pathname !== "/v1/project-alpha/events" && !sourceRoute)) return json(404,{error:"not-found"});
    // A route identifies a candidate configuration, not a trusted producer.
    // Only verified Access claims plus that candidate's signing key establish it.
    let candidateId = PRIMARY_PROJECT_ALPHA_SOURCE.sourceId;
    if (sourceRoute) {
      try { candidateId = decodeURIComponent(sourceRoute[1]!); }
      catch { return json(400,{error:"source-id-invalid"}); }
    }
    const candidate = await resolveProjectAlphaConnector(env,candidateId,"events");
    if (sourceRoute && candidate.proof.mode !== "registry") throw new Error("project-alpha-connector-enrollment-required");
    const eventConfig = candidate.event;
    if (candidate.proof.mode === "registry" && !eventConfig) throw new Error("project-alpha-connector-events-unavailable");
    const claims = await accessVerifier(request,eventConfig
      ? {TEAM_DOMAIN:eventConfig.accessIssuer,CF_ACCESS_AUD:eventConfig.accessAudience} : env);
    if (candidate.proof.mode === "registry") requireAccessServiceTokenIdentity(claims,eventConfig?.accessSubject ?? "");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json(415,{error:"content-type-required"});
    const rawBody = await readWebhookBody(request);
    const timestamp = validateRequestTimestamp(request.headers.get("X-PA-Timestamp"));
    if (candidate.proof.mode === "legacy_primary") await verifyWebhookSignature(
      rawBody,
      timestamp,
      request.headers.get("X-PA-Signature-Ed25519"),
      env.PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY,
      env.PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY,
      request.headers.get("X-PA-Signature"),
      env.PROJECT_ALPHA_WEBHOOK_HMAC_SECRET,
      env.PROJECT_ALPHA_ALLOW_LEGACY_HMAC === "true",
    );
    else {
      if (!eventConfig) throw new Error("project-alpha-connector-events-unavailable");
      const current = eventConfig.current;
      const previous = eventConfig.previous;
      if (!candidate.source.staffAuthority && (current.algorithm !== "ed25519" || (previous && previous.algorithm !== "ed25519"))) {
        throw new Error("project-alpha-connector-signing-configuration-invalid");
      }
      // No fallback to deployment-wide keys for an enrolled source. Secondary
      // producers never accept HMAC, including during a signing-key rotation.
      const edCurrent = current.algorithm === "ed25519" ? current.value : undefined;
      const edPrevious = previous?.algorithm === "ed25519" ? previous.value : undefined;
      const hmac = current.algorithm === "hmac-sha256" ? current.value : previous?.algorithm === "hmac-sha256" ? previous.value : "";
      await verifyWebhookSignature(rawBody,timestamp,request.headers.get("X-PA-Signature-Ed25519"),edCurrent,edPrevious,
        request.headers.get("X-PA-Signature"),hmac,candidate.source.staffAuthority && Boolean(hmac),
        current.algorithm === "hmac-sha256" && previous?.algorithm === "hmac-sha256" ? previous.value : undefined);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(rawBody)); }
    catch { throw new SyntaxError("json-invalid"); }
    const event = parseIntegrationEvent(parsed,eventConfig?.applicationKey ?? env.APPLICATION_KEY);
    if (request.headers.get("X-PA-Event-ID") !== event.event_id) return json(422,{error:"event-id-mismatch"});
    if (!candidate.source.staffAuthority && event.event_type !== "projection.changed" && event.event_type !== "portal.projection" && event.event_type !== "delivery.intent")
      throw new Error("projection-source-authority-unsupported");
    await assertProjectAlphaConnectorProof(env,candidate.proof);
    source = candidate.source;
    const authenticatedSource=source;
    proof = candidate.proof;
    eventId = event.event_id;
    const payloadHash=await sha256Hex(rawBody);
    if(event.event_type==="delivery.intent"){
      const routed=await routeDeliveryIntentEventForSource(env,source,event,payloadHash,async()=>{
        if(!env.OPERATIONS_DELIVERY_INTENT_INGRESS)throw new Error("operations-delivery-binding-unavailable");
        let forwarded:Awaited<ReturnType<NonNullable<typeof env.OPERATIONS_DELIVERY_INTENT_INGRESS>["ingestProjectAlphaDeliveryIntent"]>>;
        try{forwarded=await env.OPERATIONS_DELIVERY_INTENT_INGRESS.ingestProjectAlphaDeliveryIntent({protocolVersion:1,
          sourceId:authenticatedSource.sourceId,applicationKey:event.application_key,deliveryId:event.intent.deliveryId as string,
          intentKind:event.intent_kind,body:JSON.stringify(event.intent),connectorProof:{revision:proof!.revision,version:proof!.version}});}
        catch{throw new Error("operations-delivery-forward-failed");}
        if(!forwarded.ok)throw new Error(forwarded.code==="authority_or_state_conflict"?"operations-delivery-authority-conflict":
          forwarded.retryable?"operations-delivery-forward-failed":"operations-delivery-intent-rejected");
        return forwarded.result;
      },proof);
      if(routed.status==="applied")await completeEvent(env,event,false,source,proof);
      return json(200,{ok:true,event_id:event.event_id,status:routed.status==="applied"?"completed":"duplicate",result:routed.result});
    }
    const result = event.event_type === "projection.changed"
      ? await applyProjectionEventForSource(env,source,event,payloadHash,proof)
      : event.event_type === "portal.projection"
        ? await routePortalProjectionEventForSource(env,source,event,payloadHash,async()=>{
          if(!env.CLIENT_PORTAL_PROJECTION_INGRESS){
            console.error(JSON.stringify(clientPortalProjectionFailureDiagnostic({projectionKind:event.projection_kind,
              sourceId:authenticatedSource.sourceId,eventId:event.event_id,phase:"transport",retryable:true})));
            throw new Error("client-portal-binding-unavailable");
          }
          const body=JSON.stringify(event.projection);
          if(typeof body!=="string")throw new Error("client-portal-projection-rejected");
          const deliveryId=event.projection&&typeof event.projection==="object"&&"deliveryId" in event.projection
            ? (event.projection as {deliveryId?:unknown}).deliveryId:undefined;
          if(typeof deliveryId!=="string"||deliveryId!==event.event_id)throw new Error("client-portal-projection-rejected");
          let forwarded:Awaited<ReturnType<NonNullable<typeof env.CLIENT_PORTAL_PROJECTION_INGRESS>["ingestProjectAlphaPortalProjection"]>>;
          try{forwarded=await env.CLIENT_PORTAL_PROJECTION_INGRESS.ingestProjectAlphaPortalProjection({protocolVersion:1,
            sourceId:authenticatedSource.sourceId,applicationKey:event.application_key,deliveryId,projectionKind:event.projection_kind,body});}
          catch{
            console.error(JSON.stringify(clientPortalProjectionFailureDiagnostic({projectionKind:event.projection_kind,
              sourceId:authenticatedSource.sourceId,eventId:event.event_id,phase:"transport",retryable:true})));
            throw new Error("client-portal-forward-failed");
          }
          if(!forwarded.ok){
            console.error(JSON.stringify(clientPortalProjectionFailureDiagnostic({projectionKind:event.projection_kind,
              sourceId:authenticatedSource.sourceId,eventId:event.event_id,phase:"receiver",receiverCode:forwarded.code,
              retryable:forwarded.retryable})));
            throw new Error(forwarded.retryable?"client-portal-forward-failed":"client-portal-projection-rejected");
          }
        },proof)
        : await applyEntitlementEventForSource(env,source,event,payloadHash,proof);
    if (result === "duplicate" || result === "ignored") {
      await assertProjectAlphaConnectorProof(env,proof);
      return json(200,{ok:true,event_id:event.event_id,status:result});
    }
    let accessMembers = 0;
    let accessPending = false;
    if (event.event_type !== "projection.changed" && event.event_type !== "portal.projection") {
      try {
        if(await accessCircuitIsOpen(env))throw new Error("access-group-circuit-open");
        await assertProjectAlphaConnectorProof(env,proof);
        const emails = await reconcileAccessGroup(env,() => assertProjectAlphaConnectorProof(env,candidate.proof));
        accessMembers = emails.length;
        await recordAccessSuccess(env,proof);
      } catch (error) {
        const message = error instanceof Error?error.message:"access-group-error";
        if(message==="access-group-circuit-open")await recordEventFailure(env,event.event_id,message,source,proof);
        else await recordAccessFailure(env,event.event_id,message,proof);
        console.error(JSON.stringify({event:"ops_sync_access_reconciliation_pending",error:message}));
        accessPending = true;
      }
    }
    await completeEvent(env,event,accessPending,source,proof);
    return json(accessPending?202:200,{ok:true,event_id:event.event_id,status:accessPending?"completed-access-reconciliation-pending":"completed",access_members:accessMembers});
  } catch (error) {
    const message = error instanceof ZodError ? "event-schema-invalid" : error instanceof SyntaxError ? "json-invalid"
      : error instanceof ProjectAlphaConnectorError ? `project-alpha-connector-${error.code}`
      : error instanceof Error && error.message.includes("pa_connector_active_revision_guard") ? "project-alpha-connector-changed"
      : error instanceof Error ? error.message : "internal-error";
    if(eventId && source && proof)await recordEventFailure(env,eventId,message,source,proof).catch(()=>undefined);
    console.error(JSON.stringify({event:"ops_sync_request_failed",error:message}));
    return json(errorStatus(error),{error:message});
  }
}

export async function reconcileScheduledAccess(env: Env): Promise<number> {
  let proof: ProjectAlphaConnectorProof | undefined;
  try {
    const connector = await resolveProjectAlphaConnector(env,PRIMARY_PROJECT_ALPHA_SOURCE.sourceId,"events");
    proof = connector.proof;
    await assertProjectAlphaConnectorProof(env,proof);
    if(await accessCircuitIsOpen(env))throw new Error("access-group-circuit-open");
    const emails = await reconcileAccessGroup(env,() => assertProjectAlphaConnectorProof(env,connector.proof));
    await recordAccessSuccess(env,proof);
    return emails.length;
  } catch (error) {
    const message = error instanceof Error?error.message:"access-group-error";
    if(proof && message!=="access-group-circuit-open")await recordAccessFailure(env,null,message,proof).catch(()=>undefined);
    console.error(JSON.stringify({event:"ops_sync_scheduled_access_reconciliation_failed",error:message}));
    throw error;
  }
}

export default {
  fetch(request,env): Promise<Response> { return handleRequest(request,env); },
  scheduled(_event,env,ctx): void { ctx.waitUntil(reconcileScheduledAccess(env)); },
} satisfies ExportedHandler<Env>;
