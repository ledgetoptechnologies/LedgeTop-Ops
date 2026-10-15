import assert from "node:assert/strict";
import test from "node:test";

import {
  ClientPortalPlaywrightTransportError,
  createClientPortalPlaywrightContextFetcher,
} from "./staging-client-portal-playwright-context-request.mjs";

const origin = "https://client-staging.ledgetopdroneservices.com";
const homeUrl = `${origin}/api/client/v2/operations/home`;

function apiResponse({ url = homeUrl, status = 200, headers = { "content-type": "application/json" },
  body = Buffer.from('{"ok":true}'), onBody, disposeError } = {}) {
  const state = { disposed: 0 };
  return { state,
    value: {
      url: () => url,
      status: () => status,
      statusText: () => status === 200 ? "OK" : "Result",
      headers: () => headers,
      body: async () => { onBody?.(); return body; },
      dispose: async () => { state.disposed += 1; if (disposeError) throw disposeError; },
    } };
}

function fixture(response, { pageUrl = `${origin}/portal`, contextOverride, requestOverride } = {}) {
  const calls = [], state = { pageUrl, closed: false };
  const request = requestOverride ?? {
    get: async (url, options) => { calls.push({ method: "GET", url, options }); return response.value; },
    head: async (url, options) => { calls.push({ method: "HEAD", url, options }); return response.value; },
  };
  const context = contextOverride ?? { request };
  const page = { url: () => state.pageUrl, context: () => context, isClosed: () => state.closed };
  return { calls, context, page, request, state };
}

const init = (extra = {}) => ({ method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store",
  headers: { Accept: "application/json" }, ...extra });

test("uses the supplied BrowserContext request cookie jar and returns a bounded standard Response", async () => {
  const api = apiResponse({ headers: { "content-type": "application/json", "content-length": "11", "set-cookie": "secret=value" } });
  const f = fixture(api);
  const fetcher = createClientPortalPlaywrightContextFetcher({ page: f.page, context: f.context, timeoutMs: 12_000 });
  const response = await fetcher(homeUrl, init());
  assert(response instanceof Response);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"ok":true}');
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(f.calls, [{ method: "GET", url: homeUrl, options: {
    headers: { accept: "application/json" }, timeout: 12_000, maxRedirects: 0, maxRetries: 0, failOnStatusCode: false,
  } }]);
  assert.equal(api.state.disposed, 1);
});

test("rejects credential headers, disallowed hosts and routes before Playwright sends anything", async () => {
  const api = apiResponse(), f = fixture(api);
  const fetcher = createClientPortalPlaywrightContextFetcher({ page: f.page, context: f.context });
  await assert.rejects(() => fetcher(homeUrl, init({ headers: { Cookie: "CF_Authorization=secret" } })), /playwright_credential_header_forbidden/);
  await assert.rejects(() => fetcher("https://client.ledgetopdroneservices.com/api/client/v2/operations/home", init()), /playwright_request_destination_denied/);
  await assert.rejects(() => fetcher(homeUrl.replace("https://", "https://user:secret@"), init()), /playwright_request_destination_denied/);
  await assert.rejects(() => fetcher(`${origin}/api/client/operations/data/files/raw/storage/key/download`, init()), /playwright_request_destination_denied/);
  assert.deepEqual(f.calls, []);
  assert.equal(api.state.disposed, 0);
});

test("requires the exact open staging page and supplied BrowserContext before every request", async () => {
  const api = apiResponse(), wrongContext = { request: { get() {}, head() {} } };
  const f = fixture(api);
  assert.throws(() => createClientPortalPlaywrightContextFetcher({ page: { ...f.page, context: () => wrongContext }, context: f.context }),
    /playwright_context_identity_mismatch/);
  assert.throws(() => createClientPortalPlaywrightContextFetcher({ page: { ...f.page, url: () => "https://client.ledgetopdroneservices.com/portal" }, context: f.context }),
    /playwright_page_origin_mismatch/);
  const fetcher = createClientPortalPlaywrightContextFetcher({ page: f.page, context: f.context });
  f.state.closed = true;
  await assert.rejects(() => fetcher(homeUrl, init()), /playwright_context_identity_mismatch/);
  assert.deepEqual(f.calls, []);
});

