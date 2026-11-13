'use strict';
// Pure mocked lifecycle/metadata tests: no process, GDAL, WASM, model or real IO.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { createRecoveryProofExecutor, SOURCE_COMMIT } = require('../server/recoveryProofExecutor');

const binding = () => ({ schemaVersion: 1, sourceCommit: SOURCE_COMMIT, imageId: 'sha256:' + 'a'.repeat(64),
  nodeVersion: 'v24.22.2', nodeAbi: '137', pythonVersion: '3.12.3', gdalVersion: '3.8.4',
  converterBinarySha256: '3f62b4d9c954ceffc955c7e1f08bc2412827405d02644df0ab2ea2457b009459',
  basisJavascriptSha256: '8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1',
  basisWasmSha256: '6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a' });
const request = () => ({ schemaVersion: 1, mode: 'verify', output: '/output/candidate', sourceObj: '/input/model.obj',
  sourceGlb: '/input/model.glb', converterBinary: '/runtime/Obj2Tiles', basisJavascript: '/runtime/basis.js',
  basisWasm: '/runtime/basis.wasm', sourceObjSha256: 'b'.repeat(64), sourceGlbSha256: 'c'.repeat(64),
  converterBinarySha256: binding().converterBinarySha256, converterSerialRetry: false });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let at = 0; at < 25; at++) await Promise.resolve(); };

function fixture(changes = {}) {
  const state = { clock: 1000, ticks: 0, probes: 0, signals: [], cleanups: 0, spawnCalls: [], closedHandles: 0,
    events: [], alive: false, childClosed: false, guardCalls: 0, stallCalls: 0 };
  const files = new Map();
  const info = (directory, ino, mode, size = 0, owner = 1000) => ({ dev: 1, ino, uid: owner, mode, size,
    isDirectory: () => directory, isFile: () => !directory });
  files.set('/work', info(true, 10, 0o40700));
  files.set('/usr/bin/node', info(false, 11, 0o100555));
  files.set('/app/verify_recovery_candidate.mjs', info(false, 12, 0o100444));
  const io = {
    async realpath(name) { assert.ok(files.has(name), 'mock path exists'); return name; },
    async lstat(name) { assert.ok(files.has(name), 'mock metadata exists'); return { ...files.get(name) }; },
    async mkdtemp(prefix) {
      const name = prefix + 'Abc123'; files.set(name, info(true, 20, 0o40700));
      changes.afterMkdtemp?.(state); return name;
    },
    async open(name, flags, mode) {
      assert.ok(flags & require('node:fs').constants.O_EXCL); assert.equal(mode, 0o600);
      assert.equal(files.has(name), false); files.set(name, info(false, 30, 0o100600));
      const handle = {
        async writeFile(bytes) { state.written = Buffer.from(bytes); files.get(name).size = bytes.length; },
        async sync() {},
        async close() { state.closedHandles++; state.events.push('handle-close'); },
      };
      changes.afterOpen?.(state); return handle;
    },
    async rm(name, options) {
      assert.deepEqual(options, { recursive: true, force: false });
      assert.equal(state.alive, false, 'group must be absent before scratch deletion');
      assert.ok(!state.child || state.childClosed, 'direct child must close before deletion');
      state.cleanups++; state.events.push('cleanup');
      for (const key of files.keys()) if (key === name || key.startsWith(name + '/')) files.delete(key);
    },
  };
  function finish(code = 0, signal = null, text = '{"scope":"mock-only-no-proof"}\n') {
    if (text !== null) state.child.stdout.emit('data', Buffer.from(text));
    state.alive = false; state.childClosed = true; state.events.push('child-close'); state.child.emit('close', code, signal);
  }
  const processGroup = {
    exists(pgid) { assert.equal(pgid, 4321); state.probes++; return changes.exists ? changes.exists(state) : state.alive; },
    signal(pgid, name) {
      assert.equal(pgid, 4321); state.signals.push(name); state.events.push(name);
      if (changes.signal) changes.signal(state, name);
      else if (name === 'SIGKILL') finish(null, name, null);
    },
  };
  const options = { nodePath: '/usr/bin/node', scriptPath: '/app/verify_recovery_candidate.mjs', workRoot: '/work',
    runtimeBinding: binding(), assertRuntimeQualified: async () => true, assertResourceAdmission: async () => true,
    onCleanupStall: () => { state.stallCalls++; }, fsPromises: io, processGroup, platform: 'linux', getuid: () => 1000,
    now: () => state.clock, pollMs: 1, termGraceMs: 2, killGraceMs: 2,
    spawnFn(node, args, spawnOptions) {
      const child = new EventEmitter(); child.pid = 4321; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      state.child = child; state.alive = true; state.childClosed = false;
      state.spawnCalls.push({ node, args, options: spawnOptions });
      queueMicrotask(() => { if (changes.autoSpawn !== false) { child.emit('spawn'); state.didSpawn = true; } changes.onSpawn?.(state); });
      return child;
    },
    wait: async milliseconds => {
      state.clock += milliseconds; await Promise.resolve(); state.ticks++;
      if (changes.onTick) changes.onTick(state, finish);
      else if (state.ticks === 1) finish();
    },
  };
  Object.assign(options, changes.options);
  assert.equal(options.processGroup, processGroup, 'every fixture must use its mocked group, never host PID probes');
  const execute = createRecoveryProofExecutor(options);
  const input = { request: request(), deadline: 10000, assertCurrent() { state.guardCalls++; changes.guard?.(state); } };
  return { execute, input, state, options, files, finish };
}

