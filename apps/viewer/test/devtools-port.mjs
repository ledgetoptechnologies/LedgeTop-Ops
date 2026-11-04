import { readFileSync } from 'node:fs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Chromium creates DevToolsActivePort before completing its write. Never turn
// an empty/partial first line into the loopback HTTP default port or a wrong port.
export async function waitForDevToolsPort(file, {
  timeoutMs = 10_000,
  pollMs = 50,
  label = 'Isolated browser startup',
  check = () => {},
  read = () => readFileSync(file, 'utf8'),
  now = Date.now,
  sleep = delay,
  platform = process.platform,
} = {}) {
  // Windows can briefly lock the file while Chromium is still writing it (EBUSY/EPERM).
  // That is "not ready yet", like ENOENT; anything else, including EACCES, is a real failure.
  const notReady = new Set(platform === 'win32' ? ['ENOENT', 'EBUSY', 'EPERM'] : ['ENOENT']);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    check();
    let content = '';
    try { content = read(); }
    catch (error) { if (!notReady.has(error.code)) throw error; }
    const match = /^([1-9]\d{0,4})\r?\n\/devtools\/browser\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\r?\n?$/i.exec(content);
    if (match && Number(match[1]) <= 65535) return Number(match[1]);
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  throw new Error(`${label}: no complete valid DevToolsActivePort within ${timeoutMs} ms`);
}
