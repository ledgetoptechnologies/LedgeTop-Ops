import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseSecretNames, runPortalReleasePreflight, validatePortalReceiverPreflight, validatePortalReleasePreflight } from "./project-alpha-portal-receiver-preflight.mjs";
import { eligibilityFlags } from "../../../scripts/client-portal-release-profile.mjs";

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(appDirectory, "wrangler.jsonc"), "utf8"));
const current = new Set(["PROJECT_ALPHA_PORTAL_HMAC_SECRET"]);
const operations = JSON.parse(fs.readFileSync(path.resolve(appDirectory, "../operations/wrangler.jsonc"), "utf8"));
const declaration = JSON.parse(fs.readFileSync(path.resolve(appDirectory, "../../scripts/client-portal-release-profile.json"), "utf8"));
function receiverConfig() {
  const result = structuredClone(config);
  for (const flag of eligibilityFlags) result.vars[flag] = "false";
  return result;
}

test("receiver-only validator retains strict behavior independently of release intent", () => {
  assert.deepEqual(validatePortalReceiverPreflight(receiverConfig(), current), []);
});

test("private Ops Sync ingestion does not require a copied Project Alpha secret", () => {
  assert.deepEqual(validatePortalReceiverPreflight(receiverConfig(), new Set()), []);
});

test("adjacent client authority and workflow flags cannot ride with receiver activation", () => {
  for (const flag of [
    "CLIENT_PORTAL_HIERARCHY_V2_ENABLED",
    "CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED",
    "AUTHENTICATED_DELIVERY_GRANTS_ENABLED",
    "CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED",
    "CLIENT_PORTAL_INVITATION_EMAIL_ENABLED",
    "CLIENT_DELEGATED_SHARES_ENABLED",
  ]) {
    const changed = receiverConfig();
    changed.vars[flag] = "true";
    assert.ok(validatePortalReceiverPreflight(changed, current).some((error) => error.includes(`${flag} must remain exactly false`)), flag);
  }
});

test("preflight hard-disables the legacy direct HTTP receiver", () => {
  const enabled = receiverConfig();
  enabled.vars.PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED = "true";
  assert.ok(validatePortalReceiverPreflight(enabled, current).some((error) => error.includes("PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED")));
  const absent = receiverConfig();
  delete absent.vars.PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED;
  assert.ok(validatePortalReceiverPreflight(absent, current).some((error) => error.includes("PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED")));
});

test("actual release runner loads the committed profile and both configs without network", () => {
  assert.deepEqual(runPortalReleasePreflight(current), { worker: config.name, profile: declaration.profile });
  assert.deepEqual(runPortalReleasePreflight(new Set()), { worker: config.name, profile: declaration.profile });
});

test("receiver-only accepts absent deny-management but rejects every enabled or malformed value", () => {
  const changed = receiverConfig();
  delete changed.vars.CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED;
  assert.deepEqual(validatePortalReceiverPreflight(changed, current), []);
  for (const value of ["true", true, false, null, "FALSE", " false "]) {
    changed.vars.CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED = value;
    assert.ok(validatePortalReceiverPreflight(changed, current).some(error => error.includes("CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED")));
  }
});

for (const profile of ["receiver-only", "default-on-eligibility"]) {
  test(`${profile} preserves every adjacent receiver gate and ingress credential check`, () => {
    const client = receiverConfig();
    const ops = structuredClone(operations);
    for (const item of [client, ops]) for (const flag of eligibilityFlags) item.vars[flag] = profile === "receiver-only" ? "false" : "true";
    const intent = { schemaVersion: 1, profile };
    const check = (candidate, secrets = current) => validatePortalReleasePreflight(candidate, ops, intent, secrets);
    assert.deepEqual(check(client), []);
    for (const flag of ["CLIENT_PORTAL_CONTENT_AUDIT_ENABLED", "CLIENT_PORTAL_REQUEST_V2_ENABLED", "CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED",
      "PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED", "CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED", "CLIENT_REQUEST_ATTACHMENTS_ENABLED",
      "CLIENT_PORTAL_TEAM_ENABLED", "AUTHENTICATED_DELIVERY_GRANTS_ENABLED", "CLIENT_VIEWER_ENABLED", "CLIENT_VIEWER_SHARES_ENABLED",
      "CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED", "PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED", "CLIENT_PORTAL_PEER_ADMIN_ENABLED",
      "CLIENT_PORTAL_ADDRESS_BOOK_ENABLED", "CLIENT_PORTAL_ACCESS_ENROLLMENT_READY", "CLIENT_PORTAL_INVITATION_EMAIL_ENABLED", "CLIENT_DELEGATED_SHARES_ENABLED"]) {
      for (const value of ["true", undefined, false]) {
        const changed = structuredClone(client);
        changed.vars[flag] = value;
        assert.ok(check(changed).some(error => error.includes(flag)), flag);
      }
    }
    for (const [flag, value] of [["PROJECT_ALPHA_PORTAL_SYNC_ENABLED", "false"], ["PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED", "true"],
      ["CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED", "false"], ["PROJECT_ALPHA_PORTAL_APPLICATION_KEY", "bad key"]]) {
      const changed = structuredClone(client);
      changed.vars[flag] = value;
      assert.ok(check(changed).some(error => error.includes(flag)), flag);
    }
    assert.deepEqual(check(client, new Set()), []);
    if (profile === "default-on-eligibility") assert.ok(validatePortalReceiverPreflight(client, current).length);
  });
}

test("Wrangler secret inventory parser accepts only named JSON entries", () => {
  assert.deepEqual([...parseSecretNames([{ name: "PROJECT_ALPHA_PORTAL_HMAC_SECRET", type: "secret_text" }])], ["PROJECT_ALPHA_PORTAL_HMAC_SECRET"]);
  assert.throws(() => parseSecretNames([{ type: "secret_text" }]));
  assert.throws(() => parseSecretNames({ name: "PROJECT_ALPHA_PORTAL_HMAC_SECRET" }));
});