test('fixed verify CLI, minimal environment, private request hash and fixed runtime snapshot', async () => {
  const f = fixture(); f.options.runtimeBinding.imageId = 'sha256:' + 'f'.repeat(64);
  const result = await f.execute(f.input), call = f.state.spawnCalls[0];
  assert.equal(call.node, '/usr/bin/node');
  assert.deepEqual(call.args, ['/app/verify_recovery_candidate.mjs', '--request', '/work/recovery-proof-Abc123/request.json']);
  assert.equal(call.options.detached, true); assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(call.options.cwd, '/work/recovery-proof-Abc123');
  assert.equal(Object.hasOwn(call.options.env, 'NODE_OPTIONS'), false);
  assert.equal(Object.hasOwn(call.options.env, 'HOME'), false);
  assert.equal(call.options.env.PATH, '/usr/bin:/bin');
  assert.equal(result.execution.requestSha256, crypto.createHash('sha256').update(JSON.stringify(f.input.request)).digest('hex'));
  assert.equal(f.state.written.toString(), JSON.stringify(f.input.request));
  assert.equal(result.execution.runtimeBinding.imageId, 'sha256:' + 'a'.repeat(64));
  assert.ok(Object.isFrozen(result.execution.runtimeBinding));
  assert.deepEqual(result.proof, { scope: 'mock-only-no-proof' });
  assert.equal(result.execution.sourceCommit, SOURCE_COMMIT);
  assert.equal(result.execution.childClosed, true); assert.equal(result.execution.processGroupGone, true);
  assert.equal(f.state.closedHandles, 1); assert.equal(f.state.cleanups, 1);
  assert.ok(f.state.events.indexOf('child-close') < f.state.events.indexOf('cleanup'));
});

test('mandatory hooks, exact runtime pins, verify-only and no request command/environment overrides', async () => {
  const f = fixture();
  assert.throws(() => createRecoveryProofExecutor({ ...f.options, onCleanupStall: null }), { code: 'recovery_executor_configuration' });
  assert.throws(() => createRecoveryProofExecutor({ ...f.options, runtimeBinding: { ...binding(), sourceCommit: '0'.repeat(40) } }), { code: 'recovery_executor_configuration' });
  for (const bad of [{ ...request(), mode: 'prepare' }, { ...request(), env: {} }, { ...request(), command: '/bin/sh' }]) {
    await assert.rejects(f.execute({ ...f.input, request: bad }), { code: 'recovery_executor_request' });
  }
  assert.equal(f.state.spawnCalls.length, 0);
});

test('partial mocked adapters cannot fall through to native host process-group operations', () => {
  const f = fixture();
  for (const key of ['processGroup', 'fsPromises', 'now', 'wait', 'getuid', 'spawnFn', 'platform']) {
    const partial = { ...f.options }; delete partial[key];
    assert.throws(() => createRecoveryProofExecutor(partial), { code: 'recovery_executor_test_adapter_incomplete' });
  }
  assert.equal(f.state.spawnCalls.length, 0);
});

