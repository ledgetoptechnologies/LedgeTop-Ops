import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import {
  applyReviewedNativeOnlyAuthorityPacket,
  main,
  readStagingBindingConfig,
  readOnlyStagingAuthorityStatus,
  validateStagingBindingConfig,
  withStagingAuthorityBinding,
} from "./staging-native-authority-binding-runner.mjs";

const reviewedConfig = () => ({
  name: STAGING_TARGET.workerName,
  account_id: STAGING_TARGET.accountId,
  compatibility_date: "2026-10-02",
  d1_databases: [{
    binding: STAGING_TARGET.binding,
    database_name: STAGING_TARGET.databaseName,
    database_id: STAGING_TARGET.databaseId,
    remote: true,
  }],
});

function configFile(t, value = reviewedConfig()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "staging-binding-runner-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "wrangler.staging.native-authority-binding.json");
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filename;
}

function fakeDb({ row = { migration_count: 180, final_migration: "0180_project_alpha_project_v2_recovery_authorization.sql" } } = {}) {
  const state = { prepared: [], batches: 0 };
  return {
    state,
    prepare(sql) {
      state.prepared.push(sql);
      return { first: async () => row };
    },
    async batch() {
      state.batches += 1;
      return [];
    },
  };
}

function proxyFactory(db, state, mutate) {
  return async options => {
    state.starts += 1;
    state.options.push(options);
    if (mutate) mutate();
    return {
      env: { OPS_DB: db },
      async dispose() { state.disposals += 1; },
    };
  };
}

test("derives the trusted target from the exact closed staging binding config", () => {
  assert.deepEqual(validateStagingBindingConfig(reviewedConfig()), STAGING_TARGET);
});

test("rejects altered, production, and unexpected resources before proxy startup", async t => {
  const variants = {
    "production worker": config => { config.name = "ledgetop-ops"; },
    "production database": config => {
      config.d1_databases[0].database_name = "ltds-ops";
      config.d1_databases[0].database_id = "6ebf7514-d306-4615-ae56-ad869c874dbd";
    },
    "wrong account": config => { config.account_id = "0".repeat(32); },
    "local binding": config => { config.d1_databases[0].remote = false; },
    "unexpected binding": config => {
      config.d1_databases.push({
        binding: "DELIVERY_DB",
        database_name: "client-data-staging",
        database_id: "b6f653ab-9acd-4421-9ad0-207754b59aeb",
        remote: true,
      });
    },
    "extra config surface": config => { config.vars = { SECRET: "must-not-load" }; },
    "extra binding surface": config => { config.d1_databases[0].migrations_dir = "migrations"; },
    "unreviewed compatibility date": config => { config.compatibility_date = "2026-10-01"; },
  };
  for (const [name, alter] of Object.entries(variants)) {
    await t.test(name, async t => {
      const config = reviewedConfig();
      alter(config);
      const filename = configFile(t, config);
      let starts = 0;
      await assert.rejects(readOnlyStagingAuthorityStatus(filename, {
        getPlatformProxy: async () => { starts += 1; throw new Error("must not start"); },
      }), /staging-native-authority-binding-runner/);
      assert.equal(starts, 0);
    });
  }
});

test("status uses exact proxy options, one read-only aggregate, sanitized output, and disposal", async t => {
  const filename = configFile(t);
  const db = fakeDb();
  const state = { starts: 0, options: [], disposals: 0 };
  const logs = [];
  const dependencies = { getPlatformProxy: proxyFactory(db, state), log: value => logs.push(value) };
  assert.equal(await main(["status", "--config", filename], dependencies), 0);
  assert.equal(state.starts, 1);
  assert.equal(state.disposals, 1);
  assert.deepEqual(state.options, [{
    configPath: path.resolve(filename),
    envFiles: [],
    persist: false,
    remoteBindings: true,
  }]);
  assert.equal(db.state.prepared.length, 1);
  assert.match(db.state.prepared[0], /^SELECT\s/i);
  assert.doesNotMatch(db.state.prepared[0], /\b(?:INSERT|UPDATE|DELETE|REPLACE|GRANT)\b/i);
  assert.equal(db.state.batches, 0);
  const output = JSON.parse(logs[0]);
  assert.deepEqual(output, {
    mode: "read-only-status",
    environment: "staging",
    workerName: STAGING_TARGET.workerName,
    binding: STAGING_TARGET.binding,
    databaseName: STAGING_TARGET.databaseName,
    migrations: { count: 180, final: "0180_project_alpha_project_v2_recovery_authorization.sql" },
    mutationsPerformed: false,
  });
  assert.doesNotMatch(logs[0], /staff|grant|admission|access_subject/i);
});

