import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseSecretNames, validatePortalReceiverPreflight } from "./project-alpha-portal-receiver-preflight.mjs";

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(appDirectory, "wrangler.jsonc"), "utf8"));
const current = new Set(["PROJECT_ALPHA_PORTAL_HMAC_SECRET"]);

test("production config is receiver-only and has the required secret inventory", () => {
  assert.deepEqual(validatePortalReceiverPreflight(config, current), []);
});

test("missing primary secret fails with an actionable name", () => {
  assert.deepEqual(validatePortalReceiverPreflight(config, new Set()), [
    "PROJECT_ALPHA_PORTAL_HMAC_SECRET is not installed on ltds-clients",
  ]);
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
    const changed = structuredClone(config);
    changed.vars[flag] = "true";
    assert.ok(validatePortalReceiverPreflight(changed, current).some((error) => error.includes(`${flag} must remain exactly false`)), flag);
  }
});

test("rotation secret is paired exactly with a distinct previous key ID", () => {
  const orphaned = new Set([...current, "PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET"]);
  assert.ok(validatePortalReceiverPreflight(config, orphaned).some((error) => error.includes("must be removed")));
  const rotating = structuredClone(config);
  rotating.vars.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID = "portal-v0";
  assert.deepEqual(validatePortalReceiverPreflight(rotating, orphaned), []);
  assert.ok(validatePortalReceiverPreflight(rotating, current).some((error) => error.includes("is required")));
});

test("Wrangler secret inventory parser accepts only named JSON entries", () => {
  assert.deepEqual([...parseSecretNames([{ name: "PROJECT_ALPHA_PORTAL_HMAC_SECRET", type: "secret_text" }])], ["PROJECT_ALPHA_PORTAL_HMAC_SECRET"]);
  assert.throws(() => parseSecretNames([{ type: "secret_text" }]));
  assert.throws(() => parseSecretNames({ name: "PROJECT_ALPHA_PORTAL_HMAC_SECRET" }));
});