test('qualification/admission require literal true before request scratch or child creation', async () => {
  for (const [hook, code] of [['assertRuntimeQualified', 'recovery_executor_runtime_unqualified'], ['assertResourceAdmission', 'recovery_executor_admission_denied']]) {
    const f = fixture({ options: { [hook]: async () => ({ accepted: true }) } });
    await assert.rejects(f.execute(f.input), { code });
    assert.equal(f.state.spawnCalls.length, 0); assert.equal(f.state.written, undefined);
  }
});

test('busy guard and fresh synchronous lease guard after an awaited qualification hook', async () => {
  const gate = deferred(); let stale = false;
  const f = fixture({ options: { assertRuntimeQualified: () => gate.promise }, guard() { if (stale) throw Error('stale'); } });
  const task = f.execute(f.input);
  await assert.rejects(f.execute(f.input), { code: 'recovery_executor_busy' });
  stale = true; gate.resolve(true);
  await assert.rejects(task, { code: 'recovery_executor_stale' });
  assert.equal(f.state.spawnCalls.length, 0);
  await assert.rejects(f.execute({ ...f.input, assertCurrent: () => Promise.reject(Error('async guard')) }),
    { code: 'recovery_executor_async_current_guard' });
  await assert.rejects(f.execute({ ...f.input, assertCurrent: () => false }),
    { code: 'recovery_executor_stale' });
});

test('cancellation after scratch acquisition retains its identity for cleanup', async () => {
  const abort = new AbortController(); const f = fixture({ afterMkdtemp() { abort.abort(); } });
  await assert.rejects(f.execute({ ...f.input, signal: abort.signal }), { code: 'recovery_executor_cancelled' });
  assert.equal(f.state.spawnCalls.length, 0); assert.equal(f.state.cleanups, 1);
});

test('cancellation after request descriptor acquisition closes it before private cleanup', async () => {
  const abort = new AbortController(); const f = fixture({ afterOpen() { abort.abort(); } });
  await assert.rejects(f.execute({ ...f.input, signal: abort.signal }), { code: 'recovery_executor_cancelled' });
  assert.equal(f.state.spawnCalls.length, 0); assert.equal(f.state.closedHandles, 1); assert.equal(f.state.cleanups, 1);
  assert.ok(f.state.events.indexOf('handle-close') < f.state.events.indexOf('cleanup'));
});

test('actual child exit zero and exact single canonical JSON are required', async () => {
  for (const [code, payload, expected] of [[2, '{"scope":"mock"}', 'recovery_executor_exit_failed'],
    [0, '{"x":1,"x":2}', 'recovery_executor_invalid_json'],
    [0, '{"x":1}\nextra', 'recovery_executor_invalid_json'], [0, '[]', 'recovery_executor_invalid_json']]) {
    const f = fixture({ onTick(state, finish) { if (state.ticks === 1) finish(code, null, payload); } });
    await assert.rejects(f.execute(f.input), { code: expected }); assert.equal(f.state.cleanups, 1);
  }
});

test('stdout/stderr budgets cause group termination and reap before rejection', async () => {
  for (const [stream, count, code] of [['stdout', 8 * 1024 * 1024 + 1, 'recovery_executor_stdout_limit'],
    ['stderr', 4097, 'recovery_executor_stderr_limit']]) {
    const f = fixture({ onTick(state) { if (state.ticks === 1) state.child[stream].emit('data', Buffer.alloc(count)); } });
    await assert.rejects(f.execute(f.input), { code });
    assert.deepEqual(f.state.signals, ['SIGTERM', 'SIGKILL']); assert.equal(f.state.cleanups, 1);
  }
});

test('operation deadline bounds the child and timeout still awaits real group cleanup', async () => {
  const f = fixture({ onTick() {} });
  await assert.rejects(f.execute({ ...f.input, deadline: 1003 }), { code: 'recovery_executor_timeout' });
  assert.deepEqual(f.state.signals, ['SIGTERM', 'SIGKILL']); assert.equal(f.state.cleanups, 1);
  const gate = deferred(), limited = fixture({ options: { assertRuntimeQualified: () => gate.promise } });
  const task = limited.execute({ ...limited.input, deadline: Number.MAX_SAFE_INTEGER });
  limited.state.clock += 30 * 60_000; gate.resolve(true);
  await assert.rejects(task, { code: 'recovery_executor_timeout' }); assert.equal(limited.state.spawnCalls.length, 0);
});

