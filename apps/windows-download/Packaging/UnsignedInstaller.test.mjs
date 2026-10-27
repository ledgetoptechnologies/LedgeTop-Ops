import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const source = (await readFile(new URL('./UnsignedInstaller.nsi', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const active = source.split('\n').filter(line => !line.trimStart().startsWith(';')).join('\n');
const builder = (await readFile(new URL('../../../scripts/windows-unsigned-installer.ps1', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const install = active.slice(active.indexOf('Section "Install"'), active.indexOf('Function un.onInit'));
const init = active.slice(active.indexOf('Function .onInit'), active.indexOf('Section "Install"'));
const uninit = active.slice(active.indexOf('Function un.onInit'), active.indexOf('Section "Uninstall"'));
const uninstall = active.slice(active.indexOf('Section "Uninstall"'));
const finishStart = active.slice(active.indexOf('Function FinishStartLedgeTopFiles'), active.indexOf('Function un.onInit'));
const outsideFinishStart = active.replace(finishStart, '');
const before = (text, a, b) => assert(text.indexOf(a) >= 0 && text.indexOf(a) < text.indexOf(b), `${a} must precede ${b}`);

test('explicit immutable builder inputs have no installable defaults', () => {
  for (const name of ['APP_VERSION', 'OUTPUT_FILE', 'PAYLOAD_MANIFEST_SHA256', 'PAYLOAD_INCLUDE', 'SOURCE_COMMIT'])
    assert(active.includes(`!ifndef ${name}\n  !error`));
});

test('installed inventory and source commit bind marker and version-resource anchor', () => {
  assert.match(active, /VIAddVersionKey \/LANG=1033 "Comments" "LedgeTop\.Files\.Payload\/1:\$\{PAYLOAD_MANIFEST_SHA256\}:\$\{SOURCE_COMMIT\}"/);
  assert.match(install, /WriteINIStr "\$INSTDIR\\installer-owned\.ini" "Installer" "SourceCommit" "\$\{SOURCE_COMMIT\}"/);
  assert.match(uninit, /ReadINIStr \$0 "\$INSTDIR\\installer-owned\.ini" "Installer" "SourceCommit"\n  StrCmp \$0 "\$\{SOURCE_COMMIT\}" 0 un_unknown/);
  before(install, '"SourceCommit"', 'WriteRegStr HKCU');
  // An older manually installed version needs no new sidecar/marker to move forward.
  assert.doesNotMatch(init, /ReadINIStr|installed-payload-inventory\.json|SourceCommit/);
});

test('installer-owned sidecar leaf refuses directory aliases and unknown inspection results before deletion', () => {
  const helper = active.slice(active.indexOf('Function un.CheckInventorySidecarPath'), active.indexOf('Function ValidateVersion'));
  assert.match(helper, /GetFileAttributesW\(w "\$INSTDIR\\installed-payload-inventory\.json"\)i\.r10/);
  assert.match(helper, /IntOp \$R2 \$R0 & 0x410/);
  assert.match(helper, /IntCmp \$R1 2 inventory_sidecar_done/);
  assert.match(helper, /IntCmp \$R1 3 inventory_sidecar_done/);
});

test('builder snapshots exact bounded bytes and generates only exact root sidecar operations', () => {
  assert.match(builder, /\$manifestBytes = BoundedJsonBytes \$PayloadInventoryPath 8388608/);
  assert.match(builder, /\$inventory = @\(JsonBytes \$manifestBytes\)/);
  assert.match(builder, /\$sidecarStream\.Write\(\$manifestBytes\)/);
  assert.match(builder, /FileMode\]::CreateNew/);
  assert(builder.includes(`$lines.Add('  File "/oname='+$inventoryLeaf+'" "'+(NsisLiteral $sidecarPath)+'"')`));
  assert(builder.includes(`$lines.Add('  Delete "$INSTDIR\\'+$inventoryLeaf+'"')`));
  assert(builder.includes(`$lines.Add('  Call un.CheckInventorySidecarPath')`));
  assert.match(builder, /\/DSOURCE_COMMIT=\$ReviewedCommit/);
  assert.match(builder, /GetVersionInfo\(\$installer\)\.Comments -cne \$anchor/);
  assert.match(builder, /installedInventoryBytes=\$manifestBytes.Length;installerOwnedSidecarFiles=1/);
  assert.equal((builder.match(/^AssertInventoryUnchanged$/gm) ?? []).length, 3);
});
test('user-only fixed versioned pilot target; command-line directory overridden', () => {
  assert.match(active, /RequestExecutionLevel user/);
  assert.match(active, /!define PRODUCT_BASE "\$LOCALAPPDATA\\Programs\\LedgeTop Files Pilot"/);
  assert.match(init, /StrCpy \$INSTDIR "\$\{TARGET\}"/);
  assert(!/\bHKLM\b|SetShellVarContext all|InstallDirRegKey/.test(active));
  assert.match(init, /RunningX64/); assert.match(init, /AtLeastWin11/); assert.match(init, /IsServerOS/);
});
test('aliases and unknown inspection failures refused; directory checks bracket creation', () => {
  assert.match(active, /GetFileAttributesW/); assert.match(active, /& 0x400/);
  assert.match(active, /GetFileAttributesW\(w r10\)i\.r11/);
  assert(!active.includes('rR0'));
  assert.match(active, /IntCmp \$R3 2 path_parent/); assert.match(active, /IntCmp \$R3 3 path_parent/);
  before(install, 'Call CheckFixedPath', 'CreateDirectory "$INSTDIR"');
  assert.match(install, /CreateDirectory "\$INSTDIR"\n  IfErrors install_failed\n  Call CheckFixedPath/);
  assert.match(active, /StrCpy \$R0 "\$SMPROGRAMS\\LedgeTop Files Pilot"/);
});
test('same-version directory is refused before extraction; overwrite disabled', () => {
  assert.match(init, /Goto installer_exists/); assert.match(init, /was not adopted or overwritten/);
  before(install, 'SetOverwrite off', '!insertmacro InstallPayload');
});
test('registry versions canonicalized and numerically compared before activation', () => {
  assert.match(active, /Function ValidateVersion/); assert.match(active, /IntCmp \$R4 65535/);
  before(init, 'Call ValidateVersion', '${VersionCompare}');
  assert.match(init, /\$\{VersionCompare\} \$ExistingVersion "\$\{APP_VERSION\}" \$0\n    StrCmp \$0 2 init_done/);
  assert.match(init, /registry_unknown/);
});
test('maintenance check success required before receipt and activation; normal launch only in guarded interactive Finish', () => {
  before(install, '--installer-check', 'WriteUninstaller');
  before(install, 'StrCmp $0 0', 'WriteRegStr HKCU');
  assert.match(install, /IfErrors install_failed/);
  assert(!/ExecShell|nsExec|taskkill|TerminateProcess|schtasks|\bRunOnce\b|https?:\/\//i.test(active));
  assert.doesNotMatch(outsideFinishStart, /\bExec\s/);
  assert.equal((active.match(/\bExec\s/g) ?? []).length, 1);
  assert.match(active, /!define STARTUP_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Run"/);
  assert.match(active, /!define STARTUP_VALUE "LedgeTopFilesPilot"/);
  assert.doesNotMatch(active, /WriteReg(?:Str|ExpandStr)[^\n]*STARTUP_KEY|DeleteRegKey[^\n]*STARTUP_KEY/);
});
test('Finish offers checked-by-default Start LedgeTop Files and invokes only its checkbox callback', () => {
  assert.match(active, /!define MUI_FINISHPAGE_RUN "\$\{TARGET\}\\LedgeTop\.Files\.exe"/);
  assert.match(active, /!define MUI_FINISHPAGE_RUN_TEXT "Start LedgeTop Files"/);
  assert.match(active, /!define MUI_FINISHPAGE_RUN_FUNCTION FinishStartLedgeTopFiles/);
  before(active, '!define MUI_FINISHPAGE_RUN_FUNCTION', '!insertmacro MUI_PAGE_FINISH');
  assert.doesNotMatch(active, /MUI_FINISHPAGE_RUN_NOTCHECKED/);
  assert.doesNotMatch(active, /Call FinishStartLedgeTopFiles/);
  assert.match(finishStart, /^Function FinishStartLedgeTopFiles\n  IfSilent finish_start_return\n/);
  before(finishStart, 'IfSilent finish_start_return', 'Exec ');
});
test('Finish launch requires successful install, exact activation and marker before releasing only own activity handle', () => {
  before(install, 'Call MigrateStartupCommand', 'StrCpy $FinishLaunchReady 1');
  before(install, 'StrCmp $StartupFailed 1 activation_failed', 'StrCpy $FinishLaunchReady 1');
  before(finishStart, 'StrCmp $FinishLaunchReady 1', 'Exec ');
  before(finishStart, 'StrCpy $FinishLaunchReady 0', 'Exec ');
  for (const field of ['DisplayVersion', 'InstallLocation', 'Owner', 'Version', 'PayloadManifestSha256', 'SourceCommit'])
    before(finishStart, `"${field}"`, 'CloseHandle(p $MutexHandle)');
  before(finishStart, 'Call CheckFixedPath', 'CloseHandle(p $MutexHandle)');
  assert.equal((finishStart.match(/IntOp \$1 \$0 & 0x410/g) ?? []).length, 2);
  before(finishStart, 'CloseHandle(p $MutexHandle)', 'StrCpy $MutexHandle 0');
  before(finishStart, 'StrCpy $MutexHandle 0', 'OpenMutexW');
  before(finishStart, 'OpenMutexW', 'Exec ');
  assert.match(finishStart, /IntCmp \$1 2 \+2\n    Goto finish_start_failed/);
  assert.match(finishStart, /Exec '"\$\{TARGET\}\\LedgeTop\.Files\.exe"'/);
  assert.doesNotMatch(finishStart, /WriteReg|WriteINI|Delete|SetOutPath|CreateDirectory|ExecWait|--startup|--reconnect|--installer|ReleaseMutex/);
});
test('old-version uninstaller refuses before any connection cleanup', () => {
  assert.match(uninit, /StrCmp \$INSTDIR "\$\{TARGET\}"/);
  before(uninit, '"InstallLocation"', 'ReadINIStr');
  assert.match(uninit, /not the active installed version/);
  assert.match(uninit, /"Owner"/); assert.match(uninit, /"Version"/); assert.match(uninit, /"PayloadManifestSha256"/);
});
test('cleanup refusal cannot fall through to payload deletion', () => {
  before(uninstall, '!insertmacro ValidatePayloadPaths', '--installer-remove-connections');
  assert.equal((uninstall.match(/!insertmacro ValidatePayloadPaths/g) ?? []).length, 2);
  before(uninstall, '--installer-remove-connections', '!insertmacro DeletePayload');
  before(uninstall, 'StrCmp $0 0', '!insertmacro DeletePayload');
  assert.match(uninstall, /StrCmp \$0 0 un_cleanup_pass\n    StrCmp \$0 10 0 un_cleanup_review/);
  assert.match(uninstall, /un_cleanup_refused:\n    SetErrorLevel \$0\n    Abort\n  un_cleanup_pass:/);
  before(uninstall, '"InstallLocation"', '!insertmacro DeletePayload');
});
test('temporary full-payload check precedes fixed-directory creation and permits retry', () => {
  before(install, 'InitPluginsDir', 'StrCpy $INSTDIR "$PLUGINSDIR\\preflight"');
  before(install, '--installer-check', 'StrCpy $INSTDIR $FixedTarget');
  before(install, 'StrCpy $INSTDIR $FixedTarget', 'CreateDirectory "$INSTDIR"');
  assert.equal((install.match(/!insertmacro InstallPayload/g) ?? []).length, 2);
  assert.equal((install.match(/--installer-check/g) ?? []).length, 2);
  assert.match(install, /StrCmp \$0 0 preflight_pass/);
});

test('only busy code10 gives tray Quit guidance at both setup checks and uninstall', () => {
  for (const [section, pass, review, refused] of [
    [install, 'preflight_pass', 'preflight_review', 'preflight_refused'],
    [install, 'installed_payload_pass', 'installed_payload_review', 'installed_payload_refused'],
    [uninstall, 'un_cleanup_pass', 'un_cleanup_review', 'un_cleanup_refused'],
  ]) {
    const start = section.indexOf(`StrCmp $0 0 ${pass}`);
    const stop = section.indexOf('SetErrorLevel $0\n    Abort', start);
    assert(start >= 0 && stop > start, 'nonzero maintenance result must still abort with its original code');
    const block = section.slice(start, stop);
    const split = block.indexOf(`${review}:`);
    assert.match(block, new RegExp(`StrCmp \\$0 10 0 ${review}`));
    const busy = block.slice(0, split), unknown = block.slice(split);
    assert(busy.includes('LT tray icon') && busy.includes('choose Quit LedgeTop Files'));
    assert(busy.includes('Closing Settings does not quit the app.'));
    assert(busy.includes(`Goto ${refused}`));
    assert(unknown.includes('Ask LedgeTop support for help before trying again.'));
    assert(unknown.includes('code: $0'));
    assert.doesNotMatch(unknown, /Then run (?:setup|uninstall) again/);
    assert.doesNotMatch(block, /ExecWait|ExecShell|\bCall\b|WriteReg|Delete|CreateDirectory/);
  }
  const secondBusy = install.slice(install.indexOf('StrCmp $0 10 0 installed_payload_review'), install.indexOf('installed_payload_review:'));
  assert(secondBusy.includes('If setup says this version already exists'));
  const uninstallBusy = uninstall.slice(0, uninstall.indexOf('un_cleanup_review:'));
  assert(uninstallBusy.includes('Also quit any old LedgeTop Files Preview tray icon.'));
  assert.equal((active.match(/ExecWait/g) ?? []).length, 3, 'message clarification adds no process launch or retry');
});
test('silent refusal has safe default dialog and nonzero explicit exit status', () => {
  for (const line of active.split('\n').filter(s => s.trimStart().startsWith('MessageBox ')))
    assert(line.endsWith('/SD IDOK'));
  for (const [index, line] of active.split('\n').entries()) if (line.trim() === 'Abort')
    assert(active.split('\n')[index - 1].trim().startsWith('SetErrorLevel '));
});
test('payload parents checked within exact target before any removal', () => {
  assert.match(active, /Function un\.CheckPayloadPath/);
  assert.match(active, /StrCmp \$R2 "\$\{TARGET\}" 0 payload_path_bad/);
  assert.match(active, /SetErrorLevel 20\n    Abort/);
  assert.match(active, /StrCmp \$R0 "\$\{TARGET\}" payload_path_done/);
});
test('delete surface is exact manifest plus installer-owned files; never recursive', () => {
  assert(!/RMDir\s+\/r|Delete\s+\/REBOOTOK|\$INSTDIR\\\*|\bFile\s+\/r/i.test(active));
  const deleteLines = active.split('\n').map(s => s.trim()).filter(s => s.startsWith('Delete '));
  assert.deepEqual(deleteLines, ['Delete "$INSTDIR\\installer-owned.ini"', 'Delete "$INSTDIR\\uninstall.exe"',
    'Delete "$SMPROGRAMS\\LedgeTop Files Pilot\\LedgeTop Files Pilot.lnk"', 'Delete "$SMPROGRAMS\\LedgeTop Files Pilot\\Uninstall.lnk"']);
  assert(!/profile\.json|manifest-|ExplorerPreview|\\Downloads|USERPROFILE/.test(active));
});
test('installer/uninstaller serialized and explicitly unsigned', () => {
  assert.equal((active.match(/CreateMutexW/g) ?? []).length, 2);
  assert.match(active, /unsigned preview/); assert(!/signtool|ForceUpdate|AppInstaller/i.test(active));
  assert.match(active, /"Publisher" "Ledge Top Technologies LLC"/);
});
