import {
  CLIENT_PORTAL_BROWSER_ACCEPTANCE_ORIGIN,
  isClientPortalBrowserAcceptanceUrl,
} from "./staging-client-portal-browser-context-acceptance.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "cookie",
  "cf-access-jwt-assertion",
  "cf-access-client-id",
  "cf-access-client-secret",
  "origin",
]);
const OMITTED_RESPONSE_HEADERS = new Set([
  "authorization",
  "cf-access-jwt-assertion",
  "set-cookie",
  "set-cookie2",
]);

export class ClientPortalPlaywrightTransportError extends Error {
  constructor(code) {
    super(code);
    this.name = "ClientPortalPlaywrightTransportError";
    this.code = code;
  }
}

const fail = code => { throw new ClientPortalPlaywrightTransportError(code); };

function currentPage(page, context, request) {
  if (!page || typeof page.url !== "function" || typeof page.context !== "function"
    || typeof page.isClosed !== "function" || page.isClosed() || page.context() !== context
    || context?.request !== request) fail("playwright_context_identity_mismatch");
  let url;
  try { url = new URL(page.url()); } catch { fail("playwright_page_origin_mismatch"); }
  if (url.origin !== CLIENT_PORTAL_BROWSER_ACCEPTANCE_ORIGIN || url.protocol !== "https:"
    || url.username || url.password) fail("playwright_page_origin_mismatch");
}

function requestInput(urlValue, init) {
  let url;
  try { url = new URL(urlValue); } catch { fail("playwright_request_destination_denied"); }
  if (!isClientPortalBrowserAcceptanceUrl(url)) fail("playwright_request_destination_denied");
  if (!init || typeof init !== "object" || Array.isArray(init)) fail("playwright_request_init_required");
  const method = String(init.method ?? "GET").toUpperCase();
  if (!new Set(["GET", "HEAD"]).has(method) || init.body !== undefined && init.body !== null)
    fail("playwright_read_only_request_required");
  if (init.credentials !== "same-origin" || init.redirect !== "error" || init.cache !== "no-store")
    fail("playwright_native_context_policy_required");
  let headers;
  try { headers = new Headers(init.headers); } catch { fail("playwright_invalid_request_headers"); }
  for (const name of FORBIDDEN_HEADERS) if (headers.has(name)) fail("playwright_credential_header_forbidden");
  return { url, method, headers: Object.fromEntries(headers) };
}

function declaredLength(headers) {
  const raw = headers["content-length"];
  if (raw === undefined) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) fail("playwright_invalid_content_length");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_RESPONSE_BYTES) fail("playwright_response_too_large");
  return value;
}

function safeResponseHeaders(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("playwright_invalid_response_headers");
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(value))
      fail("playwright_invalid_response_headers");
    if (!OMITTED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  }
  return headers;
}

function boundedTimeout(value) {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > MAX_TIMEOUT_MS)
    fail("playwright_timeout_out_of_bounds");
  return timeout;
}

function apiResponseShape(value) {
  if (!value || typeof value.status !== "function" || typeof value.statusText !== "function"
    || typeof value.headers !== "function" || typeof value.url !== "function"
    || typeof value.body !== "function" || typeof value.dispose !== "function")
    fail("playwright_invalid_api_response");
  return value;
}

/**
 * Creates the standard-Response fetcher consumed by the read-only portal
 * acceptance core. Playwright APIResponse.body() buffers before returning, so
 * the post-body cap below is a memory/output bound, not a network-streaming
 * bound. Content-Length is rejected before buffering when it is present.
 */
export function createClientPortalPlaywrightContextFetcher({ page, context, timeoutMs } = {}) {
  const request = context?.request;
  if (!request || typeof request.get !== "function" || typeof request.head !== "function")
    fail("playwright_request_context_required");
  const timeout = boundedTimeout(timeoutMs);
  currentPage(page, context, request);

  return async function clientPortalPlaywrightContextFetcher(urlValue, init = {}) {
    const input = requestInput(urlValue, init);
    currentPage(page, context, request);
    const options = { headers: input.headers, timeout, maxRedirects: 0, maxRetries: 0, failOnStatusCode: false };
    let apiResponse, result, error;
    try {
      apiResponse = apiResponseShape(await (input.method === "HEAD"
        ? request.head(input.url.toString(), options)
        : request.get(input.url.toString(), options)));
      currentPage(page, context, request);
      if (apiResponse.url() !== input.url.toString()) fail("playwright_response_url_mismatch");
      const status = apiResponse.status();
      if (!Number.isInteger(status) || status < 200 || status > 599) fail("playwright_invalid_response_status");
      if (status >= 300 && status < 400) fail("playwright_redirect_denied");
      const statusText = apiResponse.statusText();
      if (typeof statusText !== "string" || statusText.length > 128 || /[\r\n]/u.test(statusText))
        fail("playwright_invalid_response_status");
      const responseHeaders = safeResponseHeaders(apiResponse.headers());
      declaredLength(Object.fromEntries(responseHeaders));
      const body = input.method === "HEAD" ? null : await apiResponse.body();
      if (body !== null && (!ArrayBuffer.isView(body) || body.byteLength > MAX_RESPONSE_BYTES))
        fail("playwright_response_too_large");
      currentPage(page, context, request);
      if (apiResponse.url() !== input.url.toString()) fail("playwright_response_url_mismatch");
      const nullBody = input.method === "HEAD" || [101, 204, 205, 304].includes(status);
      result = new Response(nullBody ? null : body, { status, statusText, headers: responseHeaders });
    } catch (caught) {
      error = caught instanceof ClientPortalPlaywrightTransportError
        ? caught : new ClientPortalPlaywrightTransportError("playwright_request_failed");
    }
    if (apiResponse) {
      try { await apiResponse.dispose(); }
      catch { if (!error) error = new ClientPortalPlaywrightTransportError("playwright_response_dispose_failed"); }
    }
    if (error) throw error;
    return result;
  };
}
