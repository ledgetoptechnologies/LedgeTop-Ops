import { HTTPException } from "hono/http-exception";
import { PRIMARY_ALPHA_SOURCE_ID, projectAlphaSourceName } from "@ltds/shared";
import { authenticatedDeliveryGrantsEnabled, searchAuthenticatedDeliveryGrantAudiencesForFolder } from "./authenticated-delivery-grants";
import { nativeDeliveryBindingsReady, searchNativeShareRecipients } from "./native-delivery-bindings";
import type { Env, StaffPrincipal } from "./types";

/** Which existing grant back end owns a recipient. Derived on the server from
 * the recipient's workspace source, never from browser input. */
export type ClientShareBackend = "primary" | "native";
export type ClientShareAudienceType = "principal" | "department" | "organization" | "client" | "project";
export type ClientShareBackendState = "ready" | "link_required" | "not_permitted" | "unavailable";
export interface ClientShareRecipient {
  /** Stable selection key built only from ids. */
  key: string;
  backend: ClientShareBackend;
  sourceId: string;
  divisionLabel: string;
  workspaceId: string;
  workspaceName: string;
  audienceType: ClientShareAudienceType;
  publicId: string;
  displayName: string;
  email: string | null;
  /** Primary only: the folder's own binding, as the primary panel already loads it. */
  folderBindingId?: string;
  /** Non-primary only: projects this exact person can be granted on for this folder. */
  projects?: Array<{ projectId: string; projectName: string; projectEndSupported: boolean }>;
}
export interface ClientShareRecipientSearch {
  recipients: ClientShareRecipient[];
  primary: ClientShareBackendState;
  native: ClientShareBackendState;
  truncated: boolean;
}

/** The audience kinds the share dialog offered before; project-wide audiences
 * stay out so nothing is shared more widely than the old picker allowed. */
const AUDIENCE_TYPES = new Set<ClientShareAudienceType>(["principal", "department", "organization", "client"]);
export const clientShareRecipientKey = (backend: ClientShareBackend, sourceId: string, workspaceId: string, type: ClientShareAudienceType, publicId: string) =>
  JSON.stringify([backend, sourceId, workspaceId, type, publicId]);

/** The back end a source belongs to. Exactly one for every source id. */
export function clientShareBackendForSource(sourceId: string): ClientShareBackend {
  return sourceId === PRIMARY_ALPHA_SOURCE_ID ? "primary" : "native";
}

function stateFor(cause: unknown, notLinked: boolean): ClientShareBackendState {
  if (!(cause instanceof HTTPException)) throw cause;
  if (cause.status === 403) return "not_permitted";
  if (cause.status === 404) return notLinked ? "link_required" : "unavailable";
  if (cause.status === 409 || cause.status === 503) return "unavailable";
  throw cause;
}

export interface ClientShareRecipientDependencies {
  primaryEnabled: (env: Env) => boolean;
  searchPrimary: typeof searchAuthenticatedDeliveryGrantAudiencesForFolder;
  nativeReady: typeof nativeDeliveryBindingsReady;
  searchNative: typeof searchNativeShareRecipients;
}
// Resolved at call time so modules that stub these back ends still load this one.
const defaults: ClientShareRecipientDependencies = {
  primaryEnabled: env => authenticatedDeliveryGrantsEnabled(env),
  searchPrimary: (...args) => searchAuthenticatedDeliveryGrantAudiencesForFolder(...args),
  nativeReady: env => nativeDeliveryBindingsReady(env),
  searchNative: (...args) => searchNativeShareRecipients(...args),
};

/** Read-only recipient discovery across both existing grant back ends. Each
 * half runs the back end's own search, so each keeps its own permission rule:
 * division-scoped `delivery.share.create` for the primary source, global
 * administrator/owner or view-all plus folder-division permissions for the
 * others. A failed or forbidden half contributes no rows. */
export async function searchClientShareRecipients(env: Env, principal: StaffPrincipal, folderRef: string, folderKey: string, queryValue: string,
  deps: ClientShareRecipientDependencies = defaults): Promise<ClientShareRecipientSearch> {
  const query = queryValue.normalize("NFC").trim();
  if (query.length < 2 || query.length > 100) throw new HTTPException(400, { message: "Recipient search is invalid" });
  const recipients: ClientShareRecipient[] = [];
  let primary: ClientShareBackendState = "unavailable", native: ClientShareBackendState = "unavailable", truncated = false;

  if (deps.primaryEnabled(env)) {
    try {
      const result = await deps.searchPrimary(env, principal, folderKey, query);
      primary = "ready";
      for (const audience of result.audiences) {
        if (!AUDIENCE_TYPES.has(audience.type)) continue;
        recipients.push({ key: clientShareRecipientKey("primary", PRIMARY_ALPHA_SOURCE_ID, result.workspaceId, audience.type, audience.publicId),
          backend: "primary", sourceId: PRIMARY_ALPHA_SOURCE_ID, divisionLabel: projectAlphaSourceName(PRIMARY_ALPHA_SOURCE_ID),
          workspaceId: result.workspaceId, workspaceName: result.workspaceLabel, audienceType: audience.type, publicId: audience.publicId,
          displayName: audience.displayName, email: audience.type === "principal" ? audience.email ?? null : null, folderBindingId: result.folderBindingId });
      }
      truncated ||= result.audiences.length >= 20;
    } catch (cause) {
      // The primary list already answers "not bound" before its permission
      // check; only that exact case is reported as a link step.
      primary = stateFor(cause, cause instanceof HTTPException && cause.message === "This folder is not bound to a client workspace");
    }
  }

  if (await deps.nativeReady(env)) {
    try {
      const result = await deps.searchNative(env, principal, folderRef, query);
      native = "ready";
      for (const person of result.recipients) {
        if (clientShareBackendForSource(person.sourceId) !== "native" || !person.projects.length) continue;
        recipients.push({ key: clientShareRecipientKey("native", person.sourceId, person.workspaceId, "principal", person.principalPublicId),
          backend: "native", sourceId: person.sourceId, divisionLabel: projectAlphaSourceName(person.sourceId), workspaceId: person.workspaceId,
          workspaceName: person.workspaceName, audienceType: "principal", publicId: person.principalPublicId, displayName: person.displayName,
          email: person.email, projects: person.projects });
      }
      truncated ||= result.truncated;
    } catch (cause) {
      native = stateFor(cause, false);
    }
  }

  recipients.sort((left, right) => left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" })
    || left.divisionLabel.localeCompare(right.divisionLabel) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return { recipients, primary, native, truncated };
}
