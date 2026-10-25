import { HTTPException } from "hono/http-exception";
import { d1ColumnPresent } from "../schema-readiness";
import type { Env } from "../types";
import { serializeServiceAssignmentPolicyProof, serviceAssignmentRequestPolicyEnabled,
  type ServiceAssignmentPolicyProof } from "./service-assignment-policy";

export const NATIVE_PROJECT_PROOF_COLUMN = "native_project_assignment_proof_v3_json";
export const NATIVE_PROJECT_REQUEST_NOT_READY = "NATIVE_PROJECT_REQUEST_NOT_READY";
export const NATIVE_PROJECT_REQUEST_NOT_READY_MESSAGE =
  "Project-specific requests are not available yet. Submit a general service request instead.";

export async function nativeProjectAssignmentStorageReady(env: Env): Promise<boolean> {
  const present = await Promise.all(["client_service_request_drafts", "client_service_requests"]
    .map(table => d1ColumnPresent(env.DELIVERY_DB, table, NATIVE_PROJECT_PROOF_COLUMN)));
  return present.every(Boolean);
}

function unavailable(): never {
  throw new HTTPException(503, { message: NATIVE_PROJECT_REQUEST_NOT_READY_MESSAGE,
    cause: { code: NATIVE_PROJECT_REQUEST_NOT_READY } });
}

/** Run before allocating storage or mutating an old-schema project draft. */
export async function requireNativeProjectAssignmentStorage(env: Env, projectId: string | null): Promise<void> {
  if (projectId !== null && serviceAssignmentRequestPolicyEnabled(env)
    && !await nativeProjectAssignmentStorageReady(env)) unavailable();
}

export function serializeNativeProjectAssignmentProof(proof: ServiceAssignmentPolicyProof): string {
  if (proof.nativeProject !== true || proof.subjectType !== "project" || proof.localProjectId !== null)
    throw new Error("Expected exact native-project assignment proof");
  // Preserve every provenance field. Version3 identifies storage;
  // live assignment checks continue to use the unchanged in-memory v2 proof.
  const stored = JSON.parse(serializeServiceAssignmentPolicyProof(proof)!);
  stored.version = 3;
  return JSON.stringify(stored);
}

/** Static SQL fragments only. General/legacy rows retain the original v2
 * column on old schemas. Once expanded, updates also clear the other proof so
 * a project/root edit cannot leave conflicting historical authority markers. */
export async function nativeRequestAssignmentStorage(env: Env, proof: ServiceAssignmentPolicyProof | null): Promise<{
  columns: string; placeholders: string; update: string; bindings: (string | null)[];
}> {
  const ready = await nativeProjectAssignmentStorageReady(env);
  const native = proof?.nativeProject === true;
  if (native && !ready) unavailable();
  const legacy = native ? null : serializeServiceAssignmentPolicyProof(proof);
  if (!ready) return { columns: "service_assignment_policy_v2_json", placeholders: "?",
    update: "service_assignment_policy_v2_json=?", bindings: [legacy] };
  return { columns: `service_assignment_policy_v2_json,${NATIVE_PROJECT_PROOF_COLUMN}`,
    placeholders: "?,?", update: `service_assignment_policy_v2_json=?,${NATIVE_PROJECT_PROOF_COLUMN}=?`,
    bindings: [legacy, native ? serializeNativeProjectAssignmentProof(proof!) : null] };
}
