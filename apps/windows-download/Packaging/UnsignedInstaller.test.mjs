import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const source = (await readFile(new URL('./UnsignedInstaller.nsi', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const active = source.split('\n').filter(line => !line.trimStart().startsWith(';')).join('\n');
const builder = (await readFile(new URL('../../../scripts/windows-unsigned-installer.ps1', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const updateHelper = (await readFile(new URL('../App/Updates/ExeUpdateWindowsHelper.cs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const install = active.slice(active.indexOf('Section "Install"'), active.indexOf('Function un.onInit'));
const init = active.slice(active.indexOf('Function .onInit'), active.indexOf('Section "Install"'));
const uninit = active.slice(active.indexOf('Function un.onInit'), active.indexOf('Section "Uninstall"'));
const uninstall = active.slice(active.indexOf('Section "Uninstall"'));
const finishStart = active.slice(active.indexOf('Function FinishStartLedgeTopFiles'), active.indexOf('Function un.onInit'));
const outsideFinishStart = active.replace(finishStart, '');
const legacyRetirement = active.slice(active.indexOf('Function RetireOwnedLegacyPreview'), active.indexOf('Function FinishStartLedgeTopFiles'));
const before = (text, a, b) => assert(text.indexOf(a) >= 0 && text.indexOf(a) < text.indexOf(b), `${a} must precede ${b}`);
const noBusyMutations = text => assert.doesNotMatch(text, /^\s*(?:ExecShell|Call|WriteReg\w*|Delete\w*|RMDir|CreateDirectory)\b/im);

test('every activation registry and shortcut write fails closed immediately', () => {
  const activation = install.slice(install.lastIndexOf('ClearErrors', install.indexOf('WriteRegStr HKCU')), install.indexOf('Call MigrateStartupCommand'));
  const mutations = activation.match(/^\s*(?:WriteRegStr|WriteRegDWORD|CreateDirectory|CreateShortCut) .*$/gm) ?? [];
  assert.equal(mutations.length, 10);
  for (const mutation of mutations) {
    const command = mutation.trim();
    assert(activation.includes(`ClearErrors\n  ${command}\n  IfErrors activation_failed`), `${command} lacks immediate failure detection`);
  }
  for (const field of ['DisplayVersion', 'InstallLocation', 'UninstallString']) {
    assert.match(activation, new RegExp(`ReadRegStr \\$0 HKCU "\\$\\{UNINSTALL_KEY\\}" "${field}"\\n  IfErrors activation_failed\\n  StrCmpS \\$0`));
  }
  const failed = install.slice(install.indexOf('activation_failed:'), install.indexOf('install_done:'));
  assert.match(failed, /active version may be only partly changed/i);
  assert.doesNotMatch(failed, /Delete|RMDir|--installer-remove|rollback/i);
});

test('every installer marker write is checked before uninstaller and activation', () => {
  const marker = install.slice(install.indexOf('installed_payload_pass:'), install.indexOf('WriteRegStr HKCU'));
  const writes = marker.match(/^\s*WriteINIStr .*$/gm) ?? [];
  assert.equal(writes.length, 4);
  for (const write of writes) assert(marker.includes(`ClearErrors\n  ${write.trim()}\n  IfErrors install_failed`));
});

test('path failures report partial activation once registry writes begin', () => {
  before(install, 'StrCpy $ActivationStarted 1', 'WriteRegStr HKCU');
  const pathCheck = source.slice(source.indexOf('!macro PathCheck Prefix'), source.indexOf('!macroend', source.indexOf('!macro PathCheck Prefix')));
  assert.match(pathCheck, /StrCmp \$ActivationStarted 1 path_report_active_\$\{Prefix\}/);
  assert.match(pathCheck, /path_report_active_\$\{Prefix\}:[\s\S]*active version may be only partly changed/i);
  assert.equal((pathCheck.match(/Call \$\{Prefix\}ReportPathError/g) ?? []).length, 3);
  assert.doesNotMatch(pathCheck, /No files were changed/i);
  before(install, 'WriteRegStr HKCU', 'Call CheckFixedPath\n  ClearErrors\n  CreateShortCut');
});

test('legacy V2 retirement runs only after successful activation and never rolls installation back', () => {
  before(install, 'WriteUninstaller', 'Call RetireOwnedLegacyPreview');
  before(install, 'Call MigrateStartupCommand', 'Call RetireOwnedLegacyPreview');
  assert.match(install, /StrCmp \$StartupFailed 1 activation_failed[\s\S]*?--installer-audit-active-version[\s\S]*?StrCmp \$0 0 version_audit_pass[\s\S]*?version_audit_failed:[\s\S]*?SetErrorLevel 21[\s\S]*?Abort[\s\S]*?version_audit_pass:[\s\S]*?Call RetireOwnedLegacyPreview/);
  before(install, 'Call RetireOwnedLegacyPreview', 'StrCpy $FinishLaunchReady 1');
  assert.equal((active.match(/Call RetireOwnedLegacyPreview/g) ?? []).length, 1);
  assert.equal((legacyRetirement.match(/ExecWait/g) ?? []).length, 2);
  before(legacyRetirement, 'IfSilent retire_legacy_done', '--installer-probe-legacy-preview');
  before(legacyRetirement, '--installer-probe-legacy-preview', 'retire_legacy_no_receipt:');
  before(legacyRetirement, 'retire_legacy_no_receipt:', '--installer-recover-legacy-preview-interactive');
  assert.match(legacyRetirement, /--installer-recover-legacy-preview-interactive' \$0/);
  assert.doesNotMatch(legacyRetirement, /--installer-remove-connections|--installer-remove-legacy-preview|WriteReg|WriteINI|Delete|RMDir|Abort|SetErrorLevel|install_failed|activation_failed|--installer-request-quit/);
});

test('legacy retirement requires confirmation, retries only definite busy and silently defers', () => {
  assert.match(legacyRetirement, /IfErrors retire_legacy_review\n  StrCmp \$0 11 retire_legacy_done\n  StrCmp \$0 12 retire_legacy_no_receipt\n  StrCmp \$0 0 retire_legacy_no_receipt\n  StrCmp \$0 10 retire_legacy_busy retire_legacy_review/);
  assert.match(legacyRetirement, /retire_legacy_no_receipt:\n  ClearErrors\n  ExecWait '"\$INSTDIR\\LedgeTop\.Files\.exe" --installer-recover-legacy-preview-interactive' \$0\n  IfErrors retire_legacy_review\n  StrCmp \$0 0 retire_legacy_done\n  StrCmp \$0 10 retire_legacy_busy retire_legacy_review/);
  assert.match(legacyRetirement, /IfErrors retire_legacy_review\n  StrCmp \$0 0 retire_legacy_done\n  StrCmp \$0 10 retire_legacy_busy retire_legacy_review/);
  assert.equal((legacyRetirement.match(/IfSilent retire_legacy_done/g) ?? []).length, 1);
  assert.match(legacyRetirement, /IDRETRY retire_legacy_retry IDCANCEL retire_legacy_done/);
  const unknown = legacyRetirement.slice(legacyRetirement.indexOf('retire_legacy_review:'));
  assert.doesNotMatch(unknown, /IDRETRY|Goto retire_legacy_retry|ExecWait|\bCall\b/);
  assert(unknown.includes('Setup will not guess or repeat an uncertain removal.'));
  assert(legacyRetirement.includes('Windows may remove online-only entries'));
  assert(legacyRetirement.includes('partially downloaded or locally changed files may not be preserved'));
  assert(unknown.includes('Check the old folder for files that remain.'));
  assert.match(unknown, /retire_legacy_done:\n  ClearErrors\n  Pop \$0\nFunctionEnd/);
});

test('uninstall explicitly warns before connection removal; silent and declined cases refuse', () => {
  before(uninstall, 'IfSilent un_user_refused', 'MessageBox MB_YESNO');
  before(uninstall, 'IDYES un_user_confirmed IDNO un_user_refused', '--installer-remove-connections');
  assert.match(uninstall, /un_user_refused:\n    SetErrorLevel 20\n    Abort\n  un_user_confirmed:/);
  assert(uninstall.includes('Windows may remove online-only files'));
  assert(uninstall.includes('partially downloaded or locally changed files may not be preserved'));
  assert(!uninstall.includes('user files were retained'));
});

test('silent update launches setup, while silent uninstall refusal is scoped to uninstall cleanup', () => {
  assert.match(updateHelper, /Spawn\(offer\.Handoff\.Candidate\.InstallerPath, \["\/S"\], true\)/);
  assert.doesNotMatch(updateHelper, /uninstall\.exe/i);
  assert.doesNotMatch(install, /IfSilent un_user_refused|--installer-remove-connections/);
  before(install, 'Call RetireOwnedLegacyPreview', 'Goto install_done');
  before(legacyRetirement, 'IfSilent retire_legacy_done', '--installer-recover-legacy-preview-interactive');
  assert.match(uninstall, /IfSilent un_user_refused/);
});

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
  assert.match(uninstall, /StrCmp \$0 0 un_cleanup_pass\n  StrCmp \$0 12 un_legacy_unknown\n    StrCmp \$0 10 0 un_cleanup_review/);
  assert.match(uninstall, /un_cleanup_refused:\n    SetErrorLevel \$0\n    Abort\n  un_legacy_unknown:/);
  assert.match(uninstall, /un_legacy_unknown:[\s\S]*No saved old Preview ownership record was found; an old Explorer entry may remain\.[\s\S]*If you previously used LedgeTop Files Preview, its entry may remain in File Explorer\. Contact LedgeTop support[\s\S]*Goto un_cleanup_pass/);
  before(uninstall, '"InstallLocation"', '!insertmacro DeletePayload');
});
test('uninstall invokes the maintenance helper in its own fixed version directory', () => {
  assert.match(uninit, /StrCmp \$INSTDIR "\$\{TARGET\}"/);
  assert.match(uninstall, /ExecWait '"\$INSTDIR\\LedgeTop\.Files\.exe" --installer-remove-connections' \$0/);
  assert.match(uninstall, /StrCmp \$0 12 un_legacy_unknown/);
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
  const preflight = install.slice(install.indexOf('preflight_retry:'), install.indexOf('preflight_pass:'));
  assert.match(preflight, /StrCmp \$0 0 preflight_pass\n    StrCmp \$0 10 0 preflight_review\n    IfSilent preflight_refused/);
  assert.match(preflight, /\/SD IDNO IDYES preflight_stop IDNO preflight_refused/);
  assert.match(preflight, /preflight_stop:[\s\S]*ExecWait '"\$INSTDIR\\LedgeTop\.Files\.exe" --installer-request-quit' \$0\n    IfErrors preflight_failed\n    StrCmp \$0 0 preflight_retry\n    StrCmp \$0 10 0 preflight_review/);
  assert.match(preflight, /\/SD IDCANCEL IDRETRY preflight_retry IDCANCEL preflight_refused/);
  assert(preflight.includes('LT tray icon') && preflight.includes('choose Quit LedgeTop Files'));
  assert(preflight.includes('Closing Settings does not quit the app.'));
  const preflightBusy = preflight.slice(0, preflight.indexOf('preflight_review:'));
  noBusyMutations(preflightBusy);
  assert.equal((preflightBusy.match(/^\s*ExecWait\b/gm) ?? []).length, 2, 'preflight allows only its check and explicit graceful quit');
  const preflightUnknown = preflight.slice(preflight.indexOf('preflight_review:'), preflight.indexOf('preflight_failed:'));
  assert.match(preflightUnknown, /LedgeTop support[\s\S]*before trying again[\s\S]*Setup code: \$0[\s\S]*SetErrorLevel \$0\n    Abort/);
  assert.doesNotMatch(preflightUnknown, /ExecWait|ExecShell|\bCall\b|WriteReg|Delete|CreateDirectory/);
  const secondBusy = install.slice(install.indexOf('StrCmp $0 10 0 installed_payload_review'), install.indexOf('installed_payload_review:'));
  assert(secondBusy.includes('LT tray icon') && secondBusy.includes('choose Quit LedgeTop Files'));
  assert(secondBusy.includes('Closing Settings does not quit the app.'));
  assert(secondBusy.includes('kept this version\'s installation folder for review'));
  assert(secondBusy.includes('ask LedgeTop support'));
  assert.doesNotMatch(secondBusy, /Then run setup again/i);
  noBusyMutations(secondBusy);
  assert.doesNotMatch(secondBusy, /^\s*ExecWait\b/im);
  const lateUnknown = install.slice(install.indexOf('installed_payload_review:'), install.indexOf('installed_payload_pass:'));
  assert.match(lateUnknown, /LedgeTop support[\s\S]*before trying again[\s\S]*Setup code: \$0[\s\S]*SetErrorLevel \$0\n    Abort/);
  assert.doesNotMatch(lateUnknown, /ExecWait|ExecShell|\bCall\b|WriteReg|Delete|CreateDirectory/);
  const uninstallBusy = uninstall.slice(uninstall.indexOf('StrCmp $0 0 un_cleanup_pass'), uninstall.indexOf('un_cleanup_review:'));
  assert.match(uninstallBusy, /StrCmp \$0 12 un_legacy_unknown\n    StrCmp \$0 10 0 un_cleanup_review/);
  assert.match(uninstallBusy, /\/SD IDNO IDYES un_request_stop IDNO un_cleanup_refused/);
  assert.match(uninstallBusy, /un_request_stop:[\s\S]*ExecWait '"\$INSTDIR\\LedgeTop\.Files\.exe" --installer-request-quit' \$0\n    IfErrors un_failed\n    StrCmp \$0 0 un_cleanup_retry\n    StrCmp \$0 10 0 un_cleanup_review/);
  assert.match(uninstallBusy, /\/SD IDCANCEL IDRETRY un_cleanup_retry IDCANCEL un_cleanup_refused/);
  assert(uninstallBusy.includes('older LedgeTop Files Preview is still running, quit it from its tray icon first'));
  noBusyMutations(uninstallBusy);
  const uninstallUnknown = uninstall.slice(uninstall.indexOf('un_cleanup_review:'), uninstall.indexOf('un_legacy_unknown:'));
  assert.match(uninstallUnknown, /LedgeTop support[\s\S]*before trying again[\s\S]*Cleanup code: \$0[\s\S]*SetErrorLevel \$0\n    Abort/);
  assert.doesNotMatch(uninstallUnknown, /ExecWait|ExecShell|\bCall\b|WriteReg|Delete|CreateDirectory/);
  assert.equal((uninstallBusy.match(/ExecWait/g) ?? []).length, 1, 'only the explicit graceful quit is allowed in the uninstall busy branch');
  assert.deepEqual((active.match(/^\s*ExecWait .*$/gm) ?? []).map(line => line.trim()), [
    `ExecWait '"$INSTDIR\\LedgeTop.Files.exe" --installer-check' $0`,
    `ExecWait '"$INSTDIR\\LedgeTop.Files.exe" --installer-request-quit' $0`,
    `ExecWait '"$INSTDIR\\LedgeTop.Files.exe" --installer-check' $0`,
    `ExecWait '"$INSTDIR\\LedgeTop.Files.exe" --installer-audit-active-version' $0`,
    `ExecWait '"$INSTDIR\\LedgeTop.Files.exe" --installer-probe-legacy-preview' $0`,
    `ExecWait '"$INSTDIR\\LedgeTop.Files.exe" --installer-recover-legacy-preview-interactive' $0`,
    `ExecWait '"$INSTDIR\\LedgeTop.Files.exe" --installer-remove-connections' $0`,
    `ExecWait '"$INSTDIR\\LedgeTop.Files.exe" --installer-request-quit' $0`,
  ]);
});
test('busy-flow mutation guard rejects registry and INI deletion commands', () => {
  const blocks = [
    install.slice(install.indexOf('preflight_retry:'), install.indexOf('preflight_review:')),
    install.slice(install.indexOf('StrCmp $0 10 0 installed_payload_review'), install.indexOf('installed_payload_review:')),
    uninstall.slice(uninstall.indexOf('StrCmp $0 0 un_cleanup_pass'), uninstall.indexOf('un_cleanup_review:')),
  ];
  for (const block of blocks) { assert(block.length > 0); noBusyMutations(block); }
  for (const command of ['DeleteRegKey HKCU "Software\\Example"', 'DeleteRegValue HKCU "Software\\Example" "Value"',
    'DeleteINISec "example.ini" "Section"', 'DeleteINIStr "example.ini" "Section" "Key"']) {
    for (const block of blocks)
      assert.throws(() => noBusyMutations(`${block}\n  ${command}`), assert.AssertionError, command);
  }
});
test('late busy retains fixed target and directs to support instead of an impossible retry', () => {
  before(install, 'CreateDirectory "$INSTDIR"', 'StrCmp $0 10 0 installed_payload_review');
  const late = install.slice(install.indexOf('StrCmp $0 10 0 installed_payload_review'), install.indexOf('installed_payload_pass:'));
  assert.match(late, /Goto installed_payload_refused/);
  assert.match(late, /installed_payload_refused:\s*SetErrorLevel \$0\s*Abort/);
  assert.doesNotMatch(late, /^\s*(?:Delete|RMDir|ExecWait|WriteReg)\b/im);
  const exists = active.slice(active.indexOf('installer_exists:'), active.indexOf('init_done:'));
  assert.match(exists, /cannot safely continue/);
  assert.match(exists, /support to review this installation folder/);
  assert.match(exists, /SetErrorLevel 20\s*Abort/);
  assert.doesNotMatch(exists, /^\s*(?:Delete|RMDir|ExecWait|WriteReg)\b/im);
});
test('silent refusal has safe default dialog and nonzero explicit exit status', () => {
  for (const line of active.split('\n').filter(s => s.trimStart().startsWith('MessageBox ')))
    assert(line.endsWith('/SD IDOK') || line.includes('/SD IDNO IDYES preflight_stop IDNO preflight_refused') || line.includes('/SD IDCANCEL IDRETRY preflight_retry IDCANCEL preflight_refused') || line.includes('/SD IDCANCEL IDRETRY retire_legacy_retry IDCANCEL retire_legacy_done') || line.includes('/SD IDNO IDYES retire_legacy_remove IDNO retire_legacy_done') || line.includes('/SD IDNO IDYES un_user_confirmed IDNO un_user_refused') || line.includes('/SD IDNO IDYES un_request_stop IDNO un_cleanup_refused') || line.includes('/SD IDCANCEL IDRETRY un_cleanup_retry IDCANCEL un_cleanup_refused'));
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


test('interactive busy preflight offers graceful stop and retry without recreating setup or target', () => {
  const loop = install.slice(install.indexOf('preflight_retry:'), install.indexOf('preflight_pass:'));
  before(loop, 'StrCmp $0 10 0 preflight_review', 'IfSilent preflight_refused');
  before(loop, 'IfSilent preflight_refused', 'MB_YESNO|MB_ICONQUESTION');
  assert.match(loop, /IDYES preflight_stop IDNO preflight_refused/);
  assert.match(loop, /ExecWait '"\$INSTDIR\\LedgeTop.Files.exe" --installer-request-quit' \$0/);
  assert.match(loop, /StrCmp \$0 0 preflight_retry/);
  assert.match(loop, /MB_RETRYCANCEL/);
  assert.match(loop, /IDRETRY preflight_retry IDCANCEL preflight_refused/);
  assert.match(loop, /Older versions need you to quit once/);
  assert.doesNotMatch(loop, /CreateDirectory|WriteReg|Delete|TerminateProcess|taskkill/i);
});

test('version conflict refuses both preflight checks without activation', () => {
  assert.equal((install.match(/--installer-check/g) ?? []).length, 2);
  assert.equal((install.match(/StrCmp \$0 21 0 \+4/g) ?? []).length, 2);
  assert.match(install, /preflight_review:[\s\S]*?StrCmp \$0 21 0 \+4[\s\S]*?SetErrorLevel 21[\s\S]*?Abort/);
  assert.match(install, /installed_payload_review:[\s\S]*?StrCmp \$0 21 0 \+4[\s\S]*?SetErrorLevel 21[\s\S]*?Abort/);
  before(install, 'installed_payload_review:', 'WriteINIStr');
});

test('recognized initial startup must remain the migrated target before retirement', () => {
  assert.match(init, /init_done:\n  Call CaptureInitialOwnedStartup/);
  before(install, 'Call MigrateStartupCommand', 'Call VerifyInitialOwnedStartup');
  before(install, 'Call VerifyInitialOwnedStartup', '--installer-audit-active-version');
  assert.match(install, /Call VerifyInitialOwnedStartup\n  StrCmp \$StartupFailed 1 version_audit_failed/);
});
