import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  RETAINED_EXPORTS,
  RETAINED_RUNTIME_PINS,
  RETAINED_RUNTIME_SIZES,
  assertExactEsmExports,
  buildNativeStaffCohortReviewBridge,
  buildNativeStaffCohortReviewBridgeBundle,
  deriveRetainedRuntimeExports,
} from "./native-staff-cohort-review-bridge-build.mjs";
import {
  createNativeStaffCohortReviewBridge,
  NATIVE_STAFF_COHORT_REVIEW_PATH,
} from "./native-staff-cohort-review-bridge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("builder passes TypeScript checkJs undefined-name validation", () => {
  const tsc = path.join(ROOT, "apps", "operations", "node_modules", "typescript", "bin", "tsc");
  const builder = path.join(ROOT, "scripts", "native-staff-cohort-review-bridge-build.mjs");
  const result = spawnSync(process.execPath, [tsc, "--allowJs", "--checkJs", "--noEmit", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--typeRoots", path.join(ROOT, "apps", "operations", "node_modules", "@types"), builder], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("bridge intercepts only the exact POST route and otherwise preserves handler behavior", async () => {
  const env = { env: true };
  const ctx = { ctx: true };
  const calls = [];
  const retainedResult = Promise.resolve({ source: "retained" });
  const reviewResult = Promise.resolve({ source: "review" });
  const retained = {
    fetch(request, passedEnv, passedCtx) {
      assert.equal(this, retained);
      calls.push(["retained-fetch", request, passedEnv, passedCtx]);
      return retainedResult;
    },
    queue(...args) { assert.equal(this, retained); calls.push(["queue", ...args]); return args[0]; },
    scheduled(...args) { assert.equal(this, retained); calls.push(["scheduled", ...args]); return args[0]; },
  };
  const review = {
    fetch(request, passedEnv, passedCtx) {
      assert.equal(this, review);
      calls.push(["review-fetch", request, passedEnv, passedCtx]);
      return reviewResult;
    },
  };
  const bridge = createNativeStaffCohortReviewBridge(retained, review);

  const exact = new Request(`https://ops.example${NATIVE_STAFF_COHORT_REVIEW_PATH}?trace=1`, { method: "POST" });
  assert.equal(bridge.fetch(exact, env, ctx), reviewResult);
  assert.deepEqual(calls.pop(), ["review-fetch", exact, env, ctx]);

  for (const request of [
    new Request(`https://ops.example${NATIVE_STAFF_COHORT_REVIEW_PATH}`),
    new Request(`https://ops.example${NATIVE_STAFF_COHORT_REVIEW_PATH}/`, { method: "POST" }),
    new Request("https://ops.example/api/staff/current-cohort-review-extra", { method: "POST" }),
    new Request("https://ops.example/api/Staff/current-cohort-review", { method: "POST" }),
  ]) {
    assert.equal(bridge.fetch(request, env, ctx), retainedResult);
    assert.deepEqual(calls.pop(), ["retained-fetch", request, env, ctx]);
  }

  const queueArgs = [{ queue: "named" }, env];
  const scheduledArgs = [{ scheduledTime: 9 }, env, ctx];
  assert.equal(bridge.queue(...queueArgs), queueArgs[0]);
  assert.deepEqual(calls.pop(), ["queue", ...queueArgs]);
  assert.equal(bridge.scheduled(...scheduledArgs), scheduledArgs[0]);
  assert.deepEqual(calls.pop(), ["scheduled", ...scheduledArgs]);
});

test("delegate exceptions pass through unchanged", () => {
  const error = new Error("retained failure");
  const retained = {
    fetch() { throw error; },
    queue() { throw error; },
    scheduled() { throw error; },
  };
  const bridge = createNativeStaffCohortReviewBridge(retained, { fetch() { throw error; } });
  assert.throws(() => bridge.fetch(new Request("https://ops.example/"), {}, {}), value => value === error);
  assert.throws(() => bridge.queue({}, {}), value => value === error);
  assert.throws(() => bridge.scheduled({}, {}, {}), value => value === error);
  assert.throws(() => bridge.fetch(new Request(`https://ops.example${NATIVE_STAFF_COHORT_REVIEW_PATH}`, { method: "POST" }), {}, {}), value => value === error);
});

