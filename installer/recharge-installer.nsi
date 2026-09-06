; Custom Recharge installer (hand-authored, not Tauri's generated NSIS template).
; Packages the same target/release output tree Tauri's own build produces
; (recharge.exe + content/ + loader/ + mods/) so this can be built any time
; after `cargo tauri build` / `npm run tauri build` without touching that
; pipeline at all.
;
; Build:  makensis recharge-installer.nsi
; Needs RELEASE_DIR to point at app/src-tauri/target/release (passed via /DRELEASE_DIR=... or defaulted below).

!ifndef RELEASE_DIR
  !define RELEASE_DIR "..\app\src-tauri\target\release"
!endif

!define PRODUCT_NAME "Recharge"
!define PRODUCT_VERSION "1.1.0"
!define PRODUCT_PUBLISHER "SumDumIdiut"
!define PRODUCT_WEBSITE "https://codecade.co.za/recharge"
!define MAIN_EXE "recharge.exe"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

Name "${PRODUCT_NAME}"
OutFile "output\Recharge_${PRODUCT_VERSION}_Setup.exe"
InstallDir "$LOCALAPPDATA\Recharge"
RequestExecutionLevel user
Unicode true
SetCompressor /SOLID lzma

VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} Setup"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "LegalCopyright" "${PRODUCT_PUBLISHER}"

!include "MUI2.nsh"

!define MUI_ICON "assets\icon.ico"
!define MUI_UNICON "assets\icon.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "assets\header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "assets\header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "assets\welcome.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "assets\welcome.bmp"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Recharge Setup"
!define MUI_WELCOMEPAGE_TEXT "This installs Recharge, the IGTAP mod manager.$\r$\n$\r$\nClick Next to continue."

!define MUI_FINISHPAGE_RUN "$INSTDIR\${MAIN_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Recharge"
!define MUI_FINISHPAGE_LINK "codecade.co.za/recharge"
!define MUI_FINISHPAGE_LINK_LOCATION "${PRODUCT_WEBSITE}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ; Best-effort: don't fail the install if the app happens to be open, just close it.
  nsExec::Exec 'taskkill /IM "${MAIN_EXE}" /F'
  Pop $0
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File "${RELEASE_DIR}\${MAIN_EXE}"

  SetOutPath "$INSTDIR\content"
  File /nonfatal /r "${RELEASE_DIR}\content\*.*"

  SetOutPath "$INSTDIR\loader"
  File /nonfatal /r "${RELEASE_DIR}\loader\*.*"

  SetOutPath "$INSTDIR\mods"
  File /nonfatal /r "${RELEASE_DIR}\mods\*.*"

  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  DeleteRegKey HKCU "${UNINSTKEY}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAIN_EXE}$\""
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "${UNINSTKEY}" "URLInfoAbout" "${PRODUCT_WEBSITE}"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortcut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${MAIN_EXE}"
  CreateShortcut "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall ${PRODUCT_NAME}.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${MAIN_EXE}"
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM "${MAIN_EXE}" /F'
  Pop $0

  RMDir /r "$INSTDIR\content"
  RMDir /r "$INSTDIR\loader"
  RMDir /r "$INSTDIR\mods"
  Delete "$INSTDIR\${MAIN_EXE}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall ${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"

  DeleteRegKey HKCU "${UNINSTKEY}"
SectionEnd
