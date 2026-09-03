import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { eligibilityFlags, validatePortalReleaseProfile } from "./client-portal-release-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));

const clientConfig = read("apps/client/wrangler.jsonc");
const operationsConfig = read("apps/operations/wrangler.jsonc");
const manifest = read("docs/operations/client-portal-rollout-manifest.md");

function configuredValue(config, name) {
  return config.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`))?.[1];
}

test("portal rollout foundations and dormant gates match the reviewed manifest", () => {
  const declaration = JSON.parse(read("scripts/client-portal-release-profile.json"));
  assert.deepEqual(validatePortalReleaseProfile(declaration, JSON.parse(clientConfig), JSON.parse(operationsConfig)), []);
  const enabledFoundations = [
    [clientConfig, "CLIENT_PORTAL_ENABLED"],
    [clientConfig, "PROJECT_ALPHA_PORTAL_SYNC_ENABLED"],
    [clientConfig, "CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED"],
    [operationsConfig, "CLIENT_PORTAL_PRIMARY_WORKSPACE_RECONCILIATION_ENABLED"],
  ];
  for (const [config, name] of enabledFoundations) {
    assert.equal(configuredValue(config, name), "true", `${name} foundation changed without updating the rollout contract`);
    assert.match(manifest, new RegExp(`\\b${name}\\b`));
  }

  const dormantClientFlags = [
    "CLIENT_PORTAL_HIERARCHY_V2_ENABLED",
    "CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED",
    "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED",
    "CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED",
    "CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED",
    "PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED",
    "AUTHENTICATED_DELIVERY_GRANTS_ENABLED",
    "CLIENT_PORTAL_TEAM_ENABLED",
    "CLIENT_PORTAL_PEER_ADMIN_ENABLED",
    "CLIENT_PORTAL_ADDRESS_BOOK_ENABLED",
    "CLIENT_PORTAL_ACCESS_ENROLLMENT_READY",
    "CLIENT_PORTAL_INVITATION_EMAIL_ENABLED",
    "CLIENT_DELEGATED_SHARES_ENABLED",
    "PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED",
    "CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED",
    "CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED",
    "CLIENT_PORTAL_CONTENT_AUDIT_ENABLED",
  ];
  const dormantOperationsFlags = [
    "CLIENT_PORTAL_HIERARCHY_V2_ENABLED",
    "CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED",
    "CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED",
    "PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED",
    "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED",
    "CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED",
    "CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED",
    "AUTHENTICATED_DELIVERY_GRANTS_ENABLED",
    "AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED",
    "PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED",
    "CLIENT_DELEGATED_SHARE_SIGNER_ENABLED",
    "CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED",
  ];

  for (const [config, names] of [[clientConfig, dormantClientFlags], [operationsConfig, dormantOperationsFlags]]) {
    for (const name of names) {
      if (!eligibilityFlags.includes(name)) {
        assert.notEqual(configuredValue(config, name), "true", `${name} was activated outside a recorded rollout window`);
      }
      assert.match(manifest, new RegExp(`\\b${name}\\b`), `${name} is not represented in the rollout manifest`);
    }
  }
});

test("rollout manifest is pinned to the current receiver migration boundary", () => {
  for (const migration of [
    "apps/client/migrations/0190_portal_contact_assignments_v4.sql",
    "apps/client/migrations/0191_portal_projection_wire_contract_claim.sql",
    "apps/client/migrations/0192_contact_assignment_billing_independence.sql",
    "apps/client/migrations/0193_bulk_download_parts.sql",
    "apps/client/migrations/0194_client_delegated_share_expiry.sql",
    "apps/client/migrations/0195_legacy_workspace_authority_lifecycle.sql",
    "apps/operations/migrations/0051_client_hub_internal_notes.sql",
    "apps/operations/migrations/0052_project_operational_reassignment_recovery.sql",
  ]) assert.equal(exists(migration), true, `missing rollout migration ${migration}`);

  assert.match(manifest, /Client migrations through `0195`/);
  assert.match(manifest, /Operations through `0052`/);
  assert.match(manifest, /Project Alpha `0083`/);
});

test("rollout manifest keeps every joined workflow and reversible window explicit", () => {
  const acceptance = read("docs/operations/client-portal-goal-acceptance.md");
  for (let index = 1; index <= 7; index += 1) {
    assert.match(acceptance, new RegExp(`\\| J${index} `), `joined acceptance group J${index} is missing`);
  }
  for (let index = 0; index <= 10; index += 1) {
    assert.match(manifest, new RegExp(`### R${index} `), `rollout window R${index} is missing`);
  }
  assert.match(manifest, /Project Alpha's current onboarding, approval, project, contract, and document/);
  assert.match(manifest, /Public links remain a separate bearer-link product/);
  assert.match(manifest, /The 3D Viewer is outside this manifest/);
});

test("the bounded joined runner is wired into the root package", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.scripts["test:portal:joined"], "node scripts/client-portal-joined-acceptance.mjs");
  assert.equal(exists("scripts/client-portal-joined-acceptance.mjs"), true);
});