test("retained runtime module byte inventory is pinned", () => {
  assert.deepEqual(RETAINED_RUNTIME_PINS, {
    "index.js": "7973278da1b6c3958a3071bf639f61f4dfbe8a224099a62881e9704fd2fa8760",
    "__ops_c880_retention_ledger.json": "ccee26957c3c99ff28a1f4c4d6c5a29c6ce97033fd5978f00d1a5b3422c155aa",
    "__ops_release_ledger.json": "29c66e83afb37a9a2952c8606318949a5ee9ee05a62b3e8c8bb0e29c14080b1d",
  });
  assert.deepEqual(RETAINED_RUNTIME_SIZES, {
    "index.js": 6_884_992,
    "__ops_c880_retention_ledger.json": 66_973,
    "__ops_release_ledger.json": 60_961,
  });
});

test("ESM export inventory is parsed without executing code and detects missing or extra exports", async () => {
  const expected = ["alpha", "default"];
  const positive = await deriveRetainedRuntimeExports(
    Buffer.from('globalThis.__bridgeExportParserExecuted = true; export const alpha = 1; export default {};'),
    "positive.js",
  );
  assert.deepEqual(assertExactEsmExports(positive, expected), expected);
  assert.equal(globalThis.__bridgeExportParserExecuted, undefined);

  const missing = await deriveRetainedRuntimeExports(Buffer.from("export default {};"), "missing.js");
  assert.throws(() => assertExactEsmExports(missing, expected), /missing=\["alpha"\]/);

  const extra = await deriveRetainedRuntimeExports(Buffer.from("export const alpha = 1; export const surprise = 2; export default {};"), "extra.js");
  assert.throws(() => assertExactEsmExports(extra, expected), /extra=\["surprise"\]/);
});

test("retained-module drift fails before creating a candidate package", async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "ops-cohort-drift-"));
  t.after(async () => rm(scratch, { recursive: true, force: true }));
  const input = path.join(scratch, "retained");
  const output = path.join(scratch, "candidate");
  await mkdir(input);
  await writeFile(path.join(input, "index.js"), "unexpected runtime", { flag: "wx" });
  await writeFile(path.join(input, "__ops_c880_retention_ledger.json"), "ledger", { flag: "wx" });
  await writeFile(path.join(input, "__ops_release_ledger.json"), "ledger", { flag: "wx" });
  await assert.rejects(buildNativeStaffCohortReviewBridge({ retainedDir: input, outputDir: output }), /Retained module size mismatch for index\.js/);
  await assert.rejects(access(output), { code: "ENOENT" });
});

test("builder refuses source-tree output, linked input paths, and linked module files", async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "ops-cohort-boundary-"));
  t.after(async () => rm(scratch, { recursive: true, force: true }));
  const source = path.join(scratch, "source");
  const input = path.join(scratch, "retained");
  await mkdir(source);
  await mkdir(input);

  await assert.rejects(
    buildNativeStaffCohortReviewBridge({ retainedDir: input, outputDir: path.join(source, "output"), sourceRoot: source }),
    /outside the source tree/,
  );
  await assert.rejects(
    buildNativeStaffCohortReviewBridge({ retainedDir: input, outputDir: scratch, sourceRoot: source }),
    /outside the source tree/,
  );
  const sourceAlias = path.join(scratch, "source-junction");
  await symlink(source, sourceAlias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    buildNativeStaffCohortReviewBridge({ retainedDir: input, outputDir: path.join(sourceAlias, "output"), sourceRoot: source }),
    /Output parent path must not resolve through a symlink or junction/,
  );

  const linkedDirectory = path.join(scratch, "retained-junction");
  await symlink(input, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    buildNativeStaffCohortReviewBridge({ retainedDir: linkedDirectory, outputDir: path.join(scratch, "candidate"), sourceRoot: source }),
    /symlink or junction/,
  );

  const linkedFileTarget = path.join(scratch, "source-module.js");
  await writeFile(linkedFileTarget, "small", { flag: "wx" });
  await link(linkedFileTarget, path.join(input, "index.js"));
  await assert.rejects(
    buildNativeStaffCohortReviewBridge({ retainedDir: input, outputDir: path.join(scratch, "candidate-hardlink"), sourceRoot: source }),
    /exactly one hard link/,
  );
  await unlink(path.join(input, "index.js"));
  await writeFile(path.join(input, "index.js"), "too small", { flag: "wx" });
  await assert.rejects(
    buildNativeStaffCohortReviewBridge({ retainedDir: input, outputDir: path.join(scratch, "candidate-size"), sourceRoot: source }),
    /size mismatch for index\.js/,
  );
});

