; Initial manual, unsigned per-user pilot installation. No updater, trust claim or auto-launch.
; Builder must provide vetted canonical APP_VERSION (four u16s), OUTPUT_FILE,
; PAYLOAD_MANIFEST_SHA256 and PAYLOAD_INCLUDE. Generated include defines ONLY:
; InstallPayload: explicit File commands into $INSTDIR, with SetOutPath for subdirs.
; DeletePayload: exact manifest Delete "$INSTDIR\relative-file" (no wildcards).
; RemovePayloadDirectories: deepest-first RMDir (NEVER /r), excluding $INSTDIR.
; ValidatePayloadPaths: ALL unique payload parent dirs (including $INSTDIR), each
; Push "$INSTDIR\relative-directory" then Call un.CheckPayloadPath.
; Builder must reject traversal, absolute paths, aliases, duplicate Windows names,
; installer-owned.ini/uninstall.exe collisions, and unexpected macro instructions.
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "WordFunc.nsh"
!include "FileFunc.nsh"
!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif
!ifndef PAYLOAD_MANIFEST_SHA256
  !error "PAYLOAD_MANIFEST_SHA256 is required"
!endif
!ifndef PAYLOAD_INCLUDE
  !error "PAYLOAD_INCLUDE is required"
!endif
!include "${PAYLOAD_INCLUDE}"
Name "LedgeTop Files Pilot (unsigned preview)"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
CRCCheck force
ManifestSupportedOS Win10
VIProductVersion "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "LedgeTop Files Pilot"
VIAddVersionKey /LANG=1033 "FileDescription" "Unsigned manual preview installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Ledge Top Technologies LLC"
!define PRODUCT_BASE "$LOCALAPPDATA\Programs\LedgeTop Files Pilot"
!define TARGET "${PRODUCT_BASE}\versions\${APP_VERSION}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\LedgeTopFilesPilot"
!define OWNER "LedgeTop.Files.UnsignedPilotInstaller/1"
Var ExistingVersion
Var MutexHandle
Var FixedTarget
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Check every existing ancestor, not merely the final directory. Windows cloud/
; junction/symlink aliases are refused before extraction or exact-file deletion.
!macro PathCheck Prefix
Function ${Prefix}CheckFixedPath
  StrCpy $R9 0
  StrCpy $R0 "${TARGET}"
  path_loop_${Prefix}:
    System::Call 'kernel32::GetFileAttributesW(w r10)i.r11 ?e'
    Pop $R3
    IntCmp $R1 -1 path_missing_${Prefix}
    IntOp $R2 $R1 & 0x400
    IntCmp $R2 0 +4
      MessageBox MB_ICONSTOP "An installation path is a reparse point. No files were changed." /SD IDOK
      SetErrorLevel 20
      Abort
    IntOp $R2 $R1 & 0x10
    IntCmp $R2 0 0 path_parent_${Prefix} path_parent_${Prefix}
      MessageBox MB_ICONSTOP "An installation directory changed type. No files were changed." /SD IDOK
      SetErrorLevel 20
      Abort
    Goto path_parent_${Prefix}
  path_missing_${Prefix}:
    IntCmp $R3 2 path_parent_${Prefix}
    IntCmp $R3 3 path_parent_${Prefix}
    MessageBox MB_ICONSTOP "An installation path cannot be inspected. No files were changed." /SD IDOK
    SetErrorLevel 20
    Abort
  path_parent_${Prefix}:
    ${GetParent} $R0 $R0
    StrCmp $R0 "" path_done_${Prefix}
    Goto path_loop_${Prefix}
  path_done_${Prefix}:
    StrCmp $R9 1 path_all_done_${Prefix}
    StrCpy $R9 1
    StrCpy $R0 "$SMPROGRAMS\LedgeTop Files Pilot"
    Goto path_loop_${Prefix}
  path_all_done_${Prefix}:
FunctionEnd
!macroend
!insertmacro PathCheck ""
!insertmacro PathCheck "un."

