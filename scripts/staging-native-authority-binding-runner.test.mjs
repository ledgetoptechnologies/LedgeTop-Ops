import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import {
  applyReviewedNativeOnlyAuthorityPacket,
  main,
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
