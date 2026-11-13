import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

// Pure intended ownership model + source gates only. No NSIS/native registry execution.
const source = (await readFile(new URL('./UnsignedInstaller.nsi', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const active = source.split('\n').filter(line => !line.trimStart().startsWith(';')).join('\n');
const read = active.slice(active.indexOf('Function ${Prefix}ReadStartupValue'), active.indexOf('!macroend', active.indexOf('Function ${Prefix}ReadStartupValue')));
const migrate = active.slice(active.indexOf('Function MigrateStartupCommand'), active.indexOf('Function un.RemoveStartupCommand'));
const remove = active.slice(active.indexOf('Function un.RemoveStartupCommand'), active.indexOf('Function ValidateVersion'));
const install = active.slice(active.indexOf('Section "Install"'), active.indexOf('Function un.onInit'));
const uninstall = active.slice(active.indexOf('Section "Uninstall"'));
const before = (text, a, b) => assert(text.indexOf(a) >= 0 && text.indexOf(b) > text.indexOf(a), `${a} precedes ${b}`);
const oldRoot = 'C:\\owned\\versions\\1.2.3.4', newRoot = 'C:\\owned\\versions\\1.2.3.5';
const command = (root, alias) => `"${root}\\LedgeTop.Files.exe" --startup-saved-source-v1 ${alias}`;
const reg = text => ({ type: 1, bytes: Buffer.from(text + '\0', 'utf16le') });
function rawSz(value) {
  if (!value || value.type !== 1 || !Buffer.isBuffer(value.bytes) || value.bytes.length < 2 || value.bytes.length > 522 || value.bytes.length >= 2048 || value.bytes.length % 2) return null;
  const words = Array.from({ length: value.bytes.length / 2 }, (_, i) => value.bytes.readUInt16LE(i * 2));
  if (words.at(-1) !== 0 || words.slice(0, -1).includes(0)) return null;
  return value.bytes.subarray(0, -2).toString('utf16le');
}
function expectedChange(kind, value, activeValidated = true, priorExists = true, targetRoot = newRoot) {
  if (!activeValidated || kind === 'migrate' && !priorExists) return null;
  const text = rawSz(value);
  for (const alias of ['portal', 'employee']) if (text === command(kind === 'migrate' ? oldRoot : newRoot, alias))
    return kind === 'migrate' ? command(targetRoot, alias).length <= 260 ? { type: 1, text: command(targetRoot, alias) } : { needsReview: true } : { deleteExactNamedValue: true };
  return null;
}

test('only exact prior/active REG_SZ commands are owned; aliases preserved and opt-out retained', () => {
  for (const alias of ['portal', 'employee']) {
    assert.deepEqual(expectedChange('migrate', reg(command(oldRoot, alias))), { type: 1, text: command(newRoot, alias) });
    assert.deepEqual(expectedChange('remove', reg(command(newRoot, alias))), { deleteExactNamedValue: true });
    assert.equal(expectedChange('migrate', reg(command(oldRoot, alias)), false), null);
    assert.equal(expectedChange('migrate', reg(command(oldRoot, alias)), true, false), null);
    assert.equal(expectedChange('remove', reg(command(oldRoot, alias))), null);
  }
  for (const text of ['', command(oldRoot, 'Portal'), command(oldRoot, 'other'), command(oldRoot, 'portal') + ' --extra',
    command(oldRoot, 'portal').replace('LedgeTop.Files.exe', 'ledgetop.files.exe'), command(oldRoot, 'portal').replace('"', ''),
    command(oldRoot, 'portal').replace(' --startup', '  --startup'), command('C:\\foreign', 'portal'), command(newRoot, 'portal')])
    assert.equal(expectedChange('migrate', reg(text)), null);
  assert.equal(expectedChange('migrate', null), null);
  assert.equal(expectedChange('remove', null), null);
});

test('raw type/length/terminator gates preserve foreign and malformed registry data', () => {
  const text = command(oldRoot, 'portal');
  for (const type of [0, 2, 3, 4, 7, 11]) assert.equal(rawSz({ ...reg(text), type }), null);
  for (const bytes of [Buffer.alloc(0), Buffer.from([0]), Buffer.alloc(2050), Buffer.from(text, 'utf16le'),
    Buffer.from(text + '\0hidden\0', 'utf16le'), Buffer.from(text + '\0\0', 'utf16le'), Buffer.from(text + '\0', 'utf16le').subarray(1)])
    assert.equal(rawSz({ type: 1, bytes }), null);
  assert.equal(rawSz(reg(text)), text);
});

test('recognized opt-in migrates through260chars and explicitly pauses before any longer target write', () => {
  for (const alias of ['portal', 'employee']) {
    const target = length => 'C:\\' + 'x'.repeat(length - command('C:\\', alias).length);
    for (const length of [259, 260]) {
      assert.equal(command(target(length), alias).length, length);
      assert.deepEqual(expectedChange('migrate', reg(command(oldRoot, alias)), true, true, target(length)), { type: 1, text: command(target(length), alias) });
    }
    assert.equal(command(target(261), alias).length, 261);
    assert.deepEqual(expectedChange('migrate', reg(command(oldRoot, alias)), true, true, target(261)), { needsReview: true });
  }
});

test('raw260-character boundary is exact and saturated/unterminated data stays unowned', () => {
  assert.equal(rawSz(reg('x'.repeat(260))), 'x'.repeat(260));
  assert.equal(rawSz(reg('x'.repeat(261))), null);
  assert.equal(rawSz({ type: 1, bytes: Buffer.from('x'.repeat(261), 'utf16le') }), null);
  assert.equal(rawSz({ type: 1, bytes: Buffer.from('x'.repeat(1024), 'utf16le') }), null);
  assert.equal(expectedChange('migrate', reg(command('C:\\' + 'x'.repeat(260), 'portal'))), null);
});

test('NSIS uses fixed HKCU64 raw query with strict type, bounded zeroed buffer and exact UTF16 byte count', () => {
  assert.match(active, /!define STARTUP_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Run"/);
  assert.match(active, /!define STARTUP_VALUE "LedgeTopFilesPilot"/);
  assert.match(active, /RegOpenKeyExW\(p 0x80000001,w "\$\{STARTUP_KEY\}",i0,i0x103,\*p \.r0\)/);
  assert.equal((read.match(/RegQueryValueExW/g) ?? []).length, 2);
  assert.equal((read.match(/StrCmp \$0 1 0/g) ?? []).length, 2);
  assert.match(read, /IntOp \$2 \$1 & 1/);
  assert.match(read, /IntCmp \$1 522 0 0 startup_read_done_/);
  assert.match(read, /IntCmp \$1 \$2 startup_read_done_\$\{Prefix\} 0 startup_read_done_\$\{Prefix\}/);
  before(read, 'IntCmp $1 522', 'GlobalAlloc');
  assert.match(read, /IntOp \$2 \$\{NSIS_MAX_STRLEN\} \* 2\n  IntOp \$2 \$2 \+ 2/);
  assert.match(read, /GlobalAlloc\(i0x40,p r2\)/);
  assert.match(read, /StrCmp \$1 \$StartupBytes/);
  // System v313 Source/System.c779-861: INPUT advances to output; another dot
  // skips that slot. Preserve actual updated pcbData rather than a stale register.
  assert.match(read, /\*i \$StartupBytes r1\)i\.r2/);
  assert.doesNotMatch(read, /\*i \$StartupBytes \.r1/);
  assert.match(read, /StrLen \$0 \$StartupText\n  IntOp \$0 \$0 \+ 1\n  IntOp \$0 \$0 \* 2\n  StrCmp \$0 \$StartupBytes/);
  assert.match(read, /GlobalFree\(p \$StartupData\)/);
  assert.doesNotMatch(read, /ReadRegStr|ExpandEnvironment|RegGetValue/);
});

test('migration follows validated activation, re-queries ownership and writes/readbacks one literal REG_SZ value', () => {
  before(install, 'CreateShortCut', 'Call MigrateStartupCommand');
  before(install, 'IfErrors activation_failed', 'Call MigrateStartupCommand');
  assert.match(migrate, /StrCmp \$ExistingVersion "" startup_migrate_done/);
  before(migrate, '"DisplayVersion"', 'Call OpenStartupKey');
  before(migrate, '"InstallLocation"', 'Call OpenStartupKey');
  assert.equal((migrate.match(/Call ReadStartupValue/g) ?? []).length, 3);
  assert.equal((migrate.match(/RegSetValueExW/g) ?? []).length, 1);
  assert.match(migrate, /StrCpy \$4 \$StartupNew\n  System::Call 'advapi32::RegSetValueExW\(p \$StartupKey,w "\$\{STARTUP_VALUE\}",i0,i1,w r4,i r0\)/);
  assert.doesNotMatch(migrate, /w "\$StartupNew"/);
  before(migrate, 'StrCmpS $StartupText $StartupOld', 'RegSetValueExW');
  before(migrate, 'IntCmp $0 260 0 0 startup_migrate_failed_close', 'RegSetValueExW');
  assert.match(migrate, /StrCmpS \$StartupText \$StartupNew 0 startup_migrate_failed_close/);
  assert.match(migrate, /Call CloseStartupKey/);
});

test('uninstall deletes only exact active command before payload and confirms missing named value', () => {
  before(uninstall, '!insertmacro ValidatePayloadPaths', 'Call un.RemoveStartupCommand');
  before(uninstall, 'Call un.RemoveStartupCommand', '!insertmacro DeletePayload');
  before(remove, '"DisplayVersion"', 'Call un.OpenStartupKey');
  before(remove, '"InstallLocation"', 'Call un.OpenStartupKey');
  assert.equal((remove.match(/Call un.ReadStartupValue/g) ?? []).length, 2);
  before(remove, 'StrCmpS $StartupText $StartupOld', 'RegDeleteValueW');
  assert.equal((remove.match(/RegDeleteValueW/g) ?? []).length, 1);
  assert.match(remove, /RegDeleteValueW\(p \$StartupKey,w "\$\{STARTUP_VALUE\}"\)/);
  assert.match(remove, /StrCmp \$1 2 0 startup_remove_failed_close/);
  assert.match(remove, /Call un.CloseStartupKey/);
  assert.doesNotMatch(active, /DeleteRegKey[^\n]*STARTUP_KEY|RegCreateKey|RegDeleteTree|RegSetValueExW[^\n]*,i2,/);
});
