import { HTTPException } from "hono/http-exception";
import { readBusinessParty, type BusinessPartyMember } from "./business-parties";
import { listClientHubBusinessProjects } from "./client-hub-business-projects";
import { listClientHubCollection } from "./client-hub-collections";
import { resolveClientHubDetailContext, verifyClientHubDetailContext } from "./client-hub";
import type { Env, StaffPrincipal } from "./types";

function changed(): never {
  throw new HTTPException(409, { message: "Customer sources changed. Refresh the customer workspace to continue" });
}

function sameMember(left: BusinessPartyMember, right: BusinessPartyMember): boolean {
  return left.linkId === right.linkId && left.root.sourceId === right.root.sourceId
    && left.root.kind === right.root.kind && left.root.recordId === right.root.recordId
    && left.displayName === right.displayName && left.sourceName === right.sourceName
    && left.detailPath === right.detailPath && left.availability === right.availability;
}

/** Hydrate one member of a reviewed business-party grouping through the same
 * exact-root authorization context as its standalone Client Hub workspace.
 * The grouping is presentation only: projects, contacts and access remain
 * source-owned, and every independently read collection is fenced again before
 * release. */
export async function readBusinessPartySourceWorkspace(env: Env, principal: StaffPrincipal, partyId: string,
  linkId: string, expectedVersion: number) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) changed();
  const party = await readBusinessParty(env, principal, partyId);
  if (party.version !== expectedVersion) changed();
  const member = party.members.find(candidate => candidate.linkId === linkId);
  if (!member) changed();
  if (member.availability !== "available" || !member.detailPath)
    throw new HTTPException(409, { message: "This source record is unavailable. Review the customer links before continuing" });

  const context = await resolveClientHubDetailContext(env, principal, member.root.kind, member.root.recordId,
    member.root.sourceId, "business");
  if (context.canonicalRoot.sourceId !== member.root.sourceId || context.canonicalRoot.rootNamespace !== "business"
    || context.canonicalRoot.kind !== member.root.kind || context.canonicalRoot.publicId !== member.root.recordId) changed();
  const [projects, contacts] = await Promise.all([
    listClientHubBusinessProjects(env, principal, context, { initial: true, limit: 5 }),
    listClientHubCollection(env, context, "businessContacts", { initial: true, limit: 5 }),
  ]);
  await verifyClientHubDetailContext(env, principal, context);
  const currentParty = await readBusinessParty(env, principal, partyId);
  const currentMember = currentParty.members.find(candidate => candidate.linkId === linkId);
  if (currentParty.version !== expectedVersion || !currentMember || !sameMember(member, currentMember)) changed();
  // Recheck the exact source context after the final membership read so a
  // workspace remap or authority change during that read fails closed.
  await verifyClientHubDetailContext(env, principal, context);

  const sourcePath = member.detailPath;
  return {
    partyId: party.id,
    partyVersion: party.version,
    member,
    canonicalRoot: context.canonicalRoot,
    contextVersion: context.contextVersion,
    source: {
      portalStatus: context.root.portal_status,
      mappingStatus: context.root.mapping_status,
      workspaceAvailable: Boolean(context.root.workspace_id),
      capabilities: context.access,
    },
    projects,
    contacts,
    entryPoints: {
      source: sourcePath,
      projects: `${sourcePath}#client-business-projects`,
      contacts: `${sourcePath}#client-business-contacts`,
      access: `${sourcePath}#client-portal-access`,
      delivery: `${sourcePath}#client-delivery-access`,
      audit: `${sourcePath}#client-audit`,
    },
  };
}