test("direct D1 API status transport uses only the reviewed staging database and hides token values", async t => {
  const filename = configFile(t);
  const token = "synthetic-test-token-never-real";
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({
      success: true,
      result: [{
        success: true,
        results: [{ migration_count: 182, final_migration: "0182_project_alpha_project_v2_recovery_authorization.sql" }],
        meta: { changed_db: false, rows_written: 0 },
      }],
    });
  };
  const logs = [];
  assert.equal(await main(["status", "--config", filename], {
    token,
    fetchImpl,
    getPlatformProxy: async () => assert.fail("REST transport must not start Miniflare"),
    log: value => logs.push(value),
  }), 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://api.cloudflare.com/client/v4/accounts/${STAGING_TARGET.accountId}/d1/database/${STAGING_TARGET.databaseId}/query`);
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(requests[0].body, { sql: "SELECT count(*) AS migration_count, max(name) AS final_migration\n  FROM d1_migrations", params: [] });
  assert.match(logs[0], /"migrations":\{"count":182/);
  assert.equal(logs[0].includes(token), false);
});

test("an injected proxy wins over an ambient API token unless a token dependency is explicit", async t => {
  const filename = configFile(t);
  const ambientToken = "synthetic-ambient-token-never-real";
  const explicitToken = "synthetic-explicit-token-never-real";
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = ambientToken;
  try {
    const db = fakeDb();
    const state = { starts: 0, options: [], disposals: 0 };
    await readOnlyStagingAuthorityStatus(filename, {
      getPlatformProxy: proxyFactory(db, state),
      fetchImpl: async () => assert.fail("ambient token must not bypass the injected proxy"),
    });
    assert.equal(state.starts, 1);
    assert.equal(state.disposals, 1);

    let fetches = 0;
    await readOnlyStagingAuthorityStatus(filename, {
      token: explicitToken,
      getPlatformProxy: async () => assert.fail("explicit token must select the REST transport"),
      fetchImpl: async (_url, init) => {
        fetches += 1;
        assert.equal(init.headers.Authorization, `Bearer ${explicitToken}`);
        return Response.json({
          success: true,
          result: [{
            success: true,
            results: [{ migration_count: 182, final_migration: "0182_project_alpha_directory_relationship_recovery_guard.sql" }],
          }],
        });
      },
    });
    assert.equal(fetches, 1);
  } finally {
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousToken;
  }
});

test("direct D1 API rejects config drift before fetch", async t => {
  const filename = configFile(t);
  const token = "synthetic-test-token-never-real";
  let reads = 0;
  let fetches = 0;
  const readConfig = (configPath, dependencies) => {
    const result = readStagingBindingConfig(configPath, dependencies);
    reads += 1;
    if (reads === 1) fs.writeFileSync(filename, JSON.stringify(reviewedConfig()), "utf8");
    return result;
  };
  await assert.rejects(readOnlyStagingAuthorityStatus(filename, {
    token,
    readConfig,
    fetchImpl: async () => {
      fetches += 1;
      return Response.json({ success: true, result: [] });
    },
  }), /config changed while opening binding/);
  assert.equal(reads, 2);
  assert.equal(fetches, 0);
});

test("direct D1 API batch transport sends the complete parameterized batch in one atomic request", async t => {
  const filename = configFile(t);
  const token = "synthetic-test-token-never-real";
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({ success: true, result: [{ success: true }, { success: true }] });
  };
  const packet = { schemaVersion: 2, statements: [
    { sql: "INSERT INTO synthetic_table(id) VALUES(?)", params: ["fixture-id"] },
    { sql: "INSERT INTO synthetic_audit(id) VALUES(?)", params: ["fixture-audit"] },
  ] };
  const result = await applyReviewedNativeOnlyAuthorityPacket(filename, packet, {
    token,
    fetchImpl,
    applyPacket: (db, actualPacket) => db.batch(actualPacket.statements.map(item => db.prepare(item.sql).bind(...item.params))),
  });
  assert.equal(requests.length, 1, "all mutations are submitted as one request");
  assert.deepEqual(requests[0].body, { batch: packet.statements });
  assert.deepEqual(result, [{ success: true }, { success: true }]);
  assert.equal(JSON.stringify(requests[0].init.headers).includes(token), true, "token is sent only in the authorization header");
});

