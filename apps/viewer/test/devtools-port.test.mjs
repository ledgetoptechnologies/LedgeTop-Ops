import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForDevToolsPort } from './devtools-port.mjs';

const endpoint = '/devtools/browser/11111111-2222-4333-8444-555555555555';

test('browser port startup waits through missing, empty, partial and invalid file contents', async () => {
  const samples = [null, '', '12', '12345\n', `12345\n${endpoint.slice(0, -1)}`, `\n${endpoint}`,
    `0\n${endpoint}`, `65536\n${endpoint}`, `abc\n${endpoint}`, `12345junk\n${endpoint}`,
    `12345\n${endpoint}\nextra`, `12345\r\n${endpoint}`];
  let clock = 0, reads = 0, sleeps = 0;
  const port = await waitForDevToolsPort('synthetic-only', {
    now: () => clock,
    read: () => {
      const value = samples[reads++];
      if (value === null) throw Object.assign(new Error('Not created yet'), { code: 'ENOENT' });
      return value;
    },
    sleep: async ms => { assert.equal(ms, 50); sleeps++; clock += ms; },
  });
  assert.equal(port, 12345);
  assert.equal(reads, samples.length);
  assert.equal(sleeps, samples.length - 1);
});

test('browser port startup accepts complete valid endpoints without retrying', async () => {
  let sleeps = 0;
  for (const port of [1, 65535]) for (const separator of ['\n', '\r\n']) {
    assert.equal(await waitForDevToolsPort('synthetic-only', {
      read: () => `${port}${separator}${endpoint.toUpperCase().replace('/DEVTOOLS/BROWSER/', '/devtools/browser/')}${separator}`,
      sleep: async () => { sleeps++; },
    }), port);
  }
  assert.equal(sleeps, 0);
});

for (const [timeoutMs, pollMs] of [[10_000, 50], [10_000, 30], [15_000, 50]]) {
  test(`browser port startup retains its ${timeoutMs} ms bound and ${pollMs} ms polling`, async () => {
    for (const content of ['', '12345', `70000\n${endpoint}`]) {
      let clock = 0, reads = 0;
      await assert.rejects(waitForDevToolsPort('synthetic-only', {
        timeoutMs, pollMs, label: 'Browser did not expose a DevTools endpoint',
        now: () => clock,
        read: () => { reads++; return content; },
        sleep: async ms => { assert.ok(ms > 0 && ms <= pollMs); clock += ms; },
      }), new RegExp(`Browser did not expose a DevTools endpoint: no complete valid DevToolsActivePort within ${timeoutMs} ms`));
      assert.equal(clock, timeoutMs);
      assert.equal(reads, Math.ceil(timeoutMs / pollMs));
    }
  });
}

test('browser port startup propagates actual file read failures immediately', async () => {
  const failure = Object.assign(new Error('Synthetic read permission failure'), { code: 'EACCES' });
  let reads = 0, sleeps = 0;
  await assert.rejects(waitForDevToolsPort('synthetic-only', {
    read: () => { reads++; throw failure; },
    sleep: async () => { sleeps++; },
  }), error => error === failure);
  assert.equal(reads, 1);
  assert.equal(sleeps, 0);
});

test('browser port startup preserves caller launch and process-exit checks', async () => {
  const failure = new Error('Browser exited (1) before CDP startup: synthetic launch failure');
  let reads = 0, sleeps = 0;
  await assert.rejects(waitForDevToolsPort('synthetic-only', {
    check: () => { throw failure; },
    read: () => { reads++; return `12345\n${endpoint}`; },
    sleep: async () => { sleeps++; },
  }), error => error === failure);
  assert.equal(reads, 0);
  assert.equal(sleeps, 0);
});

test('a Windows lock while Chromium writes the port file is waited out within the same deadline', async () => {
  for (const code of ['EBUSY', 'EPERM']) {
    let clock = 0, reads = 0, checks = 0;
    const port = await waitForDevToolsPort('synthetic-only', {
      platform: 'win32',
      now: () => clock,
      check: () => { checks++; },
      read: () => { if (reads++ < 2) throw Object.assign(new Error('locked'), { code }); return `4321\n${endpoint}\n`; },
      sleep: async ms => { clock += ms; },
    });
    assert.equal(port, 4321, code);
    assert.equal(reads, 3);
    assert.equal(checks, 3, 'the browser-exit check still runs on every attempt');
  }
  let clock = 0;
  await assert.rejects(waitForDevToolsPort('synthetic-only', {
    platform: 'win32', timeoutMs: 200, now: () => clock,
    read: () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); },
    sleep: async ms => { clock += ms; },
  }), /no complete valid DevToolsActivePort within 200 ms/, 'a lock that never clears still ends at the original deadline');
});

test('other read failures stay immediate, and EBUSY is only tolerated on Windows', async () => {
  const fails = (platform, code) => waitForDevToolsPort('synthetic-only', {
    platform,
    read: () => { throw Object.assign(new Error(code), { code }); },
    sleep: async () => { throw new Error('must not retry'); },
  });
  await assert.rejects(fails('win32', 'EACCES'), { code: 'EACCES' });
  await assert.rejects(fails('linux', 'EBUSY'), { code: 'EBUSY' });
  await assert.rejects(fails('linux', 'EPERM'), { code: 'EPERM' });
});
