import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { authenticatedDeliveryFlags, eligibilityFlags, validatePortalReleaseProfile } from "./client-portal-release-profile.mjs";

const client = JSON.parse(fs.readFileSync(new URL("../apps/client/wrangler.jsonc", import.meta.url), "utf8"));
const operations = JSON.parse(fs.readFileSync(new URL("../apps/operations/wrangler.jsonc", import.meta.url), "utf8"));
const receiver = { schemaVersion: 1, profile: "receiver-only" };
const activation = { schemaVersion: 1, profile: "default-on-eligibility" };
const authenticated = { schemaVersion: 1, profile: "primary-authenticated-delivery" };
const authenticatedPaused = { schemaVersion: 1, profile: "primary-authenticated-delivery-paused" };
const explicitFolder = { schemaVersion: 1, profile: "primary-explicit-folder-delivery" };
function configs(profile) {
  const pair = [structuredClone(client), structuredClone(operations)];
  for (const config of pair) {
    for (const flag of eligibilityFlags) config.vars[flag] = profile === receiver ? "false" : "true";
    const authenticatedEnabled = profile === authenticated || profile === authenticatedPaused;
    for (const flag of authenticatedDeliveryFlags) {
      config.vars[flag] = flag === "AUTHENTICATED_DELIVERY_CREATION_ENABLED"
        ? (profile === authenticated ? "true" : "false")
        : (authenticatedEnabled ? "true" : "false");
    }
    config.vars.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED = config === pair[0] || authenticatedEnabled ? "true" : "false";
    if (profile === explicitFolder) {
      config.vars.AUTHENTICATED_DELIVERY_GRANTS_ENABLED = "true";
      config.vars.PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED = config === pair[1] ? "true" : "false";
      config.vars.AUTHENTICATED_DELIVERY_CREATION_ENABLED = config === pair[1] ? "true" : "false";
    }
  }
  return pair;
}

test("committed release intent is valid for both checked-in configurations", () => {
  const declaration = JSON.parse(fs.readFileSync(new URL("./client-portal-release-profile.json", import.meta.url), "utf8"));
  assert.deepEqual(validatePortalReleaseProfile(declaration, client, operations), []);
});

test("staging no-mail profile permits reviewed omitted Ops gates without relaxing production", () => {
  const flags = ["AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED", "PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED",
    "PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED", "PROJECT_ALPHA_DELIVERY_GUEST_ENABLED"];
  const pair = configs(receiver);
  pair[1].name = "ledgetop-ops-staging";
  pair[1].vars.ENVIRONMENT = "staging";
  for (const flag of flags) delete pair[1].vars[flag];
  assert.deepEqual(validatePortalReleaseProfile(receiver, ...pair), []);
  for (const flag of flags) for (const value of ["true", "", null, undefined, false]) {
    const invalid = structuredClone(pair);
    invalid[1].vars[flag] = value;
    assert(validatePortalReleaseProfile(receiver, ...invalid).some(error => error.includes(flag)));
  }
  pair[1].vars.ENVIRONMENT = "production";
  const errors = validatePortalReleaseProfile(receiver, ...pair);
  for (const flag of flags) assert(errors.some(error => error.includes(flag)));
  pair[1].vars.ENVIRONMENT = "staging";
  pair[1].name = "ledgetop-ops";
  const productionNameErrors = validatePortalReleaseProfile(receiver, ...pair);
  for (const flag of flags) assert(productionNameErrors.some(error => error.includes(flag)));
});

test("missing, malformed, unknown, and extra-field profiles never infer activation", () => {
  const pair = configs(activation);
  for (const declaration of [undefined, null, [], "default-on-eligibility", {}, { profile: activation.profile },
    { ...activation, schemaVersion: "1" }, { ...activation, profile: "DEFAULT-ON-ELIGIBILITY" },
    { ...activation, profile: "eligibility-paused" }, { ...activation, profile: "primary-authenticated-delivery-PAUSED" },
    { ...activation, bypass: true }]) {
    assert.ok(validatePortalReleaseProfile(declaration, ...pair).length);
  }
});