test('owned descendant group is killed after leader close and never cleaned while alive', async () => {
  const f = fixture({ onTick(state) {
    if (state.ticks === 1) { state.child.stdout.emit('data', Buffer.from('{"scope":"mock"}')); state.childClosed = true; state.child.emit('close', 0, null); }
  }, signal(state, signal) { if (signal === 'SIGKILL') state.alive = false; } });
  await assert.rejects(f.execute(f.input), { code: 'recovery_executor_descendants_remaining' });
  assert.deepEqual(f.state.signals, ['SIGTERM', 'SIGKILL']); assert.equal(f.state.cleanups, 1);
});

test('uncertain reap stalls exactly once and retains promise, busy slot and scratch until group gone', async () => {
  const waits = [], abort = new AbortController();
  const f = fixture({ options: { wait: milliseconds => { f.state.clock += milliseconds; const gate = deferred(); waits.push(gate); return gate.promise; },
    onCleanupStall: async () => { f.state.stallCalls++; throw Error('status hook unavailable'); } },
  onSpawn() { abort.abort(); }, signal() {} });
  let settled = false;
  const task = f.execute({ ...f.input, signal: abort.signal }).finally(() => { settled = true; });
  const rejection = assert.rejects(task, { code: 'recovery_executor_cancelled' });
  for (let at = 0; at < 10; at++) { await flush(); waits.shift()?.resolve(); }
  await flush();
  assert.equal(f.state.stallCalls, 1); assert.equal(settled, false); assert.equal(f.state.cleanups, 0);
  assert.deepEqual(f.state.signals, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(f.execute(f.input), { code: 'recovery_executor_busy' });
  f.finish(null, 'SIGKILL', null); waits.shift()?.resolve(); await rejection;
  assert.equal(f.state.cleanups, 1); assert.equal(f.state.stallCalls, 1);
});

test('ESRCH retires the owned PGID once, avoiding later probe or signal against reused ID', async () => {
  const abort = new AbortController();
  const f = fixture({ exists(state) { return state.probes === 1 ? false : true; },
    onTick(state, finish) { if (state.ticks === 2) abort.abort(); if (state.ticks === 3) finish(); } });
  await assert.rejects(f.execute({ ...f.input, signal: abort.signal }), { code: 'recovery_executor_cancelled' });
  assert.equal(f.state.probes, 1); assert.deepEqual(f.state.signals, []); assert.equal(f.state.cleanups, 1);
});

test('early PID publication is not group retirement before the spawn event', async () => {
  const f = fixture({ autoSpawn: false, exists(state) { assert.equal(state.didSpawn, true); return state.alive; },
    onTick(state, finish) { if (state.ticks === 2) { state.child.emit('spawn'); state.didSpawn = true; } if (state.ticks === 3) finish(); } });
  await f.execute(f.input); assert.equal(f.state.probes, 2); assert.equal(f.state.cleanups, 1);
});

test('spawn failure without a PID still waits direct close and never probes another group', async () => {
  const f = fixture({ autoSpawn: false, onSpawn(state) {
    state.child.pid = undefined; state.child.emit('error', Error('synthetic spawn failure'));
  }, onTick(_state, finish) { finish(-2, null, null); } });
  await assert.rejects(f.execute(f.input), { code: 'recovery_executor_spawn_failed' });
  assert.equal(f.state.probes, 0); assert.equal(f.state.cleanups, 1);
});

test('private cleanup refuses changed root identity rather than deleting uncertain ownership', async () => {
  const f = fixture({ onTick(state, finish) { if (state.ticks === 1) { finish(); f.files.get('/work').ino++; } } });
  await assert.rejects(f.execute(f.input), { code: 'recovery_executor_cleanup_identity' });
  assert.equal(f.state.cleanups, 0); assert.equal(f.state.childClosed, true); assert.equal(f.state.alive, false);
});

test('work root may not overlap proof output or source roots', async () => {
  const f = fixture();
  await assert.rejects(f.execute({ ...f.input, request: { ...request(), output: '/work/output' } }),
    { code: 'recovery_executor_work_root_overlap' });
  assert.equal(f.state.spawnCalls.length, 0);
});
