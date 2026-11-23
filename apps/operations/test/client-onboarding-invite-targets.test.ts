import { expect, it } from "vitest";
import { resolveInviteTargetSelections } from "../src/worker/client-onboarding-invite-targets";

const technology = { sourceId: "project-alpha:secondary", sourceInstanceId: "tech", applicationId: "tech-app", historyEpoch: "tech-history" } as const;
const drone = { sourceId: "project-alpha:primary", sourceInstanceId: "drone", applicationId: "drone-app", historyEpoch: "drone-history" } as const;
const client = { publicId: "17", recordVersion: 2 };
const organization = { publicId: "19", recordVersion: 3 };
const pick = { client, organization };
const authorized = [technology, drone].flatMap(source => [
  { ...source, ...client, kind: "client" as const, recordId: `${source.sourceInstanceId}-client`,
    organizationRecordId: `${source.sourceInstanceId}-organization`, label: "Same Client" },
  { ...source, ...organization, kind: "organization" as const, recordId: `${source.sourceInstanceId}-organization`, label: "Same Organization" },
]);

it("matches identical numeric IDs and labels only within each exact source", () => {
  expect(resolveInviteTargetSelections([technology, drone], { [technology.sourceId]: pick, [drone.sourceId]: pick }, authorized))
    .toEqual([{ source: technology, client: authorized[0], organization: authorized[1] },
      { source: drone, client: authorized[2], organization: authorized[3] }]);
});

it("allows blank targets and organization-only selections within a chosen source", () => {
  expect(resolveInviteTargetSelections([technology, drone], {}, [])).toEqual([
    { source: technology, client: null, organization: null }, { source: drone, client: null, organization: null },
  ]);
  expect(resolveInviteTargetSelections([technology], { [technology.sourceId]: { organization } }, authorized))
    .toEqual([{ source: technology, client: null, organization: authorized[1] }]);
});

it("rejects unauthorized, stale, ambiguous, and mismatched client/organization results", () => {
  const picks = { [technology.sourceId]: pick };
  const [first] = authorized;
  if (!first) throw Error("missing authorized target fixture");
  for (const candidates of [authorized.slice(2),
    authorized.map(row => ({ ...row, historyEpoch: "changed" })),
    authorized.map(row => ({ ...row, recordVersion: row.recordVersion + 1 })),
    [...authorized, { ...first, recordVersion: 3 }],
    authorized.map(row => ({ ...row, organizationRecordId: "another-organization" }))]) {
    expect(resolveInviteTargetSelections([technology], picks, candidates)).toBeNull();
  }
  expect(resolveInviteTargetSelections([drone], picks, authorized)).toBeNull();
  expect(resolveInviteTargetSelections([technology, drone], { ...picks, [drone.sourceId]: pick }, authorized.slice(0, 2))).toBeNull();
});
