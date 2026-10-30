/**
 * Unactivated v4 recipient capability grammar.
 *
 * This module only validates/canonicalizes request data; it grants no access.
 * The v3 authority parser and persisted v3 commands remain unchanged. Runtime
 * consumers must wait for the coordinated Ops/Client schema and owner-review
 * integration before using v4 values to authorize any request.
 */
export const OPERATIONS_PORTAL_NATIVE_RECIPIENT_CAPABILITY_SCHEMA_V4 = 4 as const;
export const OPERATIONS_PORTAL_NATIVE_RECIPIENT_HOME_PERMISSION = "operations.service_home.read" as const;
export const OPERATIONS_PORTAL_NATIVE_RECIPIENT_INQUIRY_PERMISSION = "operations.request.create" as const;

export type OperationsPortalNativeRecipientPermissionsV3 = readonly []
  | readonly [typeof OPERATIONS_PORTAL_NATIVE_RECIPIENT_HOME_PERMISSION];
export type OperationsPortalNativeRecipientPermissionsV4 = OperationsPortalNativeRecipientPermissionsV3
  | readonly [typeof OPERATIONS_PORTAL_NATIVE_RECIPIENT_INQUIRY_PERMISSION,
      typeof OPERATIONS_PORTAL_NATIVE_RECIPIENT_HOME_PERMISSION];
export type OperationsPortalNativeRecipientPermissions = OperationsPortalNativeRecipientPermissionsV4;
export type OperationsPortalNativeRecipientPermissionSchema = 3 | 4;
export type OperationsPortalNativeRecipientAction = "recipient.grant" | "recipient.revoke" | "workspace.revoke";

const HOME = OPERATIONS_PORTAL_NATIVE_RECIPIENT_HOME_PERMISSION;
const INQUIRY = OPERATIONS_PORTAL_NATIVE_RECIPIENT_INQUIRY_PERMISSION;
const encoder = new TextEncoder();
export type OperationsPortalNativeRecipientIssueRequest = Readonly<{
  operationId: string;
  targetId: string;
  targetClientRecordId: string;
  expiresAt: string;
  permissions: readonly [typeof HOME] | readonly [typeof INQUIRY, typeof HOME];
  permissionSchemaVersion: 3 | 4;
  legacyShape: boolean;
}>;

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key)
      || !descriptors[key]!.enumerable || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}

function exactPermissions(value: unknown): readonly string[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value)
      || Reflect.ownKeys(value).length !== length.value + 1) return null;
    const result: string[] = [];
    for (let index = 0; index < length.value; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") return null;
      result.push(descriptor.value);
    }
    return result;
  } catch { return null; }
}

/** Validate the action/version-specific permission list and freeze a copy. */
export function parseOperationsPortalNativeRecipientCapabilities(
  version: unknown, action: OperationsPortalNativeRecipientAction, input: unknown,
): OperationsPortalNativeRecipientPermissionsV3 | OperationsPortalNativeRecipientPermissionsV4 | null {
  const permissions = exactPermissions(input);
  if (!permissions || (version !== 3 && version !== 4)) return null;
  if (action !== "recipient.grant" && action !== "recipient.revoke" && action !== "workspace.revoke") return null;
  if (action !== "recipient.grant") {
    if (permissions.length !== 0) return null;
    return Object.freeze([] as const);
  }
  if (version === 3) {
    if (permissions.length !== 1 || permissions[0] !== HOME) return null;
    return Object.freeze([HOME] as const);
  }
  if (permissions.length === 2 && permissions[0] === INQUIRY && permissions[1] === HOME)
    return Object.freeze([INQUIRY, HOME] as const);
  return null;
}

/** Version is derived from the capability set; v3 remains home-only. */
export function operationsPortalNativeRecipientPermissionSchema(
  input: unknown,
): OperationsPortalNativeRecipientPermissionSchema | null {
  const permissions = exactPermissions(input);
  if (!permissions) return null;
  if (permissions.length === 1 && permissions[0] === HOME) return 3;
  if (permissions.length === 2 && permissions[0] === INQUIRY && permissions[1] === HOME) return 4;
  return null;
}

export function encodeOperationsPortalNativeRecipientCapabilities(
  version: unknown, action: OperationsPortalNativeRecipientAction, input: unknown,
): string | null {
  const parsed = parseOperationsPortalNativeRecipientCapabilities(version, action, input);
  return parsed ? JSON.stringify(parsed) : null;
}

export function parseOperationsPortalNativeRecipientCapabilitiesJson(
  version: unknown, action: OperationsPortalNativeRecipientAction, input: unknown,
): OperationsPortalNativeRecipientPermissionsV3 | OperationsPortalNativeRecipientPermissionsV4 | null {
  if (typeof input !== "string" || encoder.encode(input).byteLength > 256) return null;
  try { return parseOperationsPortalNativeRecipientCapabilities(version, action, JSON.parse(input)); }
  catch { return null; }
}

/**
 * Strict owner issue-intent request parser. The legacy four-field body is
 * preserved as v3 home-only. The five-field form must explicitly list one of
 * the allowed canonical sets; request.create is never inferred or defaulted.
 */
export function parseOperationsPortalNativeRecipientIssueRequest(input: unknown): OperationsPortalNativeRecipientIssueRequest | null {
  const legacy = exactObject(input, ["operationId", "targetId", "targetClientRecordId", "expiresAt"]);
  const current = legacy ? null : exactObject(input,
    ["operationId", "targetId", "targetClientRecordId", "expiresAt", "permissions"]);
  const body = legacy ?? current;
  if (!body || typeof body.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(body.operationId)
    || typeof body.targetId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(body.targetId)
    || typeof body.targetClientRecordId !== "string" || body.targetClientRecordId.length < 1
    || body.targetClientRecordId.length > 191 || body.targetClientRecordId.trim() !== body.targetClientRecordId
    || /\p{C}/u.test(body.targetClientRecordId) || body.targetClientRecordId.includes("\0")
    || typeof body.expiresAt !== "string"
    || body.expiresAt.length !== 24 || !Number.isFinite(Date.parse(body.expiresAt))
    || new Date(body.expiresAt).toISOString() !== body.expiresAt
    || Date.parse(body.expiresAt) <= Date.now() || Date.parse(body.expiresAt) > Date.now() + 7 * 86_400_000) return null;
  const permissions = legacy ? [HOME] as const
    : parseOperationsPortalNativeRecipientCapabilities(4, "recipient.grant", body.permissions)
      ?? parseOperationsPortalNativeRecipientCapabilities(3, "recipient.grant", body.permissions);
  if (!permissions || permissions.length === 0) return null;
  const permissionSchemaVersion = operationsPortalNativeRecipientPermissionSchema(permissions);
  if (!permissionSchemaVersion) return null;
  return Object.freeze({ operationId: body.operationId, targetId: body.targetId,
    targetClientRecordId: body.targetClientRecordId, expiresAt: body.expiresAt,
    permissions, permissionSchemaVersion, legacyShape: !!legacy });
}