test("direct D1 API errors are sanitized and never echo provider messages or credentials", async t => {
  const filename = configFile(t);
  const token = "synthetic-test-token-never-real";
  await assert.rejects(main(["status", "--config", filename], {
    token,
    fetchImpl: async () => Response.json({
      success: false,
      errors: [{ code: 7403, message: `upstream echoed ${token}` }],
    }, { status: 403 }),
    getPlatformProxy: async () => assert.fail("REST transport must not start Miniflare"),
  }), error => {
    assert.match(error.message, /HTTP 403/);
    assert.match(error.message, /7403/);
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes("upstream echoed"), false);
    return true;
  });
});

test("direct D1 API transport and JSON failures are sanitized", async t => {
  const token = "synthetic-test-token-never-real";
  await t.test("network failure", async t => {
    const filename = configFile(t);
    await assert.rejects(readOnlyStagingAuthorityStatus(filename, {
      token,
      fetchImpl: async () => { throw new Error(`network echoed ${token}`); },
    }), error => {
      assert.match(error.message, /request failed before a response/);
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes("network echoed"), false);
      return true;
    });
  });
  await t.test("invalid JSON response", async t => {
    const filename = configFile(t);
    await assert.rejects(readOnlyStagingAuthorityStatus(filename, {
      token,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() { throw new Error(`JSON echoed ${token}`); },
      }),
    }), error => {
      assert.match(error.message, /returned an invalid response/);
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes("JSON echoed"), false);
      return true;
    });
  });
});

test("direct D1 API rejects malformed batch inputs before fetch", async t => {
  const token = "synthetic-test-token-never-real";
  const valid = { sql: "SELECT ? AS value", params: [1] };
  const invalidBatches = [
    ["empty batch", []],
    ["batch over the limit", Array.from({ length: 1_001 }, () => valid)],
    ["empty SQL", [{ sql: "", params: [] }]],
    ["non-array parameters", [{ sql: "SELECT 1", params: "not-an-array" }]],
  ];
  for (const [name, statements] of invalidBatches) {
    await t.test(name, async t => {
      const filename = configFile(t);
      let fetches = 0;
      await assert.rejects(withStagingAuthorityBinding(filename, ({ db }) => db.batch(statements), {
        token,
        fetchImpl: async () => {
          fetches += 1;
          return Response.json({ success: true, result: [] });
        },
      }), /invalid D1 batch/);
      assert.equal(fetches, 0);
    });
  }
});

test("direct D1 API rejects incomplete and failed batch results", async t => {
  const token = "synthetic-test-token-never-real";
  const cases = [
    [{ success: true }],
    [{ success: true }, { success: false }],
  ];
  for (const result of cases) {
    const filename = configFile(t);
    let fetches = 0;
    await assert.rejects(withStagingAuthorityBinding(filename, ({ db }) => db.batch([
      db.prepare("SELECT ? AS value").bind(1),
      db.prepare("SELECT ? AS value").bind(null),
    ]), {
      token,
      fetchImpl: async () => {
        fetches += 1;
        return Response.json({ success: true, result });
      },
    }), /invalid batch result/);
    assert.equal(fetches, 1);
  }
});

test("post-start config drift is rejected before the first database call and disposes", async t => {
  const filename = configFile(t);
  const db = fakeDb();
  const state = { starts: 0, options: [], disposals: 0 };
  const getPlatformProxy = proxyFactory(db, state, () => {
    const changed = reviewedConfig();
    changed.name = "ledgetop-ops";
    fs.writeFileSync(filename, `${JSON.stringify(changed)}\n`, "utf8");
  });
  await assert.rejects(readOnlyStagingAuthorityStatus(filename, { getPlatformProxy }), /exact staging worker config/);
  assert.equal(state.starts, 1);
  assert.equal(state.disposals, 1);
  assert.equal(db.state.prepared.length, 0);
  assert.equal(db.state.batches, 0);
});

