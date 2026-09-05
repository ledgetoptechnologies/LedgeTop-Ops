import { z } from "zod";
import { SUPPORTED_ROLES, type DeliveryIntentEvent, type EntitlementEvent, type IntegrationEvent, type PortalProjectionEvent, type ProjectionEvent } from "./types";

const normalizedEmail = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const identifier = z.union([z.string().trim().min(1).max(128), z.number().int().positive()]).transform(String);

const eventSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.enum(["application_entitlement.changed", "application_entitlement.revoked", "user.changed"]),
  occurred_at: z.string().datetime({ offset: true }),
  schema_version: z.literal(1),
  user: z.object({
    id: identifier,
    email: normalizedEmail,
    display_name: z.string().trim().min(1).max(255),
    active: z.boolean(),
  }).strict(),
  entitlement: z.object({
    application_key: z.string().trim().min(2).max(64).regex(/^[a-z0-9][a-z0-9_-]+$/),
    enabled: z.boolean(),
    role_key: z.enum(SUPPORTED_ROLES),
    business_unit_ids: z.array(identifier).max(500).transform((ids) => [...new Set(ids)].sort()),
    oversight_business_unit_ids: z.array(identifier).max(500).transform((ids) => [...new Set(ids)].sort()).optional(),
    manual_access: z.boolean().optional(),
    automatic_access: z.boolean().optional(),
    unit_oversight: z.boolean().optional(),
  }).strict(),
}).strict();

export function parseEntitlementEvent(value: unknown, applicationKey: string): EntitlementEvent {
  const event = eventSchema.parse(value);
  if (event.entitlement.application_key !== applicationKey.trim().toLowerCase()) throw new Error("application-key-mismatch");
  return event;
}

const projectionEventSchema = z.object({
  event_id: z.string().uuid(), event_type: z.literal("projection.changed"), occurred_at: z.string().datetime({ offset: true }), schema_version: z.literal(1),
  application_key: z.string().trim().min(2).max(64).regex(/^[a-z0-9][a-z0-9_-]+$/),
  projection: z.object({
    entity_type: z.enum(["client","organization","project","project_assignment","business_unit","operation","operation_assignment","task","task_assignment"]),
    entity_id: identifier, action: z.enum(["upsert","revoke"]), source_updated_at: z.string().datetime({ offset: true }), data: z.record(z.string(),z.unknown()),
  }).strict(),
}).strict();

const portalProjectionEventSchema = z.object({
  // Existing portal delivery IDs predate the UUID-only integration envelope.
  // Keep them source-qualified and bounded rather than rewriting their identity.
  event_id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  event_type: z.literal("portal.projection"),
  occurred_at: z.string().datetime({ offset: true }),
  schema_version: z.literal(1),
  application_key: z.string().trim().min(2).max(64).regex(/^[a-z0-9][a-z0-9_-]+$/),
  projection_kind: z.enum(["portal", "catalog", "service_assignments"]),
  projection: z.unknown(),
}).strict();

// The operation-qualified outer id remains below the integration receipt's
// 128-character ceiling without truncating the caller's identity.
const safeDeliveryId=z.string().trim().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const intentApplicationKey=z.string().trim().min(2).max(64).regex(/^[a-z0-9][a-z0-9_-]+$/);
const deliveryCommon=z.object({schemaVersion:z.literal(1),applicationKey:intentApplicationKey,
  deliveryId:safeDeliveryId,occurredAt:z.string().datetime({offset:true})}).strict();
const deliveryProvision=deliveryCommon.extend({
  scope:z.object({type:z.enum(["organization","department","client","project"]),publicId:safeDeliveryId}).strict(),
  audience:z.object({type:z.literal("principal"),publicId:safeDeliveryId}).strict(),
  accessMode:z.enum(["portal","guest"]),expiresAt:z.string().datetime({offset:true}).nullable(),
  label:z.string().trim().max(160).nullable(),notify:z.literal(true),
}).strict();
const deliveryRevoke=deliveryCommon.extend({receiptId:safeDeliveryId,
  reasonCode:z.literal("project_alpha_delivery_revoked")}).strict();
const deliveryIntentEventSchema=z.discriminatedUnion("intent_kind",[
  z.object({event_id:z.string().regex(/^delivery\.intent:preflight:[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/),event_type:z.literal("delivery.intent"),occurred_at:z.string().datetime({offset:true}),
    schema_version:z.literal(1),application_key:intentApplicationKey,intent_kind:z.literal("preflight"),intent:deliveryCommon}).strict(),
  z.object({event_id:z.string().regex(/^delivery\.intent:provision:[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/),event_type:z.literal("delivery.intent"),occurred_at:z.string().datetime({offset:true}),
    schema_version:z.literal(1),application_key:intentApplicationKey,intent_kind:z.literal("provision"),intent:deliveryProvision}).strict(),
  z.object({event_id:z.string().regex(/^delivery\.intent:revoke:[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/),event_type:z.literal("delivery.intent"),occurred_at:z.string().datetime({offset:true}),
    schema_version:z.literal(1),application_key:intentApplicationKey,intent_kind:z.literal("revoke"),intent:deliveryRevoke}).strict(),
]);

export function parseIntegrationEvent(value: unknown, applicationKey: string): IntegrationEvent {
  if (value && typeof value === "object" && (value as {event_type?:unknown}).event_type === "delivery.intent") {
    const event=deliveryIntentEventSchema.parse(value) as DeliveryIntentEvent;
    if(event.application_key!==applicationKey.trim().toLowerCase()||event.intent.applicationKey!==event.application_key)
      throw new Error("application-key-mismatch");
    if(event.event_id!==`delivery.intent:${event.intent_kind}:${event.intent.deliveryId}`)
      throw new Error("delivery-operation-id-mismatch");
    if(event.occurred_at!==event.intent.occurredAt)throw new Error("delivery-occurred-at-mismatch");
    return event;
  }
  if (value && typeof value === "object" && (value as {event_type?:unknown}).event_type === "portal.projection") {
    const event = portalProjectionEventSchema.parse(value) as PortalProjectionEvent;
    if (event.application_key !== applicationKey.trim().toLowerCase()) throw new Error("application-key-mismatch");
    return event;
  }
  if (value && typeof value === "object" && (value as {event_type?:unknown}).event_type === "projection.changed") {
    const event = projectionEventSchema.parse(value) as ProjectionEvent;
    if (event.application_key !== applicationKey.trim().toLowerCase()) throw new Error("application-key-mismatch");
    return event;
  }
  return parseEntitlementEvent(value,applicationKey);
}
