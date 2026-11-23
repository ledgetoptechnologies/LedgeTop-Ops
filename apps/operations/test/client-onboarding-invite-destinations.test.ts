import { expect, it } from "vitest";
import { inviteDestinationsStillBound, resolveInviteDestinations } from "../src/worker/client-onboarding-invite-destinations";

const technology = { sourceId: "project-alpha:secondary", businessAreaId: "area:t", divisionId: "division:t" };
const drone = { sourceId: "project-alpha:primary", businessAreaId: "area:d", divisionId: "division:d" };
const config = JSON.stringify([drone, technology]);
const scope = (binding: typeof technology) => ({ businessAreaId: binding.businessAreaId,
  name: "Same label", allowAreaWide: true, divisions: [{ divisionId: binding.divisionId, name: "Same label" }] });
const scopes = [scope(technology), scope(drone)];

it("maps independent and joint choices to canonical exact pairs", () => {
  for (const binding of [technology, drone]) expect(resolveInviteDestinations(config, { scopes }, [binding.sourceId])).toEqual([binding]);
  expect(resolveInviteDestinations(config, { scopes }, [drone.sourceId, technology.sourceId])).toEqual([technology, drone]);
});

it("fails closed for omitted, malformed, duplicate or missing exact bindings", () => {
  for (const invalid of [undefined, "[]", "?", JSON.stringify([technology, technology]),
    JSON.stringify([technology, { ...technology, sourceId: drone.sourceId }]),
    JSON.stringify([{ ...technology, divisionId: null }])]) {
    expect(resolveInviteDestinations(invalid, { scopes }, [technology.sourceId])).toBeNull();
  }
  for (const selection of [[], [technology.sourceId, technology.sourceId], ["invalid"]]) {
    expect(resolveInviteDestinations(config, { scopes }, selection)).toBeNull();
  }
  expect(resolveInviteDestinations(JSON.stringify([technology]), { scopes }, [technology.sourceId, drone.sourceId])).toBeNull();
  expect(resolveInviteDestinations(config, { scopes: [{ ...scope(technology), divisions: [] }] }, [technology.sourceId])).toBeNull();
});

it("rejects a formerly allowed intent after remapping or lost division authority", () => {
  const intent = resolveInviteDestinations(config, { scopes }, [technology.sourceId])!;
  const changed = JSON.stringify([{ ...drone, sourceId: technology.sourceId }]);
  expect(inviteDestinationsStillBound(config, { scopes }, intent)).toBe(true);
  expect(inviteDestinationsStillBound(changed, { scopes }, intent)).toBe(false);
  expect(inviteDestinationsStillBound(config, { scopes: [scope(drone)] }, intent)).toBe(false);
});
