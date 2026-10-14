import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Env, StaffPrincipal } from "./types";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import {
  prepareNativeProjectLifecycle,
  retireNativeProjectLifecycleForInboundReview,
  abandonNativeProjectLifecyclePreparation,
  submitNativeProjectLifecycle,
  prepareNativeProjectLifecycleRefresh,
  submitNativeProjectLifecycleRefresh,
  activateNativeProjectLifecycle,
  readNativeProjectLifecycleStatus,
  type LifecycleContext,
} from "./native-project-lifecycle";
const id = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
  expectedContextVersion: z.string().min(1).max(256),
  commandId: id,
};
export const nativeLifecyclePrepareSchema = z
  .object({
    ...common,
    externalProjectId: z.string().min(1).max(191),
    action: z.enum(["archive", "restore"]),
  })
  .strict();
export const nativeLifecycleSubmitSchema = z
  .object({ ...common, reviewSha256: hash, reconcile: z.boolean() })
  .strict();
export const nativeLifecycleRefreshPrepareSchema = z
  .object({ ...common, refreshCommandId: id, reviewSha256: hash })
  .strict();
export const nativeLifecycleRefreshSubmitSchema = nativeLifecycleSubmitSchema
  .extend({ refreshCommandId: id })
  .strict();
export const nativeLifecycleActivateSchema = z
  .object({ ...common, reviewSha256: hash })
  .strict();
export type NativeLifecycleOperation =
  | "prepare"
  | "submit"
  | "refresh-prepare"
  | "refresh-submit"
  | "activate"
  | "abandon-preparation"
  | "abandon-refresh-preparation"
  | "retire-for-inbound-review";
async function authenticate(
  env: Env,
  request: Request,
  principal: StaffPrincipal,
  context: ClientHubCollectionContext,
) {
  if (
    context.root.root_namespace !== "business" ||
    !["organization", "standalone_client"].includes(context.root.kind) ||
    !context.root.source_id.startsWith("project-alpha:")
  )
    throw new HTTPException(403, {
      message: "Exact native project owner context is required",
    });
  const auth = await authenticateNativeStaffWithAdmissionVersion(
    request,
    env.OPS_DB,
    {
      enabled: true,
      issuer: env.TEAM_DOMAIN ?? "",
      staffAudience: env.OPERATIONS_AUD,
    },
  );
  const a = auth.identity;
  if (
    a.staffId !== principal.id ||
    a.email !== principal.email ||
    a.verifiedAccessSubject !== principal.accessSubject
  )
    throw new HTTPException(403, {
      message: "Native and Operations staff identities must match",
    });
  return {
    actor: {
      staffId: a.staffId,
      accessSubject: a.verifiedAccessSubject,
      email: a.email,
      admissionVersion: auth.admissionVersion,
      profileVersion: a.profileVersion,
      verifiedUntil: auth.verifiedUntil,
    },
    owner: {
      sourceId: context.root.source_id,
      rootKind: context.root.kind as LifecycleContext["rootKind"],
      rootPublicId: context.root.public_id,
      contextVersion: context.contextVersion,
    },
  };
}
export async function mutateClientHubNativeLifecycle(
  env: Env,
  request: Request,
  principal: StaffPrincipal,
  context: ClientHubCollectionContext,
  operation: NativeLifecycleOperation,
  raw: unknown,
  send: typeof fetch = fetch,
  beforePost: () => Promise<void> = async () => {},
) {
  const selected =
    operation === "prepare"
      ? nativeLifecyclePrepareSchema
      : operation === "submit"
        ? nativeLifecycleSubmitSchema
        : operation === "refresh-prepare"
          ? nativeLifecycleRefreshPrepareSchema
          : operation === "refresh-submit"
            ? nativeLifecycleRefreshSubmitSchema
            : operation === "abandon-refresh-preparation"
              ? nativeLifecycleRefreshPrepareSchema
              : nativeLifecycleActivateSchema;
  const parsed = selected.safeParse(raw);
  if (!parsed.success)
    throw new HTTPException(400, {
      message: "Native lifecycle request is invalid",
    });
  if (parsed.data.expectedContextVersion !== context.contextVersion)
    throw new HTTPException(409, { message: "Owner context changed" });
  const { actor, owner } = await authenticate(env, request, principal, context);
  if (operation === "retire-for-inbound-review")
    return retireNativeProjectLifecycleForInboundReview(
      env,
      actor,
      owner,
      nativeLifecycleActivateSchema.parse(raw),
      send,
    );
  if (operation === "abandon-preparation")
    return abandonNativeProjectLifecyclePreparation(
      env,
      actor,
      owner,
      nativeLifecycleActivateSchema.parse(raw),
    );
  if (operation === "abandon-refresh-preparation")
    return abandonNativeProjectLifecyclePreparation(
      env,
      actor,
      owner,
      nativeLifecycleRefreshPrepareSchema.parse(raw),
    );
  if (operation === "prepare")
    return prepareNativeProjectLifecycle(
      env,
      actor,
      owner,
      nativeLifecyclePrepareSchema.parse(raw),
      send,
    );
  if (operation === "submit")
    return submitNativeProjectLifecycle(
      env,
      actor,
      owner,
      nativeLifecycleSubmitSchema.parse(raw),
      send,
      beforePost,
    );
  if (operation === "refresh-prepare")
    return prepareNativeProjectLifecycleRefresh(
      env,
      actor,
      owner,
      nativeLifecycleRefreshPrepareSchema.parse(raw),
      send,
    );
  if (operation === "refresh-submit")
    return submitNativeProjectLifecycleRefresh(
      env,
      actor,
      owner,
      nativeLifecycleRefreshSubmitSchema.parse(raw),
      send,
      beforePost,
    );
  return activateNativeProjectLifecycle(
    env,
    actor,
    owner,
    nativeLifecycleActivateSchema.parse(raw),
    send,
  );
}
export async function readClientHubNativeLifecycleStatus(
  env: Env,
  request: Request,
  principal: StaffPrincipal,
  context: ClientHubCollectionContext,
  commandId: string,
) {
  if (!id.safeParse(commandId).success)
    throw new HTTPException(400, {
      message: "Lifecycle command ID is invalid",
    });
  const { actor, owner } = await authenticate(env, request, principal, context);
  return readNativeProjectLifecycleStatus(env, actor, owner, commandId);
}
