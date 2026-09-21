import test from "node:test";
import assert from "node:assert/strict";
import { parseBrowserContextJoinedAcceptanceConfig, parseJoinedAcceptanceConfig, runJoinedAcceptance,
  runJoinedAcceptanceWithBrowserContext, JoinedAcceptanceError } from "./ops-project-v2-joined-live-acceptance.mjs";

const identity = {
  OPS_BASE_URL: "https://ops-staging.ledgetopdroneservices.com",
  OPS_ACCEPTANCE_ALLOW_MUTATIONS: "allow",
  OPS_ACCEPTANCE_PREFIX: "ops-joined-acceptance-test",
  OPS_PROJECT_ALPHA_SOURCE_ID: "project-alpha:staging",
  OPS_PROJECT_ALPHA_APPLICATION_ID: "150cb108-af37-4973-ab6e-f6d991a6e8c8",
  OPS_ACCEPTANCE_AUTHORIZATION_GENERATION: "7",
  OPS_ACCEPTANCE_SCOPES_JSON: JSON.stringify([{ scopeKind: "business_area", businessAreaId: "drone", divisionId: null }]),
  OPS_ACCEPTANCE_ORGANIZATION_RECORD_ID: "org-staging-001",
  OPS_ACCEPTANCE_ORGANIZATION_PUBLIC_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  OPS_ACCEPTANCE_ORGANIZATION_REVISION: "1",
  OPS_ACCEPTANCE_ORGANIZATION_PROJECTION_SHA256: "b".repeat(64),
  OPS_ACCEPTANCE_PUBLIC_LINK_URL: "https://delivery-staging.ledgetopdroneservices.com/s/test-token",
  OPS_SESSION_COOKIE: "CF_Authorization=redacted-test-cookie",
};

function response(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}

function activated(commandId, externalProjectId, replayed, version) {
  return { stage: "activate", outcome: { status: "activated", activationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", settlementId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", commandId, externalProjectId, version, replayed } };
}

test("joined mutation config refuses production and requires explicit session/mutation gates", async () => {
  await assert.rejects(() => parseJoinedAcceptanceConfig({ ...identity, OPS_BASE_URL: "https://ops.ledgetopdroneservices.com", OPS_SESSION_COOKIE: "x=y" }), { code: "production_or_noncanonical_operations_origin" });
  assert.equal((await parseJoinedAcceptanceConfig({ ...identity, OPS_ACCEPTANCE_ALLOW_MUTATIONS: "" })).mutate, false);
  await assert.rejects(() => parseJoinedAcceptanceConfig({ ...identity, OPS_SESSION_COOKIE: "" }), { code: "operations_session_required" });
  await assert.rejects(() => parseJoinedAcceptanceConfig({ ...identity, OPS_ACCEPTANCE_PUBLIC_LINK_URL: "https://portal.ledgetopdroneservices.com/s/abc" }), { code: "production_or_nonstaging_public_link" });
  const assertion = "header.payload.signature";
  assert.equal((await parseJoinedAcceptanceConfig({ ...identity, OPS_CF_ACCESS_JWT_ASSERTION: assertion })).accessAssertion, assertion);
  await assert.rejects(() => parseJoinedAcceptanceConfig({ ...identity, OPS_CF_ACCESS_JWT_ASSERTION: "not-a-jwt" }), { code: "invalid_access_assertion" });
});

