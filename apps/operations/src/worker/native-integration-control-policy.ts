import { isNativeAccessSubject } from "./native-access-subject";

export const NATIVE_INTEGRATION_CONTROL_CAPABILITIES = Object.freeze([
  "integrations.monitor.manage",
  "integrations.alerts.reconcile",
] as const);
export type NativeIntegrationControlCapability = typeof NATIVE_INTEGRATION_CONTROL_CAPABILITIES[number];

type Actor = Readonly<{
  staffId: string;
  verifiedAccessSubject: string;
  boundAccessSubject: string;
  activeNativeAdmission: boolean;
}>;
type Grant = Readonly<{
  id: string;
  actorStaffId: string;
  capability: NativeIntegrationControlCapability;
  effect: "allow" | "deny";
  scopeKind: "global";
  active: boolean;
}>;
export type NativeIntegrationControlPolicyRequest = Readonly<{
  actor: Actor;
  capability: NativeIntegrationControlCapability;
  grants: readonly Grant[];
}>;
export type NativeIntegrationControlPolicyDecision = Readonly<{
  allowed: boolean;
  reason: "allowed" | "invalid_input" | "not_native_admitted" | "subject_mismatch"
    | "explicit_deny" | "no_matching_allow";
  matchingAllowGrantIds: readonly string[];
  matchingDenyGrantIds: readonly string[];
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const actorKeys = ["staffId", "verifiedAccessSubject", "boundAccessSubject", "activeNativeAdmission"] as const;
const grantKeys = ["id", "actorStaffId", "capability", "effect", "scopeKind", "active"] as const;

function record(raw: unknown, expected: readonly string[]): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== expected.length || keys.some(key => typeof key !== "string" || !expected.includes(key)))
    return null;
  const values: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    values[key] = descriptor.value;
  }
  return values;
}

function array(raw: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return null;
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== length + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function id(value: unknown): value is string {
  return typeof value === "string" && ID.test(value) && !/\p{C}/u.test(value);
}

function capability(value: unknown): value is NativeIntegrationControlCapability {
  return value === "integrations.monitor.manage" || value === "integrations.alerts.reconcile";
}

function snapshot(raw: unknown): NativeIntegrationControlPolicyRequest | null {
  const input = record(raw, ["actor", "capability", "grants"]);
  if (!input || !capability(input.capability)) return null;
  const actor = record(input.actor, actorKeys);
  if (!actor || !id(actor.staffId) || !isNativeAccessSubject(actor.verifiedAccessSubject)
    || !isNativeAccessSubject(actor.boundAccessSubject)
    || typeof actor.activeNativeAdmission !== "boolean") return null;
  const rows = array(input.grants, 512);
  if (!rows) return null;
  const grants: Grant[] = [];
  const ids = new Set<string>();
  for (const rawGrant of rows) {
    const row = record(rawGrant, grantKeys);
    if (!row || !id(row.id) || ids.has(row.id) || !id(row.actorStaffId)
      || !capability(row.capability) || (row.effect !== "allow" && row.effect !== "deny")
      || row.scopeKind !== "global" || typeof row.active !== "boolean") return null;
    ids.add(row.id);
    grants.push(Object.freeze({ id: row.id, actorStaffId: row.actorStaffId,
      capability: row.capability, effect: row.effect, scopeKind: "global", active: row.active }));
  }
  return Object.freeze({ actor: Object.freeze({ staffId: actor.staffId,
    verifiedAccessSubject: actor.verifiedAccessSubject, boundAccessSubject: actor.boundAccessSubject,
    activeNativeAdmission: actor.activeNativeAdmission }), capability: input.capability,
  grants: Object.freeze(grants) });
}

function decision(reason: NativeIntegrationControlPolicyDecision["reason"],
  allowIds: readonly string[] = [], denyIds: readonly string[] = []): NativeIntegrationControlPolicyDecision {
  return Object.freeze({ allowed: reason === "allowed", reason,
    matchingAllowGrantIds: Object.freeze([...allowIds].sort()),
    matchingDenyGrantIds: Object.freeze([...denyIds].sort()) });
}

/** Advisory only. The control writer must recheck current native admission,
 * exact subject and global grants in its own commit-time SQL fence. This
 * function does not bootstrap authority from a PA role, email or owner flag. */
export function evaluateNativeIntegrationControlPolicy(raw: unknown): NativeIntegrationControlPolicyDecision {
  let input: NativeIntegrationControlPolicyRequest | null;
  try { input = snapshot(raw); } catch { return decision("invalid_input"); }
  if (!input) return decision("invalid_input");
  if (!input.actor.activeNativeAdmission) return decision("not_native_admitted");
  if (input.actor.verifiedAccessSubject !== input.actor.boundAccessSubject) return decision("subject_mismatch");
  const matching = input.grants.filter(grant => grant.active && grant.actorStaffId === input.actor.staffId
    && grant.capability === input.capability);
  const allows = matching.filter(grant => grant.effect === "allow").map(grant => grant.id);
  const denies = matching.filter(grant => grant.effect === "deny").map(grant => grant.id);
  if (denies.length) return decision("explicit_deny", allows, denies);
  return allows.length ? decision("allowed", allows) : decision("no_matching_allow");
}
