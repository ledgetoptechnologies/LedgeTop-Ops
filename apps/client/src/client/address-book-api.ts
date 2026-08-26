import { z } from "zod";
import { requestJson } from "./bulk-download";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const sourceId = z.string().regex(/^project-alpha:[A-Za-z0-9_-]+$/);
const isoDate = z.string().datetime({ offset: true });

const previousInvitationSchema = z.object({
  status: z.enum(["pending", "accepted", "revoked", "expired"]),
  lastInvitedAt: isoDate,
});

export const addressBookContactSchema = z.object({
  id,
  workspaceId: id,
  sourceId,
  displayName: z.string().min(1).max(160),
  email: z.string().email().max(320),
  phone: z.string().min(1).max(64).nullable(),
  company: z.string().min(1).max(160).nullable(),
  roleOrTrade: z.string().min(1).max(160).nullable(),
  version: z.number().int().positive(),
  createdAt: isoDate,
  updatedAt: isoDate,
  previousInvitation: previousInvitationSchema.nullable(),
});

export type AddressBookContact = z.infer<typeof addressBookContactSchema>;
export type AddressBookContactInput = Pick<AddressBookContact, "displayName" | "email" | "phone" | "company" | "roleOrTrade">;

const pageSchema = z.object({
  items: z.array(addressBookContactSchema).max(100),
  nextCursor: z.string().min(1).max(4096).nullable(),
  contextVersion: z.string().regex(/^[a-f0-9]{64}$/),
});

const mutationSchema = z.object({contact: addressBookContactSchema, replayed: z.boolean()});
const deletedSchema = z.object({
  contact: z.object({id, workspaceId: id, sourceId, status: z.literal("deleted"), version: z.number().int().positive()}),
  replayed: z.boolean(),
});

export function addressBookContactMatches(contact: AddressBookContact, workspaceId: string, expectedSourceId: string): boolean {
  return contact.workspaceId === workspaceId && contact.sourceId === expectedSourceId;
}

export async function loadAddressBookContacts(workspaceId: string, options: {q?: string; cursor?: string | null} = {}, signal?: AbortSignal) {
  const q = options.q?.trim();
  return pageSchema.parse(await requestJson<unknown>(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/address-book/contacts/search`, {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({q: q ?? "", cursor: options.cursor ?? null}), ...(signal ? {signal} : {}),
  }));
}

export async function createAddressBookContact(workspaceId: string, input: AddressBookContactInput, idempotencyKey: string, signal?: AbortSignal) {
  return mutationSchema.parse(await requestJson<unknown>(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/address-book/contacts`, {
    method: "POST", headers: {"Content-Type": "application/json", "Idempotency-Key": idempotencyKey}, body: JSON.stringify(input), ...(signal ? {signal} : {}),
  }));
}

export async function updateAddressBookContact(workspaceId: string, contactId: string, input: AddressBookContactInput, expectedVersion: number, idempotencyKey: string, signal?: AbortSignal) {
  return mutationSchema.parse(await requestJson<unknown>(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/address-book/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH", headers: {"Content-Type": "application/json", "Idempotency-Key": idempotencyKey}, body: JSON.stringify({...input, expectedVersion}), ...(signal ? {signal} : {}),
  }));
}

export async function deleteAddressBookContact(workspaceId: string, contactId: string, expectedVersion: number, idempotencyKey: string, signal?: AbortSignal) {
  return deletedSchema.parse(await requestJson<unknown>(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/address-book/contacts/${encodeURIComponent(contactId)}`, {
    method: "DELETE", headers: {"Content-Type": "application/json", "Idempotency-Key": idempotencyKey}, body: JSON.stringify({expectedVersion}), ...(signal ? {signal} : {}),
  }));
}
