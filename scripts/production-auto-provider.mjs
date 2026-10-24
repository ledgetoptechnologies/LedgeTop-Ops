/** Concrete finite Cloudflare transport. This module does not read credentials,
 * run Wrangler, approve source/profile gates, or reconcile ambiguous writes.
 * Callbacks must persist private raw responses and reject repeated intents.
 * API contracts: Workers direct-upload, version upload, deployments, subdomain.
 * Multipart map MIME matches locked Wrangler 4.118 createWorkerUploadForm. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { PROFILE, capture } from "./production-deploy.mjs";
import { uploadAssetManifest } from "./production-auto-upload.mjs";
import { ledgerBytes, validateAssetLedger } from "./production-auto-assets.mjs";
import { createAssetVerifierSource } from "./production-auto-verify.mjs";

const API = "https://api.cloudflare.com/client/v4/accounts/";
const WORKERS = ["ledgetop-ops", "ledgetop-clients"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u, TEMP = /^ops-ui-verify-[a-f0-9]{24}$/u;
const MAX_RESPONSE = 32 * 1024 * 1024, MAX_MODULE = 32 * 1024 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw Error("production_provider_refused_or_uncertain_no_retry"); };
const need = value => { if (!value) fail(); };
const jwt = value => typeof value === "string" && value.length <= 16384 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value);
const prod = name => { need(WORKERS.includes(name)); return name; };
const version = id => { need(typeof id === "string" && UUID.test(id)); return id; };
function pinnedModule(value) {
  need(value && Object.keys(value).sort().join() === "bytes,sha256" && Buffer.isBuffer(value.bytes)
    && value.bytes.length > 0 && value.bytes.length <= MAX_MODULE && SHA.test(value.sha256) && hash(value.bytes) === value.sha256);
  return Buffer.from(value.bytes);
}
function ownAnnotations(value) {
  need(value && Object.keys(value).sort().join() === "workers/message,workers/tag"
    && typeof value["workers/message"] === "string" && value["workers/message"].length > 0 && value["workers/message"].length <= 512
    && typeof value["workers/tag"] === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value["workers/tag"])
    && !/[\x00-\x1f\x7f]/u.test(value["workers/message"]));
  return structuredClone(value);
}
function rootAssetConfig(value, requireExplicitRoot = false) {
  need(value && Object.getPrototypeOf(value) === Object.prototype);
  if (requireExplicitRoot || Object.hasOwn(value, "base_path")) need(value.base_path === "/");
  const { base_path, ...config } = value;
  return config;
}

export class ProductionCloudflareProvider {
  #token; #fetch; #intent; #persist; #profile; #timeout; #temporary = new Map();
  constructor({ accountId, token, fetchImpl = fetch, recordIntent, persistResponse, profile = PROFILE, timeoutMs = 30000 }) {
    need(typeof accountId === "string" && /^[a-f0-9]{32}$/u.test(accountId)
      && typeof token === "string" && token.length >= 20 && token.length <= 16384 && !/[^\x21-\x7e]/u.test(token)
      && typeof fetchImpl === "function" && typeof recordIntent === "function" && typeof persistResponse === "function"
      && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000);
    this.account = accountId; this.#token = token; this.#fetch = fetchImpl; this.#intent = recordIntent;
    this.#persist = persistResponse; this.#profile = structuredClone(profile); this.#timeout = timeoutMs;
  }
  async #request(suffix, { method = "GET", body, intent, allow404 = false, headers = {} } = {}) {
    const requestId = randomUUID();
    need(typeof suffix === "string" && suffix.length <= 512 && /^\/workers\/[A-Za-z0-9_/?=&.-]+$/u.test(suffix)
      && !suffix.includes("..") && !suffix.includes("//") && !suffix.includes("%"));
    if (method !== "GET") {
      need(intent && ["POST", "PUT", "DELETE"].includes(method));
      try { await this.#intent(Object.freeze({ requestId, method, path: suffix, ...structuredClone(intent), automaticRetry: false })); }
      catch { fail(); } // No request until the intent is durable.
    }
    const controller = new AbortController(); let response, reader, raw = Buffer.alloc(0), persisted = false;
    const persistOnce = async value => { if (persisted) return; persisted = true; await this.#persist(value); };
    const operation = (async () => {
      try {
        response = await this.#fetch(API + this.account + suffix, { method, redirect: "error", signal: controller.signal,
          headers: { Authorization: "Bearer " + this.#token, Accept: "application/json", ...headers }, ...(body === undefined ? {} : { body }) });
        need(response instanceof Response && !response.redirected && !controller.signal.aborted);
        const length = response.headers.get("Content-Length"); need(length === null || /^\d+$/u.test(length) && Number(length) <= MAX_RESPONSE);
        reader = response.body?.getReader(); const chunks = []; let size = 0;
        if (reader) for (;;) {
          const next = await reader.read(); need(!controller.signal.aborted); if (next.done) break;
          size += next.value.byteLength; need(size <= MAX_RESPONSE); chunks.push(Buffer.from(next.value));
        }
        raw = Buffer.concat(chunks, size); let parsed; try { parsed = JSON.parse(raw.toString("utf8")); } catch { /* Persist malformed response privately. */ }
        const errorCodes = Array.isArray(parsed?.errors) ? parsed.errors.map(e => e.code).filter(Number.isSafeInteger) : [];
        await persistOnce({ requestId, method, path: suffix, status: response.status, errorCodes, rawResponse: raw });
        if (allow404 && response.status === 404) return { status: 404, result: null };
        need([200, 201, 202].includes(response.status) && parsed?.success === true && parsed.result !== undefined
          && (parsed.errors == null || Array.isArray(parsed.errors) && parsed.errors.length === 0));
        if (parsed.result_info?.total_pages > 1) need(/^\/workers\/scripts\/[a-z-]+\/(deployments|versions)\?per_page=1$/u.test(suffix));
        return { status: response.status, result: parsed.result };
      } catch (error) {
        if (!persisted) try { await persistOnce({ requestId, method, path: suffix, status: response?.status ?? null,
          transportName: typeof error?.name === "string" ? error.name : null,
          transportCode: typeof error?.cause?.code === "string" ? error.cause.code : null, rawResponse: raw, incomplete: true }); } catch { /* Hold; never retry write. */ }
        fail();
      } finally { try { void reader?.cancel().catch(() => {}); } catch {} }
    })();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); try { void reader?.cancel().catch(() => {}); } catch {} reject(Error("production_provider_request_expired_no_retry"));
    }, this.#timeout); });
    try { return await Promise.race([operation, timeout]); } catch {
      if (!persisted) try { await persistOnce({ requestId, method, path: suffix, status: response?.status ?? null,
        rawResponse: raw, incomplete: true, expired: controller.signal.aborted }); } catch {}
      fail();
    }
    finally { clearTimeout(timer); }
  }
  /** capture-compatible bounded metadata GETs; no arbitrary provider endpoints. */
  async get(suffix) {
    need(/^\/workers\/(?:scripts\/(?:ledgetop-ops|ledgetop-clients|ledgetop-ops-sync)(?:\/(?:settings|schedules|subdomain|versions(?:\/[a-f0-9-]+)?|deployments(?:\/[a-f0-9-]+)?))?(?:\?per_page=1)?|workers\/(?:ledgetop-ops|ledgetop-clients|ledgetop-ops-sync)\/versions\/[a-f0-9-]+\?include=modules|subdomain)$/u.test(suffix));
    return (await this.#request(suffix)).result;
  }
  capture(options) { return capture(this, options); }
  uploadAssets(options) {
    const workerName = prod(options.workerName); need(typeof options.recordIntent === "function"); let pendingId;
    // The dedicated uploader owns its durable intent sequencing and timeout.
    // This transport wrapper additionally seals each raw acknowledgement/error.
    const fetchImpl = async (url, init) => {
      need(pendingId && [API + this.account + `/workers/scripts/${workerName}/assets-upload-session`,
        API + this.account + "/workers/assets/upload?base64=true"].includes(url) && init.method === "POST" && init.redirect === "error");
      const requestId = pendingId; pendingId = null; let response, reader, raw = Buffer.alloc(0), saved = false;
      try {
        response = await this.#fetch(url, init); need(response instanceof Response && !response.redirected);
        reader = response.body?.getReader(); need(reader); const chunks = []; let size = 0;
        const cancel = () => { void reader.cancel().catch(() => {}); }; init.signal.addEventListener("abort", cancel, { once: true });
        try { for (;;) { const next = await reader.read(); need(!init.signal.aborted); if (next.done) break;
          size += next.value.byteLength; need(size <= 8 * 1024 * 1024); chunks.push(Buffer.from(next.value));
        } } finally { init.signal.removeEventListener("abort", cancel); }
        raw = Buffer.concat(chunks, size); let body; try { body = JSON.parse(raw.toString("utf8")); } catch {}
        saved = true; await this.#persist({ requestId, method: "POST", path: new URL(url).pathname,
          status: response.status, rawResponse: raw, errorCodes: Array.isArray(body?.errors) ? body.errors.map(e => e.code).filter(Number.isSafeInteger) : [] });
        return new Response(raw, { status: response.status, headers: response.headers });
      } catch {
        if (!saved) try { await this.#persist({ requestId, method: "POST", path: new URL(url).pathname,
          status: response?.status ?? null, rawResponse: raw, incomplete: true }); } catch {}
        fail();
      } finally { try { void reader?.cancel().catch(() => {}); } catch {} }
    };
    return uploadAssetManifest({ ...options, accountId: this.account, token: this.#token, fetchImpl,
      recordIntent: async intent => { await options.recordIntent(intent); pendingId = randomUUID(); await this.#intent({ requestId: pendingId,
        ...intent, workerName, automaticRetry: false }); } });
  }
  async createInactiveVersion({ workerName, state, modules, ledger, assetCompletionToken, annotations }) {
    prod(workerName); const spec = Object.values(this.#profile.workers).find(v => v.name === workerName); need(spec);
    const parentId = version(state?.version?.id);
    need(state.latest === parentId && state.modern?.id === parentId && same(state.deployment?.versions, [{ version_id: parentId, percentage: 100 }])
      && same(state.version.resources?.script_runtime, spec.runtime)
      && same(rootAssetConfig(state.modern.assets?.config, true), rootAssetConfig(spec.metadata.assets?.config)) && jwt(assetCompletionToken));
    need(modules && Object.keys(modules).sort().join() === "js,sourceMap");
    const js = pinnedModule(modules.js), sourceMap = pinnedModule(modules.sourceMap);
    let map; try { map = JSON.parse(sourceMap.toString("utf8")); } catch { fail(); }
    need(map?.version === 3 && Array.isArray(map.sources) && Array.isArray(map.sourcesContent)
      && map.sources.length > 0 && map.sources.length === map.sourcesContent.length
      && map.sources.every(x => typeof x === "string") && map.sourcesContent.every(x => typeof x === "string") && typeof map.mappings === "string");
    const validLedger = validateAssetLedger(ledger, { workerName, accountId: this.account }); need(validLedger.parentVersionId === parentId);
    const json = ledgerBytes(validLedger), bindings = state.version.resources.bindings;
    need(Array.isArray(bindings) && bindings.length <= 1024 && bindings.every(b => typeof b.name === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u.test(b.name))
      && new Set(bindings.map(b => b.name)).size === bindings.length);
    need(same(bindings.filter(b => b.type === "assets"), [{ name: "ASSETS", type: "assets" }]));
    const metadata = { ...structuredClone(spec.metadata), main_module: "index.js", compatibility_date: spec.runtime.compatibility_date,
      compatibility_flags: [...spec.runtime.compatibility_flags], bindings: bindings.map(b => b.type === "assets"
        ? { name: "ASSETS", type: "assets" } : { name: b.name, type: "inherit" }), keep_bindings: [],
      // The approved native upload config can omit base_path for the API's root
      // default. Admit that omission only after proving the observed base is '/';
      // the coordinator still compares the complete returned config afterward.
      assets: { jwt: assetCompletionToken, config: structuredClone(spec.metadata.assets.config) }, annotations: ownAnnotations(annotations) };
    delete metadata.keep_assets; need(!Object.hasOwn(metadata, "migrations") && !Object.hasOwn(metadata.assets.config, "serve_directly"));
    const form = new FormData(); form.set("metadata", JSON.stringify(metadata));
    for (const [name, bytes, type] of [["index.js", js, "application/javascript+module"], ["index.js.map", sourceMap, "application/source-map"], ["__ops_release_ledger.json", json, "application/json"]])
      form.set(name, new Blob([bytes], { type }), name);
    const result = await this.#request(`/workers/scripts/${workerName}/versions?bindings_inherit=strict`, { method: "POST", body: form,
      intent: { phase: "worker-version-upload", hashes: [], workerName, parentVersionId: parentId, modules: { "index.js": hash(js), "index.js.map": hash(sourceMap), "__ops_release_ledger.json": hash(json) } } });
    version(result.result?.id); need(result.result.id !== parentId); return result.result;
  }
  async #deploy(workerName, versions, message, phase) {
    prod(workerName); need(typeof message === "string" && message.length > 0 && message.length <= 512 && !/[\x00-\x1f\x7f]/u.test(message));
    const body = { strategy: "percentage", versions, annotations: { "workers/message": message } };
    return (await this.#request(`/workers/scripts/${workerName}/deployments`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
      intent: { phase, workerName, versions } })).result;
  }
  stageVersion({ workerName, parentVersionId, candidateVersionId, message }) {
    version(parentVersionId); version(candidateVersionId); need(parentVersionId !== candidateVersionId);
    return this.#deploy(workerName, [{ version_id: parentVersionId, percentage: 100 }, { version_id: candidateVersionId, percentage: 0 }], message, "stage-zero-percent");
  }
  activateCandidate({ workerName, candidateVersionId, message }) {
    return this.#deploy(workerName, [{ version_id: version(candidateVersionId), percentage: 100 }], message, "activate-candidate");
  }
  readDeployment(workerName) { return this.get(`/workers/scripts/${prod(workerName)}/deployments?per_page=1`); }
  async createVerifier({ name, workerName, origin, entries, nonceHash, versionId }) {
    need(TEMP.test(name) && !this.#temporary.has(name)); prod(workerName);
    const source = createAssetVerifierSource({ workerName, origin, entries, nonceHash, versionId });
    const absent = await this.#request(`/workers/scripts/${name}`, { allow404: true }); need(absent.status === 404);
    this.#temporary.set(name, { sourceSHA256: hash(source), workerName, nonceHash, entries: structuredClone(entries) }); // Ambiguous creation still owns cleanup.
    const metadata = { main_module: "index.js", compatibility_date: this.#profile.workers.operations.runtime.compatibility_date,
      bindings: [{ name: "SOURCE_ASSETS", type: "service", service: workerName, environment: "production" }] };
    const form = new FormData(); form.set("metadata", JSON.stringify(metadata)); form.set("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
    await this.#request(`/workers/scripts/${name}`, { method: "PUT", body: form, intent: { phase: "temporary-verifier-create", name, workerName, sourceSHA256: hash(source) } });
    const settings = (await this.#request(`/workers/scripts/${name}/settings`)).result;
    need(same(settings.bindings, metadata.bindings));
    const enabled = await this.#request(`/workers/scripts/${name}/subdomain`, { method: "POST", body: JSON.stringify({ enabled: true, previews_enabled: false }),
      headers: { "Content-Type": "application/json", "Cloudflare-Workers-Script-Api-Date": "2025-08-01" }, intent: { phase: "temporary-verifier-enable", name } });
    need(enabled.result?.enabled === true && enabled.result.previews_enabled === false);
    const readback = await this.#request(`/workers/scripts/${name}/subdomain`);
    need(readback.result?.enabled === true && readback.result.previews_enabled === false);
    const subdomain = await this.get("/workers/subdomain"); need(typeof subdomain.subdomain === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/u.test(subdomain.subdomain));
    const verifierOrigin = `https://${name}.${subdomain.subdomain}.workers.dev`;
    this.#temporary.get(name).origin = verifierOrigin;
    return { name, origin: verifierOrigin, sourceSHA256: hash(source), bindingReadbackVerified: true };
  }
  async fetchVerifierAsset({ name, path, method = "GET", bearer, signal }) {
    const owned = this.#temporary.get(name);
    need(owned?.origin && !owned.deleteAttempted && ["GET", "HEAD"].includes(method)
      && owned.entries.some(entry => entry.path === path) && typeof bearer === "string" && /^[A-Za-z0-9_-]{43}$/u.test(bearer)
      && hash(bearer) === owned.nonceHash && !signal?.aborted);
    try {
      return await this.#fetch(owned.origin + path, { method, redirect: "error", cache: "no-store",
        headers: { Authorization: "Bearer " + bearer, "Accept-Encoding": "identity" }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.#timeout)]) : AbortSignal.timeout(this.#timeout) });
    } catch { fail(); }
  }
  async removeVerifier(name) {
    need(TEMP.test(name) && this.#temporary.has(name) && !this.#temporary.get(name).deleteAttempted);
    this.#temporary.get(name).deleteAttempted = true;
    await this.#request(`/workers/scripts/${name}`, { method: "DELETE", intent: { phase: "temporary-verifier-delete", name } });
  }
  async verifierAbsent(name) {
    need(TEMP.test(name) && this.#temporary.has(name) && this.#temporary.get(name).deleteAttempted);
    return (await this.#request(`/workers/scripts/${name}`, { allow404: true })).status === 404;
  }
}
export const newTemporaryVerifierName = () => "ops-ui-verify-" + randomBytes(12).toString("hex");