test("wrapper bundle leaves retained index.js external and includes only the new route closure", async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "ops-cohort-bridge-"));
  t.after(async () => rm(scratch, { recursive: true, force: true }));
  const outfile = path.join(scratch, "wrapper.js");
  const result = await buildNativeStaffCohortReviewBridgeBundle({ outfile });
  const output = await readFile(outfile, "utf8");
  const imports = result.metafile.outputs[ outfile.replaceAll("\\", "/") ]?.imports ??
    Object.values(result.metafile.outputs).find(value => value.entryPoint?.endsWith("native-staff-cohort-review-bridge-entry.mjs"))?.imports;
  assert.ok(imports, "esbuild output graph should include the entry output");
  assert.ok(imports.some(item => item.path === "./index.js" && item.external));
  assert.equal(new Set(imports.filter(item => item.path.endsWith("index.js")).map(item => item.path)).size, 1);
  assert.equal(imports.some(item => item.path.includes("index.js") && !item.external), false);
  assert.equal(result.checks.retainedEntryExternalAndSingle, true);
  assert.equal(result.checks.retainedRuntimeNotBundled, true);
  assert.match(output, /export\s*\*\s*from\s*["']\.\/index\.js["']/);
  assert.match(output, /from\s*["']\.\/index\.js["']/);
  assert.doesNotMatch(output, /\/api\/account\/login-links/);
  assert.doesNotMatch(output, /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+staff_login_/i);
  assert.equal(result.bundledInputs.some(({ name }) => name.replaceAll("\\", "/").endsWith("apps/operations/src/worker/index.ts")), false);
  assert.equal(result.bundledInputs.some(({ name }) => name.replaceAll("\\", "/").endsWith("apps/operations/src/worker/staff-login-link-routes.ts")), true);

  const fixtureExports = RETAINED_EXPORTS.filter(name => name !== "default").map(name => `export const ${name} = Symbol.for(${JSON.stringify(name)});`).join("\n");
  await writeFile(path.join(scratch, "package.json"), '{"type":"module"}\n', { flag: "wx" });
  await writeFile(path.join(scratch, "index.js"), `${fixtureExports}\nexport default {
    fetch(request, env, ctx) { globalThis.__retainedCalls.push(["fetch", request, env, ctx]); return globalThis.__retainedResult; },
    queue(...args) { globalThis.__retainedCalls.push(["queue", ...args]); return args[0]; },
    scheduled(...args) { globalThis.__retainedCalls.push(["scheduled", ...args]); return args[0]; },
  };\n`, { flag: "wx" });
  globalThis.__retainedCalls = [];
  globalThis.__retainedResult = Promise.resolve("retained-result");
  try {
    const module = await import(`${pathToFileURL(outfile).href}?fresh=${Date.now()}`);
    assert.deepEqual(Object.keys(module).sort(), [...RETAINED_EXPORTS].sort());
    const env = { marker: "env" };
    const ctx = { marker: "ctx" };
    const request = new Request("https://ops.example/not-the-cohort-route");
    assert.equal(module.default.fetch(request, env, ctx), globalThis.__retainedResult);
    assert.deepEqual(globalThis.__retainedCalls.pop(), ["fetch", request, env, ctx]);
    const exactRoute = new Request(`https://ops.example${NATIVE_STAFF_COHORT_REVIEW_PATH}`, { method: "POST" });
    const routeResponse = await module.default.fetch(exactRoute, env, ctx);
    assert.ok(routeResponse instanceof Response);
    assert.equal(routeResponse.status, 403);
    assert.deepEqual(globalThis.__retainedCalls, []);
    const batch = { batch: true };
    assert.equal(module.default.queue(batch, env), batch);
    assert.deepEqual(globalThis.__retainedCalls.pop(), ["queue", batch, env]);
    const controller = { scheduled: true };
    assert.equal(module.default.scheduled(controller, env, ctx), controller);
    assert.deepEqual(globalThis.__retainedCalls.pop(), ["scheduled", controller, env, ctx]);
  } finally {
    delete globalThis.__retainedCalls;
    delete globalThis.__retainedResult;
  }
});
