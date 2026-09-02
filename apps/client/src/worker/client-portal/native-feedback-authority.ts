import type { Env } from "../types";
import type { NativePortalReadContext } from "./workspace-v2";

const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SOURCE_IDS = 32;
const MAX_CONFIG_LENGTH = 4096;

/**
 * Deploy-managed stopgap for native feedback while Project Alpha does not yet
 * publish an independently signed feedback capability. Malformed or oversized
 * configuration fails closed for every source.
 */
export function nativeFeedbackSourceIds(env: Pick<Env, "CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS">): ReadonlySet<string> {
  const raw = env.CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS?.trim() ?? "";
  if (!raw || raw.length > MAX_CONFIG_LENGTH) return new Set();
  const values = raw.split(",").map(value => value.trim());
  if (!values.length || values.length > MAX_SOURCE_IDS
    || values.some(value => value === "project-alpha:primary" || !SOURCE_ID.test(value))) return new Set();
  const unique = new Set(values);
  return unique.size === values.length ? unique : new Set();
}

export function nativeFeedbackEnabledForSource(
  env: Pick<Env, "CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS">,
  sourceId: string,
): boolean {
  return nativeFeedbackSourceIds(env).has(sourceId);
}

/** Call only with a freshly resolved native workspace context. */
export function nativeFeedbackEnabledForContext(
  env: Pick<Env, "CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS">,
  context: NativePortalReadContext,
): boolean {
  return nativeFeedbackEnabledForSource(env, context.sourceId);
}

const NOTIFICATION_SCHEMA_CACHE_MS = 30_000;
const notificationSchemaCache = new WeakMap<object, { checkedAt: number; ready: boolean }>();
const notificationColumns = [
  "id", "feedback_id", "feedback_revision", "source_id", "workspace_id", "recipient_identity_id",
  "principal_issuer", "principal_subject", "read_at", "dismissed_at", "created_at",
] as const;

/** Exact expand-contract probe for migration 0188. */
export async function nativeFeedbackNotificationsSchemaAvailable(
  env: Pick<Env, "DELIVERY_DB">,
  options: { refresh?: boolean; now?: number } = {},
): Promise<boolean> {
  const key = env.DELIVERY_DB as unknown as object;
  const now = options.now ?? Date.now();
  const cached = notificationSchemaCache.get(key);
  if (!options.refresh && cached && now - cached.checkedAt < NOTIFICATION_SCHEMA_CACHE_MS) return cached.ready;
  let ready = false;
  try {
    const db = env.DELIVERY_DB.withSession?.("first-primary") ?? env.DELIVERY_DB;
    const objects = await db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (
      'portal_native_feedback_notifications',
      'portal_native_feedback_notification_completion',
      'portal_native_feedback_notification_identity_immutable')`).all<{ type: string; name: string }>();
    const present = new Set(objects.results.map(row => `${row.type}:${row.name}`));
    if (present.has("table:portal_native_feedback_notifications")
      && present.has("trigger:portal_native_feedback_notification_completion")
      && present.has("trigger:portal_native_feedback_notification_identity_immutable")) {
      const columns = await db.prepare("PRAGMA table_info(portal_native_feedback_notifications)").all<{ name: string }>();
      const names = new Set(columns.results.map(row => row.name));
      ready = notificationColumns.every(name => names.has(name));
    }
  } catch {
    ready = false;
  }
  notificationSchemaCache.set(key, { checkedAt: now, ready });
  return ready;
}