; Validate every payload parent BEFORE any deletion, not just the version root.
; The builder supplies canonical directory paths; this helper additionally pins
; their boundary to this exact fixed target and refuses every existing alias/type.
Function un.CheckPayloadPath
  Pop $R0
  ; NSIS GetFullPathName itself rejects missing parent directories; Win32's
  ; lexical normalization does not, so safe partial payload cleanup remains possible.
  System::Call 'kernel32::GetFullPathNameW(w r10,i ${NSIS_MAX_STRLEN},w .r14,p0)i.r15'
  IntCmp $R5 0 payload_path_bad payload_path_bad
  IntCmp $R5 ${NSIS_MAX_STRLEN} payload_path_bad 0 payload_path_bad
  StrCmp $R4 $R0 0 payload_path_bad
  StrLen $R1 "${TARGET}"
  StrCpy $R2 $R0 $R1
  StrCmp $R2 "${TARGET}" 0 payload_path_bad
  StrCmp $R0 "${TARGET}" payload_path_loop
  StrCpy $R2 $R0 1 $R1
  StrCmp $R2 "\" 0 payload_path_bad
  payload_path_loop:
    System::Call 'kernel32::GetFileAttributesW(w r10)i.r11 ?e'
    Pop $R3
    IntCmp $R1 -1 payload_path_missing
    IntOp $R2 $R1 & 0x400
    IntCmp $R2 0 0 payload_path_bad payload_path_bad
    IntOp $R2 $R1 & 0x10
    IntCmp $R2 0 payload_path_bad
    Goto payload_path_parent
  payload_path_missing:
    IntCmp $R3 2 payload_path_parent
    IntCmp $R3 3 payload_path_parent
    Goto payload_path_bad
  payload_path_parent:
    StrCmp $R0 "${TARGET}" payload_path_done
    ${GetParent} $R0 $R0
    StrCmp $R0 "" payload_path_bad
    Goto payload_path_loop
  payload_path_bad:
    MessageBox MB_ICONSTOP "A payload parent is outside this version or changed type/alias. Nothing was deleted." /SD IDOK
    SetErrorLevel 20
    Abort
  payload_path_done:
FunctionEnd

; Canonical four-component unsigned-16 version gate for untrusted registry values.
; Returns 1/0 on stack; temporary registers are deliberately not preserved.
Function ValidateVersion
  Pop $R0
  StrCpy $R1 0 ; character offset
  StrCpy $R2 0 ; completed components
  StrCpy $R4 "" ; component
  version_next:
    StrCpy $R3 $R0 1 $R1
    StrCmp $R3 "" version_component
    StrCmp $R3 "." version_component
    StrCmp $R3 "0" version_digit
    StrCmp $R3 "1" version_digit
    StrCmp $R3 "2" version_digit
    StrCmp $R3 "3" version_digit
    StrCmp $R3 "4" version_digit
    StrCmp $R3 "5" version_digit
    StrCmp $R3 "6" version_digit
    StrCmp $R3 "7" version_digit
    StrCmp $R3 "8" version_digit
    StrCmp $R3 "9" version_digit version_bad
  version_digit:
    StrCpy $R4 "$R4$R3"
    StrLen $R5 $R4
    IntCmp $R5 5 +1 +1 version_bad
    IntOp $R1 $R1 + 1
    Goto version_next
  version_component:
    StrCmp $R4 "" version_bad
    StrLen $R5 $R4
    StrCpy $R6 $R4 1
    StrCmp $R6 "0" 0 version_bound
    IntCmp $R5 1 version_bound version_bad version_bad
  version_bound:
    IntCmp $R4 65535 +1 +1 version_bad
    IntOp $R2 $R2 + 1
    StrCmp $R3 "" version_end
    IntCmp $R2 4 version_bad +1 version_bad
    StrCpy $R4 ""
    IntOp $R1 $R1 + 1
    Goto version_next
  version_end:
    IntCmp $R2 4 0 version_bad version_bad
    Push 1
    Return
  version_bad:
    Push 0
