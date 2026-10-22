import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Node's test runner executes files in separate processes. The two real Edge
// suites are intentionally serialized so resource contention cannot stall CDP
// while all non-browser tests remain parallel.
export async function acquireBrowserHarnessLock({
  root,
  waitTimeoutMs = 120_000,
} = {}) {
  const scope = createHash('sha256').update(path.resolve(root || process.cwd())).digest('hex').slice(0, 16);
  // All test-file children in one `node --test` invocation share process.ppid.
  // Scoping by that parent keeps independent invocations from seeing a crashed
  // run's lock, so no unsafe stale-lock takeover is necessary.
  const lockPath = path.join(tmpdir(), `ltds-viewer-edge-${scope}-${process.ppid}.lock`);
  const owner = randomUUID();
  const deadline = Date.now() + waitTimeoutMs;

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ owner, pid: process.pid, createdAt: new Date().toISOString() }), { flag: 'wx' });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        throw error;
      }
      return () => {
        try {
          const current = JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
          if (current.owner === owner) rmSync(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    await wait(75 + Math.floor(Math.random() * 75));
  }
  throw new Error(`Timed out after ${waitTimeoutMs}ms waiting for the serialized Edge harness lock`);
}