test("joined runner performs disposable create, exact replay, changed-body conflict, and sanitized public-link evidence", async () => {
  const assertion = "header.payload.signature";
  const config = { ...(await parseJoinedAcceptanceConfig(identity)), accessAssertion: assertion };
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init: { ...init, headers: { ...init.headers } } });
    if (url.endsWith("/api/session")) {
      assert.equal(init.headers.Cookie, identity.OPS_SESSION_COOKIE);
      assert.equal(init.headers.Origin, identity.OPS_BASE_URL);
      assert.equal(init.headers["Cf-Access-Jwt-Assertion"], assertion);
      return response(200, { csrfToken: "csrf-test-token-1234", user: { isAdministrator: true, permissions: ["integrations.manage"] } });
    }
    if (init.method === "GET") return new Response("stable-public-link", { status: 200, headers: { "content-type": "text/html" } });
    const body = JSON.parse(init.body);
    assert.equal(body.command.expectedAuthorizationGeneration, identity.OPS_ACCEPTANCE_AUTHORIZATION_GENERATION);
    assert.deepEqual(body.scopes, JSON.parse(identity.OPS_ACCEPTANCE_SCOPES_JSON));
    assert.equal(init.headers.Cookie, identity.OPS_SESSION_COOKIE);
    assert.equal(init.headers.Origin, identity.OPS_BASE_URL);
    assert.equal(init.headers["Cf-Access-Jwt-Assertion"], assertion);
    assert.equal(init.headers["X-CSRF-Token"], "csrf-test-token-1234");
    assert.equal(init.headers["Idempotency-Key"], body.command.commandId);
    if (calls.filter(call => call.init.method === "POST").length === 1) return response(200, activated(body.command.commandId, body.command.externalId, false, 1));
    if (calls.filter(call => call.init.method === "POST").length === 2) return response(200, activated(body.command.commandId, body.command.externalId, true, 1));
    assert.equal(body.command.project.name.endsWith(" changed"), true);
    return response(409, { stage: "plan", outcome: { status: "conflict", reason: "command_id" } });
  };
  const report = await runJoinedAcceptance(config, { fetcher, now: Date.parse("2026-09-18T12:00:00Z") });
  assert.equal(report.status, "passed");
  assert.equal(report.exactReplay.replay.outcome.replayed, true);
  assert.equal(report.changedBodyConflict.outcome.reason, "command_id");
  assert.equal(report.readSettlement.status, "evidence_present");
  assert.equal(report.canonicalActivation.version, 1);
  assert.equal(report.publicLink.before.status, 200);
  assert.equal(report.publicLink.after.bodySha256.length, 64);
  assert.equal(JSON.stringify(report).includes("test-token"), false);
  assert.equal(JSON.stringify(report).includes(identity.OPS_SESSION_COOKIE), false);
  assert.equal(JSON.stringify(report).includes(assertion), false);
  assert.equal(calls.filter(call => call.init.method === "POST").length, 3);
  assert.equal(calls.filter(call => call.url.endsWith("/api/session")).length, 1);
});

test("joined runner refuses non-activation success and oversized responses", async () => {
  const config = await parseJoinedAcceptanceConfig(identity);
  await assert.rejects(() => runJoinedAcceptance(config, { fetcher: async url => url.endsWith("/api/session") ? response(200, { csrfToken: "short", user: { isAdministrator: true, permissions: ["integrations.manage"] } }) : response(404, {}) }), { code: "invalid_operations_session" });
  await assert.rejects(() => runJoinedAcceptance(config, { fetcher: async (url, init) => url.endsWith("/api/session") ? response(200, { csrfToken: "csrf-test-token-1234", user: { isAdministrator: true, permissions: ["integrations.manage"] } }) : init.method === "GET" ? response(404, {}) : response(200, { stage: "settle", outcome: { status: "settled" } }) }), { code: "activation_missing" });
  await assert.rejects(() => runJoinedAcceptance(config, { fetcher: async (url, init) => url.endsWith("/api/session") ? response(200, { csrfToken: "csrf-test-token-1234", user: { isAdministrator: true, permissions: ["integrations.manage"] } }) : init.method === "GET" ? response(404, {}) : response(409, { stage: "activate", outcome: { status: "activated", activationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", settlementId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", externalProjectId: "wrong", version: 1, replayed: false } }) }), { code: "operations_http_409" });
  await assert.rejects(() => runJoinedAcceptance(config, { fetcher: async (url, init) => url.endsWith("/api/session") ? response(200, { csrfToken: "csrf-test-token-1234", user: { isAdministrator: true, permissions: ["integrations.manage"] } }) : init.method === "GET" ? response(404, {}) : new Response("x".repeat(70_000), { status: 200 }) }), { code: "response_too_large" });
});

test("joined runner cannot be called without explicit mutation permission", async () => {
  await assert.rejects(() => runJoinedAcceptance({ mutate: false }, { fetcher: async () => response(200, {}) }), { code: "mutation_allow_required" });
  assert.equal(JoinedAcceptanceError.prototype instanceof Error, true);
});

test("joined config permits a reviewed global grant and rejects stale generation syntax", async () => {
  assert.deepEqual((await parseJoinedAcceptanceConfig({ ...identity, OPS_ACCEPTANCE_SCOPES_JSON: "[]" })).scopes, []);
  await assert.rejects(() => parseJoinedAcceptanceConfig({ ...identity, OPS_ACCEPTANCE_AUTHORIZATION_GENERATION: "01" }), { code: "invalid_authorization_generation" });
});

test("joined runner fails closed when an existing public link changes", async () => {
  const config = await parseJoinedAcceptanceConfig(identity);
  let publicReads = 0, posts = 0;
  await assert.rejects(() => runJoinedAcceptance(config, { fetcher: async (url, init = {}) => {
    if (url.endsWith("/api/session")) return response(200, { csrfToken: "csrf-test-token-1234", user: { isAdministrator: true, permissions: ["integrations.manage"] } });
    if (init.method === "GET") return new Response(++publicReads === 1 ? "before" : "after", { status: 200, headers: { "content-type": "text/html" } });
    const body = JSON.parse(init.body);
    posts += 1;
    if (posts === 1) return response(200, activated(body.command.commandId, body.command.externalId, false, 1));
    if (posts === 2) return response(200, activated(body.command.commandId, body.command.externalId, true, 1));
    return response(409, { stage: "plan", outcome: { status: "conflict", reason: "command_id" } });
  } }), { code: "public_link_changed" });
});