for (const declaration of [receiver, activation, authenticated, authenticatedPaused, explicitFolder]) {
  test(`${declaration.profile} requires a complete exact bundle on each Worker`, () => {
    assert.deepEqual(validatePortalReleaseProfile(declaration, ...configs(declaration)), []);
    for (const index of [0, 1]) for (const flag of eligibilityFlags) {
      const opposite = declaration === receiver ? "true" : "false";
      for (const value of [undefined, null, true, false, "TRUE", " true ", opposite]) {
        const pair = configs(declaration);
        pair[index].vars[flag] = value;
        const optionalAbsent = declaration === receiver && index === 0 && flag === "CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED" && value === undefined;
        assert.equal(validatePortalReleaseProfile(declaration, ...pair).length === 0, optionalAbsent, `${index} ${flag} ${value}`);
      }
    }
    for (const index of [0, 1]) {
      const pair = configs(declaration);
      pair[index].vars = null;
      assert.ok(validatePortalReleaseProfile(declaration, ...pair).length);
    }
  });

  test(`${declaration.profile} requires the exact authenticated-delivery and hierarchy-relation bundle`, () => {
    for (const index of [0, 1]) for (const flag of authenticatedDeliveryFlags) {
      const pair = configs(declaration);
      pair[index].vars[flag] = pair[index].vars[flag] === "true" ? "false" : "true";
      assert.ok(validatePortalReleaseProfile(declaration, ...pair).some(error => error.includes(flag)));
    }
  });

  test(`${declaration.profile} keeps invitation, delivery and expiry mail disabled`, () => {
    for (const [index, flag] of [[0, "CLIENT_PORTAL_INVITATION_EMAIL_ENABLED"], [1, "AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED"], [1, "PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED"]]) {
      for (const value of [undefined, "true", false]) {
        const pair = configs(declaration);
        pair[index].vars[flag] = value;
        assert.ok(validatePortalReleaseProfile(declaration, ...pair).some(error => error.includes(flag)));
      }
    }
  });
}

test("one Worker cannot declare activation while the other remains receiver-only", () => {
  const enabled = configs(activation);
  const disabled = configs(receiver);
for (const declaration of [receiver, activation, authenticated, authenticatedPaused, explicitFolder]) {
    assert.ok(validatePortalReleaseProfile(declaration, enabled[0], disabled[1]).length);
    assert.ok(validatePortalReleaseProfile(declaration, disabled[0], enabled[1]).length);
  }
});

test("explicit folder delivery rejects staging targets and malformed variable-preservation intent", () => {
  for (const index of [0, 1]) {
    for (const change of [
      config => { config.vars.ENVIRONMENT = "staging"; },
      config => { config.name += "-staging"; },
      config => { config.keep_vars = false; },
      config => { config.keep_vars = "true"; },
      config => { delete config.keep_vars; },
    ]) {
      const pair = configs(explicitFolder);
      change(pair[index]);
      assert.ok(validatePortalReleaseProfile(explicitFolder, ...pair).length);
    }
  }
  assert.ok(validatePortalReleaseProfile({ ...explicitFolder, profile: "primary-explicit-folder-delivery-staging" }, ...configs(explicitFolder)).length);
  assert.ok(validatePortalReleaseProfile({ ...explicitFolder, allowStaging: true }, ...configs(explicitFolder)).length);
});

test("explicit folder delivery preserves exact staff-only creation without broader authenticated-delivery activation", () => {
  const pair = configs(explicitFolder);
  assert.deepEqual(validatePortalReleaseProfile(explicitFolder, ...pair), []);
  assert.equal(pair[1].vars.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED, "false");
  assert.equal(pair[0].vars.PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED, "false");
  assert.equal(pair[0].vars.AUTHENTICATED_DELIVERY_CREATION_ENABLED, "false");
  assert.ok(validatePortalReleaseProfile(authenticated, ...pair).length);
  assert.ok(validatePortalReleaseProfile(explicitFolder, ...configs(authenticated)).length);
  for (const index of [0, 1]) for (const flag of ["CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED", index === 0 ? "CLIENT_PORTAL_ADDRESS_BOOK_ENABLED" : "PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED"]) {
    const changed = configs(explicitFolder);
    changed[index].vars[flag] = "true";
    assert.ok(validatePortalReleaseProfile(explicitFolder, ...changed).some(error => error.includes(flag)));
  }
});

test("paused authenticated delivery preserves enforcement and revocation while blocking authority expansion", () => {
  const [pausedClient, pausedOperations] = configs(authenticatedPaused);
  assert.deepEqual(validatePortalReleaseProfile(authenticatedPaused, pausedClient, pausedOperations), []);
  for (const config of [pausedClient, pausedOperations]) {
    assert.equal(config.vars.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED, "true");
    assert.equal(config.vars.AUTHENTICATED_DELIVERY_GRANTS_ENABLED, "true");
    assert.equal(config.vars.PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED, "true");
    assert.equal(config.vars.AUTHENTICATED_DELIVERY_CREATION_ENABLED, "false");
  }
  const [activeClient, activeOperations] = configs(authenticated);
  const pausedErrors = validatePortalReleaseProfile(authenticatedPaused, activeClient, activeOperations);
  assert.ok(pausedErrors.length > 0);
  assert.ok(pausedErrors.every(error => error.includes("AUTHENTICATED_DELIVERY_CREATION_ENABLED")));
  const activeErrors = validatePortalReleaseProfile(authenticated, pausedClient, pausedOperations);
  assert.ok(activeErrors.length > 0);
  assert.ok(activeErrors.every(error => error.includes("AUTHENTICATED_DELIVERY_CREATION_ENABLED")));
});
