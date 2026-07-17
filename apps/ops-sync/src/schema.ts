import { z } from "zod";
import { SUPPORTED_ROLES, type EntitlementEvent } from "./types";

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
    display_name: z.string().trim().min(1).max(200),
    active: z.boolean(),
  }).strict(),
  entitlement: z.object({
    application_key: z.string().trim().min(2).max(64).regex(/^[a-z0-9][a-z0-9_-]+$/),
    enabled: z.boolean(),
    role_key: z.enum(SUPPORTED_ROLES),
    business_unit_ids: z.array(identifier).max(500).transform((ids) => [...new Set(ids)].sort()),
  }).strict(),
}).strict();

export function parseEntitlementEvent(value: unknown, applicationKey: string): EntitlementEvent {
  const event = eventSchema.parse(value);
  if (event.entitlement.application_key !== applicationKey) throw new Error("application-key-mismatch");
  return event;
}