FunctionEnd

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Windows 11 x64 is required." /SD IDOK
    SetErrorLevel 20
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin11}
    MessageBox MB_ICONSTOP "Windows 11 x64 is required." /SD IDOK
    SetErrorLevel 20
    Abort
  ${EndIf}
  ${If} ${IsServerOS}
    MessageBox MB_ICONSTOP "This preview supports Windows 11 desktop only." /SD IDOK
    SetErrorLevel 20
    Abort
  ${EndIf}
  System::Call 'kernel32::CreateMutexW(p0,i0,w "Local\LedgeTopFilesPilotInstaller")p.r0 ?e'
  Pop $1
  StrCpy $MutexHandle $0
  IntCmp $1 183 installer_busy
  StrCmp $MutexHandle 0 installer_busy
  ; Override /D too: callers cannot choose a data/profile/root directory.
  StrCpy $INSTDIR "${TARGET}"
  Call CheckFixedPath
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR")i.r0'
  IntCmp $0 -1 +2
    Goto installer_exists
  Push "${APP_VERSION}"
  Call ValidateVersion
  Pop $0
  StrCmp $0 1 +4
    MessageBox MB_ICONSTOP "The build version is invalid." /SD IDOK
    SetErrorLevel 20
    Abort
  ReadRegStr $ExistingVersion HKCU "${UNINSTALL_KEY}" "DisplayVersion"
  ReadRegStr $1 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  StrCmp $ExistingVersion "" 0 existing_version
  StrCmp $1 "" init_done registry_unknown
  existing_version:
    StrCmp $1 "${PRODUCT_BASE}\versions\$ExistingVersion" 0 registry_unknown
    Push $ExistingVersion
    Call ValidateVersion
    Pop $0
    StrCmp $0 1 0 registry_unknown
    ${VersionCompare} $ExistingVersion "${APP_VERSION}" $0
    StrCmp $0 2 init_done
    MessageBox MB_ICONSTOP "The installed version is equal or newer. Downgrades and same-version replacement are refused." /SD IDOK
    SetErrorLevel 20
    Abort
  registry_unknown:
    MessageBox MB_ICONSTOP "Existing installation metadata needs review. No files were changed." /SD IDOK
    SetErrorLevel 20
    Abort
  installer_busy:
    MessageBox MB_ICONSTOP "Another pilot installer is running. Close it and try again." /SD IDOK
    SetErrorLevel 20
    Abort
  installer_exists:
    MessageBox MB_ICONSTOP "This version's directory already exists. It was not adopted or overwritten." /SD IDOK
    SetErrorLevel 20
    Abort
  init_done:
FunctionEnd

