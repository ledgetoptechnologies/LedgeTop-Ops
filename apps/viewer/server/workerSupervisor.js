'use strict';

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

function heartbeatIsFresh(value, instanceId, nowMs = Date.now(), maxAgeMs = 60_000) {
  if (!value || typeof value !== 'object') return false;
  if (![ `worker-${instanceId}`, `worker-idle-${instanceId}` ].includes(value.owner)) return false;
  const at = Date.parse(value.at || '');
  return Number.isFinite(at) && at > nowMs - maxAgeMs && at <= nowMs + 5000;
}

function stopChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function main() {
  const { config } = require('./config');
  const { openDatabase } = require('./database');
  const { verifySqliteLocking } = require('./sqliteLockPreflight');
  const instanceId = crypto.randomUUID();
  const db = openDatabase(config.databasePath);
  verifySqliteLocking(config.databasePath);
  const workerPath = path.join(__dirname, 'worker.js');
  const restarts = [];
  let child = null;
  let startedAt = 0;
  let staleChecks = 0;
  let stopping = false;
  let restartTimer = null;

  const heartbeat = () => {
    const row = db.prepare("SELECT value FROM app_state WHERE key='processing_worker_heartbeat'").get();
    try { return JSON.parse(row?.value || 'null'); } catch { return null; }
  };

  const start = () => {
    if (stopping) return;
    const now = Date.now();
    while (restarts.length && restarts[0] < now - 10 * 60_000) restarts.shift();
    if (restarts.length >= 5) {
      console.error('Processing worker supervisor stopped after repeated child failures');
      db.close();
      process.exit(1);
    }
    restarts.push(now);
    staleChecks = 0;
    startedAt = now;
    child = spawn(process.execPath, [workerPath], {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: { ...process.env, WORKER_INSTANCE_ID: instanceId },
    });
    child.once('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      console.error(`Processing worker child exited: code=${code ?? 'none'} signal=${signal || 'none'}`);
      restartTimer = setTimeout(start, 2000);
    });
  };

  const monitor = setInterval(() => {
    if (!child || Date.now() - startedAt < 60_000) return;
    let fresh = false;
    try { fresh = heartbeatIsFresh(heartbeat(), instanceId); } catch {}
    staleChecks = fresh ? 0 : staleChecks + 1;
    if (staleChecks < 2) return;
    console.error('Processing worker heartbeat is stale; restarting fenced child');
    stopChild(child, 'SIGTERM');
    const target = child;
    const hardKill = setTimeout(() => stopChild(target, 'SIGKILL'), 10_000);
    hardKill.unref?.();
    staleChecks = 0;
  }, 10_000);

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(monitor);
    if (restartTimer) clearTimeout(restartTimer);
    const target = child;
    stopChild(target, signal);
    const deadline = setTimeout(() => {
      stopChild(target, 'SIGKILL');
      try { db.close(); } catch {}
      process.exit(0);
    }, 10_000);
    deadline.unref?.();
    if (!target) {
      try { db.close(); } catch {}
      process.exit(0);
    }
    target.once('exit', () => {
      clearTimeout(deadline);
      try { db.close(); } catch {}
      process.exit(0);
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  start();
}

if (require.main === module) main();

module.exports = { heartbeatIsFresh, main, stopChild };
