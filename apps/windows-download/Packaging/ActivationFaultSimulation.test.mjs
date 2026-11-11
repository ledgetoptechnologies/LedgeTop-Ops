import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

// Simulates only the extracted activation control flow with mocked writes and
// reads. This does not execute NSIS or touch the registry, filesystem, or roots.
const source = (await readFile(new URL('./UnsignedInstaller.nsi', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const start = source.indexOf('  ClearErrors\n  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName"');
const end = source.indexOf('  Call MigrateStartupCommand', start);
assert(start >= 0 && end > start);
const lines = source.slice(start, end).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith(';'));

function simulate({ failWrite = -1, failRead = -1, mismatchRead = -1 } = {}) {
  let error = false, write = 0, read = 0, lastRead = -1;
  const touched = [];
  for (let pc = 0; pc < lines.length; pc++) {
    const line = lines[pc];
    if (line === 'ClearErrors') error = false;
    else if (/^(?:WriteRegStr|WriteRegDWORD|CreateDirectory|CreateShortCut) /.test(line)) {
      touched.push(line); error = write++ === failWrite;
    } else if (line.startsWith('ReadRegStr ')) { lastRead = read++; error = lastRead === failRead; }
    else if (line === 'IfErrors activation_failed') { if (error) return { failed: true, touched }; }
    else if (line.startsWith('StrCmpS $0 ')) { if (lastRead !== mismatchRead) pc++; }
    else if (line === 'Goto activation_failed') return { failed: true, touched };
    else if (line !== 'Call CheckFixedPath') throw new Error(`Unexpected activation instruction: ${line}`);
  }
  return { failed: false, touched };
}

test('mocked failure of every activation mutation stops before later mutations', () => {
  const baseline = simulate(); assert.equal(baseline.failed, false); assert.equal(baseline.touched.length, 10);
  for (let fault = 0; fault < baseline.touched.length; fault++) {
    const result = simulate({ failWrite: fault });
    assert.equal(result.failed, true, `write ${fault} was not detected`);
    assert.deepEqual(result.touched, baseline.touched.slice(0, fault + 1), `write ${fault} ran later mutations`);
  }
});

test('mocked activation read failures and mismatches stop before shortcut mutations', () => {
  for (let fault = 0; fault < 3; fault++) for (const kind of ['failRead', 'mismatchRead']) {
    const result = simulate({ [kind]: fault });
    assert.equal(result.failed, true, `${kind} ${fault} was not detected`);
    assert.equal(result.touched.length, 7);
  }
});