Section "Install"
  ; A running app is a normal refusal. Check a fresh NSIS-owned temp payload
  ; before creating the immutable version directory, so closing it permits retry.
  InitPluginsDir
  StrCpy $FixedTarget "${TARGET}"
  StrCpy $INSTDIR "$PLUGINSDIR\preflight"
  ClearErrors
  CreateDirectory "$PLUGINSDIR\preflight"
  IfErrors preflight_failed
  SetOutPath "$INSTDIR"
  SetOverwrite off
  ClearErrors
  !insertmacro InstallPayload
  IfErrors preflight_failed
  SetOutPath "$INSTDIR"
  ClearErrors
  ExecWait '"$INSTDIR\LedgeTop.Files.exe" --installer-check' $0
  IfErrors preflight_failed
  StrCmp $0 0 preflight_pass
    MessageBox MB_ICONSTOP "Close LedgeTop Files and resolve connection ownership before installing, then run this installer again. No fixed version directory was created. Check code: $0" /SD IDOK
    SetErrorLevel $0
    Abort
  preflight_failed:
    MessageBox MB_ICONSTOP "The temporary maintenance preflight could not run. No fixed version directory was created." /SD IDOK
    SetErrorLevel 20
    Abort
  preflight_pass:
  StrCpy $INSTDIR $FixedTarget
  Call CheckFixedPath
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR")i.r0'
  IntCmp $0 -1 fixed_target_absent
    MessageBox MB_ICONSTOP "This version directory appeared during preflight. It was not adopted or overwritten." /SD IDOK
    SetErrorLevel 20
    Abort
  fixed_target_absent:
  ClearErrors
  CreateDirectory "$INSTDIR"
  IfErrors install_failed
  Call CheckFixedPath
  SetOutPath "$INSTDIR"
  SetOverwrite off
  ClearErrors
  !insertmacro InstallPayload
  IfErrors install_failed
  SetOutPath "$INSTDIR"
  ClearErrors
  ExecWait '"$INSTDIR\LedgeTop.Files.exe" --installer-check' $0
  IfErrors install_failed
  StrCmp $0 0 installed_payload_pass
    MessageBox MB_ICONSTOP "Close LedgeTop Files and resolve any connection ownership warning before installing. The existing activation was kept. Check code: $0" /SD IDOK
    SetErrorLevel $0
    Abort
  installed_payload_pass:
  Call CheckFixedPath
  ClearErrors
  WriteINIStr "$INSTDIR\installer-owned.ini" "Installer" "Owner" "${OWNER}"
  WriteINIStr "$INSTDIR\installer-owned.ini" "Installer" "Version" "${APP_VERSION}"
  WriteINIStr "$INSTDIR\installer-owned.ini" "Installer" "PayloadManifestSha256" "${PAYLOAD_MANIFEST_SHA256}"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  IfErrors install_failed
  ; Activation occurs only after the new payload's read-only maintenance gate.
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "LedgeTop Files Pilot (unsigned preview)"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Ledge Top Technologies LLC"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\LedgeTop Files Pilot"
  Call CheckFixedPath
  CreateShortCut "$SMPROGRAMS\LedgeTop Files Pilot\LedgeTop Files Pilot.lnk" "$INSTDIR\LedgeTop.Files.exe"
  CreateShortCut "$SMPROGRAMS\LedgeTop Files Pilot\Uninstall.lnk" "$INSTDIR\uninstall.exe"
  IfErrors activation_failed
  Goto install_done
  install_failed:
    MessageBox MB_ICONSTOP "Installation stopped before activation. The new version's files were retained for review; existing versions and user data were kept." /SD IDOK
    SetErrorLevel 20
    Abort
  activation_failed:
    MessageBox MB_ICONSTOP "Installation metadata could not be completed. Files were retained for review. No user data was removed." /SD IDOK
    SetErrorLevel 20
    Abort
  install_done:
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  ; Refuse relocated uninstallers and _?= overrides, even if a lookalike receipt exists.
  StrCmp $INSTDIR "${TARGET}" +4
    MessageBox MB_ICONSTOP "The uninstaller is outside its exact version directory." /SD IDOK
    SetErrorLevel 20
    Abort
  Call un.CheckFixedPath
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  StrCmp $0 "$INSTDIR" +4
    MessageBox MB_ICONSTOP "This is not the active installed version. Its uninstaller cannot detach another version's connections." /SD IDOK
    SetErrorLevel 20
    Abort
  ReadINIStr $0 "$INSTDIR\installer-owned.ini" "Installer" "Owner"
  StrCmp $0 "${OWNER}" 0 un_unknown
  ReadINIStr $0 "$INSTDIR\installer-owned.ini" "Installer" "Version"
  StrCmp $0 "${APP_VERSION}" 0 un_unknown
  ReadINIStr $0 "$INSTDIR\installer-owned.ini" "Installer" "PayloadManifestSha256"
  StrCmp $0 "${PAYLOAD_MANIFEST_SHA256}" 0 un_unknown
  System::Call 'kernel32::CreateMutexW(p0,i0,w "Local\LedgeTopFilesPilotInstaller")p.r0 ?e'
  Pop $1
  StrCpy $MutexHandle $0
  IntCmp $1 183 un_unknown
  StrCmp $MutexHandle 0 un_unknown
  Return
  un_unknown:
    MessageBox MB_ICONSTOP "Installation ownership is unknown or another installer is running. Nothing was removed." /SD IDOK
    SetErrorLevel 20
    Abort
FunctionEnd

Section "Uninstall"
  Call un.CheckFixedPath
  !insertmacro ValidatePayloadPaths
  ClearErrors
  ExecWait '"$INSTDIR\LedgeTop.Files.exe" --installer-remove-connections' $0
  IfErrors un_failed
  StrCmp $0 0 un_cleanup_pass
    MessageBox MB_ICONSTOP "Close LedgeTop Files or resolve connection ownership before uninstalling. Nothing was deleted. Cleanup code: $0" /SD IDOK
    SetErrorLevel $0
    Abort
  un_cleanup_pass:
  Call un.CheckFixedPath
  ; Never delete a newer activation if it changed during maintenance cleanup.
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  StrCmp $0 "$INSTDIR" 0 un_failed
  !insertmacro ValidatePayloadPaths
  ClearErrors
  !insertmacro DeletePayload
  IfErrors un_failed
  !insertmacro RemovePayloadDirectories
  Delete "$INSTDIR\installer-owned.ini"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\LedgeTop Files Pilot\LedgeTop Files Pilot.lnk"
  Delete "$SMPROGRAMS\LedgeTop Files Pilot\Uninstall.lnk"
  RMDir "$SMPROGRAMS\LedgeTop Files Pilot"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ; Older versions and unknown residual files are deliberately retained.
  Goto un_done
  un_failed:
    MessageBox MB_ICONSTOP "Uninstall stopped. Owned integration or payload removal needs review; user files were retained." /SD IDOK
    SetErrorLevel 20
    Abort
  un_done:
SectionEnd
