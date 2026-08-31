import { z } from "zod";
import { SUPPORTED_ROLES, type EntitlementEvent, type IntegrationEvent, type ProjectionEvent } from "./types";

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

export function parseIntegrationEvent(value: unknown, applicationKey: string): IntegrationEvent {
  if (value && typeof value === "object" && (value as {event_type?:unknown}).event_type === "projection.changed") {
    const event = projectionEventSchema.parse(value) as ProjectionEvent;
    if (event.application_key !== applicationKey.trim().toLowerCase()) throw new Error("application-key-mismatch");
    return event;
  }
  return parseEntitlementEvent(value,applicationKey);
}