test("rejects redirect status and response URL drift and always disposes", async () => {
  const redirect = apiResponse({ status: 302, headers: { location: `${origin}/portal` }, body: Buffer.alloc(0) });
  const first = fixture(redirect), firstFetcher = createClientPortalPlaywrightContextFetcher({ page: first.page, context: first.context });
  await assert.rejects(() => firstFetcher(homeUrl, init()), /playwright_redirect_denied/);
  assert.equal(redirect.state.disposed, 1);
  const drift = apiResponse({ url: `${origin}/api/client/v2/operations/home?changed=1` });
  const second = fixture(drift), secondFetcher = createClientPortalPlaywrightContextFetcher({ page: second.page, context: second.context });
  await assert.rejects(() => secondFetcher(homeUrl, init()), /playwright_response_url_mismatch/);
  assert.equal(drift.state.disposed, 1);
});

test("prechecks declared length and postchecks Playwright's buffered body, disposing both failures", async () => {
  const declared = apiResponse({ headers: { "content-length": String(5 * 1024 * 1024 + 1) },
    body: Buffer.from("body"), onBody: () => { throw new Error("body must not be read"); } });
  const first = fixture(declared), firstFetcher = createClientPortalPlaywrightContextFetcher({ page: first.page, context: first.context });
  await assert.rejects(() => firstFetcher(homeUrl, init()), /playwright_response_too_large/);
  assert.equal(declared.state.disposed, 1);
  const buffered = apiResponse({ body: Buffer.alloc(5 * 1024 * 1024 + 1) });
  const second = fixture(buffered), secondFetcher = createClientPortalPlaywrightContextFetcher({ page: second.page, context: second.context });
  await assert.rejects(() => secondFetcher(homeUrl, init()), /playwright_response_too_large/);
  assert.equal(buffered.state.disposed, 1);
});

test("rejects page drift after a response and disposes before surfacing the error", async () => {
  let f;
  const api = apiResponse({ onBody: () => { f.state.pageUrl = "https://example.test/"; } });
  f = fixture(api);
  const fetcher = createClientPortalPlaywrightContextFetcher({ page: f.page, context: f.context });
  await assert.rejects(() => fetcher(homeUrl, init()), /playwright_page_origin_mismatch/);
  assert.equal(api.state.disposed, 1);
});

test("supports genuine HEAD through BrowserContext.request without reading a buffered body", async () => {
  const downloadUrl = `${origin}/api/client/operations/data/files/ond1_file/download`;
  const api = apiResponse({ url: downloadUrl, headers: { "content-length": "123", "content-type": "text/plain" },
    onBody: () => { throw new Error("HEAD body must not be read"); } });
  const f = fixture(api), fetcher = createClientPortalPlaywrightContextFetcher({ page: f.page, context: f.context });
  const response = await fetcher(downloadUrl, init({ method: "HEAD" }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(f.calls[0].method, "HEAD");
  assert.equal(api.state.disposed, 1);
});

test("bounds timeout and reports disposal failure without exposing request data", async () => {
  const api = apiResponse({ disposeError: new Error("secret disposal detail") }), f = fixture(api);
  assert.throws(() => createClientPortalPlaywrightContextFetcher({ page: f.page, context: f.context, timeoutMs: 31_000 }),
    /playwright_timeout_out_of_bounds/);
  const fetcher = createClientPortalPlaywrightContextFetcher({ page: f.page, context: f.context });
  await assert.rejects(() => fetcher(homeUrl, init()), error => error instanceof ClientPortalPlaywrightTransportError
    && error.code === "playwright_response_dispose_failed" && !error.message.includes("secret"));
  const secretFailure = fixture(apiResponse(), { requestOverride: {
    get: async () => { throw new Error(`network failure for ${homeUrl}?handle=ond1_secret`); },
    head: async () => { throw new Error("must not call"); },
  } });
  const secretFetcher = createClientPortalPlaywrightContextFetcher({ page: secretFailure.page, context: secretFailure.context });
  await assert.rejects(() => secretFetcher(homeUrl, init()), error => error instanceof ClientPortalPlaywrightTransportError
    && error.code === "playwright_request_failed" && !error.message.includes("ond1_secret") && !error.message.includes(origin));
});