test("browser-context config never accepts copied browser credentials", async () => {
  const { OPS_SESSION_COOKIE: _cookie, ...browserIdentity } = identity;
  const config = await parseBrowserContextJoinedAcceptanceConfig(browserIdentity);
  assert.equal(config.browserContext, true);
  assert.equal(Object.hasOwn(config, "cookie"), false);
  assert.equal(Object.hasOwn(config, "accessAssertion"), false);
  for (const env of [
    { ...browserIdentity, OPS_SESSION_COOKIE: identity.OPS_SESSION_COOKIE },
    { ...browserIdentity, OPS_STORAGE_STATE: ".backups/browser-state.json" },
    { ...browserIdentity, OPS_CF_ACCESS_JWT_ASSERTION: "header.payload.signature" },
  ]) await assert.rejects(() => parseBrowserContextJoinedAcceptanceConfig(env), { code: "browser_context_credentials_forbidden" });
  await assert.rejects(() => runJoinedAcceptanceWithBrowserContext({ ...config, cookie: identity.OPS_SESSION_COOKIE }, {
    browserContextFetcher: async () => { throw new Error("must not fetch"); },
  }), { code: "browser_context_credentials_forbidden" });
  await assert.rejects(() => runJoinedAcceptanceWithBrowserContext({ ...config, accessAssertion: "header.payload.signature" }, {
    browserContextFetcher: async () => { throw new Error("must not fetch"); },
  }), { code: "browser_context_credentials_forbidden" });
});

test("browser-context runner uses native same-origin auth without forwarding cookie headers", async () => {
  const { OPS_SESSION_COOKIE: _cookie, ...browserIdentity } = identity;
  const config = await parseBrowserContextJoinedAcceptanceConfig(browserIdentity);
  const browserCalls = [], publicCalls = [];
  let posts = 0;
  const report = await runJoinedAcceptanceWithBrowserContext(config, {
    now: Date.parse("2026-09-20T12:00:00Z"),
    browserContextFetcher: async (url, init = {}) => {
      browserCalls.push({ url, init: { ...init, headers: { ...init.headers } } });
      assert.equal(new URL(url).origin, identity.OPS_BASE_URL);
      assert.equal(init.credentials, "same-origin");
      assert.equal(init.headers.Cookie, undefined);
      assert.equal(init.headers.cookie, undefined);
      assert.equal(init.headers["Cf-Access-Jwt-Assertion"], undefined);
      assert.equal(init.headers.Origin, undefined);
      if (url.endsWith("/api/session"))
        return response(200, { csrfToken: "csrf-test-token-1234", user: { isAdministrator: true, permissions: ["integrations.manage"] } });
      const body = JSON.parse(init.body);
      posts += 1;
      if (posts === 1) return response(200, activated(body.command.commandId, body.command.externalId, false, 1));
      if (posts === 2) return response(200, activated(body.command.commandId, body.command.externalId, true, 1));
      return response(409, { stage: "plan", outcome: { status: "conflict", reason: "command_id" } });
    },
    publicFetcher: async (url, init = {}) => {
      publicCalls.push({ url, init: { ...init, headers: { ...init.headers } } });
      assert.equal(url, identity.OPS_ACCEPTANCE_PUBLIC_LINK_URL);
      assert.equal(init.credentials, "omit");
      assert.equal(init.headers.Cookie, undefined);
      assert.equal(init.headers.cookie, undefined);
      return new Response("stable-public-link", { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  assert.equal(report.status, "passed");
  assert.equal(browserCalls.length, 4);
  assert.equal(publicCalls.length, 2);
  assert.equal(JSON.stringify(report).includes(identity.OPS_SESSION_COOKIE), false);
});

test("browser-context runner fails closed before reaching an unapproved Operations origin", async () => {
  const { OPS_SESSION_COOKIE: _cookie, ...browserIdentity } = identity;
  const config = await parseBrowserContextJoinedAcceptanceConfig(browserIdentity);
  let called = false;
  await assert.rejects(() => runJoinedAcceptanceWithBrowserContext({ ...config, origin: "https://ops.ledgetopdroneservices.com" }, {
    browserContextFetcher: async () => { called = true; throw new Error("must not fetch"); },
    publicFetcher: async () => { called = true; throw new Error("must not fetch"); },
  }), { code: "production_or_noncanonical_operations_origin" });
  assert.equal(called, false);
});
