import assert from "node:assert/strict";
import test from "node:test";
import { parseStagingCloudflareD1Target, stagingCloudflareD1QueryUrl } from "./staging-cloudflare-d1-target.mjs";
import { STAGING_ACCOUNT_ID } from "./staging-requirements.mjs";

const env = Object.freeze({ OPS_STAGING_D1_ENVIRONMENT: "staging", CLOUDFLARE_ACCOUNT_ID: STAGING_ACCOUNT_ID,
  OPS_STAGING_D1_DATABASE_ID: "78b34173-b168-4e3d-9832-bb9d245cc6b8",
  OPS_STAGING_D1_DATABASE_NAME: "ltds-ops-staging", OPS_STAGING_D1_BINDING: "OPS_DB" });

test("constructs the Cloudflare API URL from exact staging identifiers and ignores custom endpoint fields", () => {
  const target = parseStagingCloudflareD1Target(env, "OPS_DB");
  assert.equal(stagingCloudflareD1QueryUrl(target),
    `https://api.cloudflare.com/client/v4/accounts/${STAGING_ACCOUNT_ID}/d1/database/78b34173-b168-4e3d-9832-bb9d245cc6b8/query`);
  assert.equal(Object.hasOwn(target, "token"), false);
  assert.equal(stagingCloudflareD1QueryUrl({ ...target, apiUrl: "https://attacker.example" }),
    `https://api.cloudflare.com/client/v4/accounts/${STAGING_ACCOUNT_ID}/d1/database/78b34173-b168-4e3d-9832-bb9d245cc6b8/query`);
});

test("rejects production, malformed, uppercase, or wrong-binding D1 targets", () => {
  for (const candidate of [
    { ...env, OPS_STAGING_D1_ENVIRONMENT: "production" },
    { ...env, CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) },
    { ...env, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID.toUpperCase() },
    { ...env, OPS_STAGING_D1_DATABASE_ID: "not-a-database-id" },
    { ...env, OPS_STAGING_D1_DATABASE_ID: "11111111-1111-4111-8111-111111111111" },
    { ...env, OPS_STAGING_D1_DATABASE_NAME: "ops-production" },
    { ...env, OPS_STAGING_D1_DATABASE_NAME: "other-ops-staging" },
    { ...env, OPS_STAGING_D1_BINDING: "DELIVERY_DB" },
  ]) assert.throws(() => parseStagingCloudflareD1Target(candidate, "OPS_DB"), /invalid_staging_d1_target/);
});
