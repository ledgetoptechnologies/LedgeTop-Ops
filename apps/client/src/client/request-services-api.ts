import { requestJson, type RequestError } from "./bulk-download";
import type { PortalAreaGeoJson, PortalPoi, PortalServiceQuestion, PortalServiceRequest } from "./portal-api";

/**
 * One service the signed-in client may ask for, across every account they're authorized for. The server
 * decides which business and account it belongs to; the browser only echoes the opaque serviceChoiceId.
 */
export interface RequestServiceChoice {
  serviceChoiceId: string;
  name: string;
  summary: string | null;
  category: "drone" | "website" | "other";
  clientName: string;
  questions: PortalServiceQuestion[];
  geometryRequirement: "none" | "optional" | "required";
}

export type InquiryKind = "website" | "drone" | "other";
export const INQUIRY_KINDS: readonly InquiryKind[] = ["website", "drone", "other"];
export const INQUIRY_KIND_LABEL: Record<InquiryKind, string> = { website: "Website", drone: "Drone", other: "Other" };

export interface RequestServices {
  services: RequestServiceChoice[];
  /** Accounts whose services couldn't be listed right now; their names are shown only to say so. */
  unavailable: string[];
  /** General kinds of work the client may ask about without a listed service; empty when not offered. */
  inquiryKinds: InquiryKind[];
}

export interface QuickRequestInput {
  serviceChoiceId: string;
  title: string;
  details: string;
  projectId: string | null;
  answers: Record<string, unknown>;
  location: string | null;
  areaGeoJson: PortalAreaGeoJson | null;
  poiPoints: PortalPoi[];
}

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const QUESTION_TYPES = new Set(["text", "number", "boolean", "select", "multi_select"]);

function question(value: unknown): value is PortalServiceQuestion {
  const item = value as Partial<PortalServiceQuestion> | null;
  if (!item || typeof item !== "object" || !text(item.id, 128) || !text(item.label, 300) || typeof item.required !== "boolean" || !QUESTION_TYPES.has(item.type as string)) return false;
  if (item.type === "select" || item.type === "multi_select") {
    const options = (item as { options?: unknown }).options;
    return Array.isArray(options) && options.every(option => text((option as { value?: unknown })?.value, 200) && text((option as { label?: unknown })?.label, 300));
  }
  return true;
}

function choice(value: unknown): RequestServiceChoice | null {
  const item = value as Record<string, unknown> | null;
  if (!item || typeof item !== "object" || !text(item.serviceChoiceId, 512) || !text(item.name, 300) || !text(item.clientName, 300)) return null;
  if (!["drone", "website", "other"].includes(item.category as string) || !["none", "optional", "required"].includes(item.geometryRequirement as string)) return null;
  if (!Array.isArray(item.questions) || !item.questions.every(question)) return null;
  return {
    serviceChoiceId: item.serviceChoiceId as string, name: item.name as string,
    summary: typeof item.summary === "string" && item.summary.trim() ? item.summary : null,
    category: item.category as RequestServiceChoice["category"], clientName: item.clientName as string,
    questions: item.questions as PortalServiceQuestion[], geometryRequirement: item.geometryRequirement as RequestServiceChoice["geometryRequirement"],
  };
}

/**
 * Lists every service the client may request, with no account or workspace chosen. Resolves null when this
 * portal doesn't offer the one-step form yet (404/405), so the caller keeps the per-account path.
 */
