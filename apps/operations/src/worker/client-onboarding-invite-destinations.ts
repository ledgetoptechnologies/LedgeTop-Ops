import type { ClientOnboardingScopeChoices } from "./client-onboarding-scope-choices";

const destinationIds = ["project-alpha:secondary", "project-alpha:primary"] as const;
type DestinationId = typeof destinationIds[number];
export type InviteDestinationBinding = Readonly<{ sourceId: DestinationId; businessAreaId: string; divisionId: string }>;
type Binding = InviteDestinationBinding;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;

function destinationId(value: unknown): value is DestinationId {
  return value === "project-alpha:secondary" || value === "project-alpha:primary";
}

/** Invalid configuration fails closed for the two-destination flow. */
function bindingsFromConfig(config: string | undefined): readonly Binding[] {
  if (!config || config.length > 2048) return [];
  let value: unknown;
  try { value = JSON.parse(config); } catch { return []; }
  if (!Array.isArray(value) || value.length > destinationIds.length) return [];

  const bindings = new Map<DestinationId, Binding>();
  const divisions = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Object.keys(entry).length !== 3
      || !Object.hasOwn(entry, "sourceId") || !Object.hasOwn(entry, "businessAreaId") || !Object.hasOwn(entry, "divisionId")
      || !destinationId(entry.sourceId) || typeof entry.businessAreaId !== "string" || !ID.test(entry.businessAreaId)
      || typeof entry.divisionId !== "string" || !ID.test(entry.divisionId)
      || bindings.has(entry.sourceId) || divisions.has(entry.divisionId)) return [];
    bindings.set(entry.sourceId, { sourceId: entry.sourceId, businessAreaId: entry.businessAreaId, divisionId: entry.divisionId });
    divisions.add(entry.divisionId);
  }
  return destinationIds.flatMap(id => bindings.get(id) ?? []);
}

export function allowedInviteDestinationBindings(config: string | undefined, authorized: ClientOnboardingScopeChoices): readonly Binding[] {
  return bindingsFromConfig(config).filter(binding => authorized.scopes.some(area => area.businessAreaId === binding.businessAreaId
    && area.divisions.some(division => division.divisionId === binding.divisionId)));
}

export function resolveInviteDestinations(config: string | undefined, authorized: ClientOnboardingScopeChoices, selection: unknown): readonly Binding[] | null {
  if (!Array.isArray(selection) || selection.length < 1 || selection.length > destinationIds.length
    || Array.from(selection).some(id => !destinationId(id))) return null;
  const selected = allowedInviteDestinationBindings(config, authorized).filter(binding => selection.includes(binding.sourceId));
  return selected.length === selection.length ? selected : null;
}

/** Legacy invitations have no intent; call this only for a validated stored snapshot. */
export function inviteDestinationsStillBound(config: string | undefined, authorized: ClientOnboardingScopeChoices, intent: readonly Binding[]): boolean {
  const verified = resolveInviteDestinations(config, authorized, intent.map(binding => binding.sourceId));
  return verified !== null && verified.every(binding => intent.some(original => original.sourceId === binding.sourceId
    && original.businessAreaId === binding.businessAreaId && original.divisionId === binding.divisionId));
}

export function parseInviteDestinationIntent(value: unknown, scopes: readonly { businessAreaId: string; divisionId: string | null }[] | null): readonly Binding[] | null {
  if (!Array.isArray(value) || !scopes) return null;
  const bindings = bindingsFromConfig(JSON.stringify(value));
  return bindings.length > 0 && bindings.length === scopes.length && bindings.every(binding => scopes.some(scope =>
    binding.businessAreaId === scope.businessAreaId && binding.divisionId === scope.divisionId)) ? bindings : null;
}