test("byte-level config drift is rejected even when the resource identity is unchanged", async t => {
  const filename = configFile(t);
  const db = fakeDb();
  const state = { starts: 0, options: [], disposals: 0 };
  const getPlatformProxy = proxyFactory(db, state, () => {
    fs.writeFileSync(filename, JSON.stringify(reviewedConfig()), "utf8");
  });
  await assert.rejects(readOnlyStagingAuthorityStatus(filename, { getPlatformProxy }), /config changed while opening binding/);
  assert.equal(state.disposals, 1);
  assert.equal(db.state.prepared.length, 0);
});

test("unexpected proxy bindings are rejected and disposed", async t => {
  const filename = configFile(t);
  const db = fakeDb();
  let disposals = 0;
  await assert.rejects(withStagingAuthorityBinding(filename, () => assert.fail("callback must not run"), {
    getPlatformProxy: async () => ({
      env: { OPS_DB: db, SECRET: "unexpected" },
      async dispose() { disposals += 1; },
    }),
  }), /unexpected binding set/);
  assert.equal(disposals, 1);
});

test("query and apply failures still dispose the platform proxy", async t => {
  await t.test("query failure", async t => {
    const filename = configFile(t);
    const db = fakeDb();
    db.prepare = () => ({ first: async () => { throw new Error("query failed"); } });
    const state = { starts: 0, options: [], disposals: 0 };
    await assert.rejects(readOnlyStagingAuthorityStatus(filename, {
      getPlatformProxy: proxyFactory(db, state),
    }), /query failed/);
    assert.equal(state.disposals, 1);
  });
  await t.test("apply failure", async t => {
    const filename = configFile(t);
    const db = fakeDb();
    const state = { starts: 0, options: [], disposals: 0 };
    const packet = { schemaVersion: 2, statements: [] };
    await assert.rejects(applyReviewedNativeOnlyAuthorityPacket(filename, packet, {
      getPlatformProxy: proxyFactory(db, state),
      applyPacket: async () => { throw new Error("apply failed"); },
    }), /apply failed/);
    assert.equal(state.disposals, 1);
  });
});

test("module-only apply accepts exactly compiled packet versions 2 and 3 and delegates atomically once", async t => {
  for (const schemaVersion of [2, 3]) {
    await t.test(`schema version ${schemaVersion}`, async t => {
      const filename = configFile(t);
      const db = fakeDb();
      const state = { starts: 0, options: [], disposals: 0 };
      const packet = { schemaVersion, statements: [{ sql: "guard" }, { sql: "write" }] };
      const calls = [];
      const result = await applyReviewedNativeOnlyAuthorityPacket(filename, packet, {
        getPlatformProxy: proxyFactory(db, state),
        applyPacket: async (actualDb, actualPacket, options) => {
          calls.push({ actualDb, actualPacket, options });
          await actualDb.batch(actualPacket.statements);
          return { replayed: false };
        },
      });
      assert.deepEqual(result, { replayed: false });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].actualDb, db);
      assert.equal(calls[0].actualPacket, packet);
      assert.deepEqual(calls[0].options, { target: STAGING_TARGET });
      assert.equal(db.state.batches, 1);
      assert.equal(db.state.prepared.length, 0, "runner does not sequence individual write statements");
      assert.equal(state.disposals, 1);
    });
  }
});

test("raw version 2 and 3 values are refused before proxy startup", async t => {
  const filename = configFile(t);
  for (const schemaVersion of [2, 3]) {
    let starts = 0;
    await assert.rejects(applyReviewedNativeOnlyAuthorityPacket(filename, {
      schemaVersion,
      staging: STAGING_TARGET,
    }, {
      getPlatformProxy: async () => { starts += 1; },
    }), /reviewed compiled packet required/);
    assert.equal(starts, 0);
  }
});

test("unreviewed compiled packet versions are refused before proxy startup", async t => {
  const filename = configFile(t);
  for (const schemaVersion of [1, 4]) {
    let starts = 0;
    await assert.rejects(applyReviewedNativeOnlyAuthorityPacket(filename, {
      schemaVersion,
      statements: [],
    }, {
      getPlatformProxy: async () => { starts += 1; },
    }), /reviewed compiled packet required/);
    assert.equal(starts, 0);
  }
});