export async function loadRequestServices(signal?: AbortSignal): Promise<RequestServices | null> {
  let body: { services?: unknown; unavailable?: unknown; inquiryKinds?: unknown };
  try {
    body = await requestJson<{ services?: unknown; unavailable?: unknown; inquiryKinds?: unknown }>("/api/client/request-services", { omitWorkspace: true, cache: "no-store", signal });
  } catch (caught) {
    if ([404, 405].includes((caught as RequestError).status ?? 0)) return null;
    throw caught;
  }
  if (!Array.isArray(body.services)) throw Object.assign(new Error("The service list could not be read."), { status: 502 });
  const services = body.services.map(choice);
  if (services.some(item => item === null)) throw Object.assign(new Error("The service list could not be read."), { status: 502 });
  const unavailable = Array.isArray(body.unavailable)
    ? [...new Set(body.unavailable.map(item => (item as { clientName?: unknown })?.clientName).filter((name): name is string => text(name, 300)))]
    : [];
  // Only kinds this portal knows how to show; anything else is left out rather than guessed at.
  const inquiryKinds = Array.isArray(body.inquiryKinds) ? INQUIRY_KINDS.filter(kind => (body.inquiryKinds as unknown[]).includes(kind)) : [];
  return { services: services as RequestServiceChoice[], unavailable, inquiryKinds };
}

/** Submits one request; the same idempotency key replays the same request instead of creating another. */
export async function submitQuickRequest(input: QuickRequestInput, idempotencyKey: string, signal?: AbortSignal): Promise<PortalServiceRequest> {
  const body = await requestJson<{ request?: PortalServiceRequest }>("/api/client/requests", {
    method: "POST", omitWorkspace: true, signal,
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
  if (!body.request || typeof body.request !== "object" || typeof body.request.id !== "string")
    throw Object.assign(new Error("We couldn't confirm your request was received."), { status: 502 });
  return body.request;
}

/** A general request sent to Ledge Top's team, for work that isn't a listed service. */
export interface ClientInquiry {
  id: string;
  kind: InquiryKind;
  title: string;
  details: string;
  location: string | null;
  status: string;
  createdAt: string;
}

export interface ClientInquiryInput {
  kind: InquiryKind;
  title: string | null;
  details: string;
  location: string | null;
}

function inquiry(value: unknown): ClientInquiry | null {
  const item = value as Record<string, unknown> | null;
  if (!item || typeof item !== "object" || !text(item.id, 512) || !INQUIRY_KINDS.includes(item.kind as InquiryKind) || !text(item.title, 300)
    || typeof item.details !== "string" || !text(item.status, 64) || !text(item.createdAt, 64) || Number.isNaN(Date.parse(item.createdAt as string))) return null;
  return { id: item.id as string, kind: item.kind as InquiryKind, title: item.title as string, details: item.details,
    location: typeof item.location === "string" && item.location.trim() ? item.location : null, status: item.status as string, createdAt: item.createdAt as string };
}

/**
 * Sends a general request. Like a service request it carries no account or workspace: the server records it
 * for Ledge Top's team. The same idempotency key replays the same inquiry instead of creating another.
 */
export async function submitInquiry(input: ClientInquiryInput, idempotencyKey: string, signal?: AbortSignal): Promise<ClientInquiry> {
  const body = await requestJson<{ inquiry?: unknown }>("/api/client/inquiries", {
    method: "POST", omitWorkspace: true, signal,
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
  const sent = inquiry(body.inquiry);
  if (!sent) throw Object.assign(new Error("We couldn't confirm your request was received."), { status: 502 });
  return sent;
}

/**
 * The client's own general requests, newest first. Resolves null when they aren't offered here (404/405) or not to
 * this client (403: switched off, or no account they can request for), so the page shows nothing instead of an error.
 */
export async function loadInquiries(signal?: AbortSignal): Promise<ClientInquiry[] | null> {
  let body: { inquiries?: unknown };
  try {
    body = await requestJson<{ inquiries?: unknown }>("/api/client/inquiries", { omitWorkspace: true, cache: "no-store", signal });
  } catch (caught) {
    if ([403, 404, 405].includes((caught as RequestError).status ?? 0)) return null;
    throw caught;
  }
  if (!Array.isArray(body.inquiries)) throw Object.assign(new Error("Your requests couldn't be loaded."), { status: 502 });
  const items = body.inquiries.map(inquiry);
  if (items.some(item => item === null)) throw Object.assign(new Error("Your requests couldn't be loaded."), { status: 502 });
  return (items as ClientInquiry[]).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
