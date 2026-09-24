; A tiny, version-independent installer: it carries no Recharge files, only a
; script that downloads and runs the newest release. Rebuild it only if that
; script changes - never per Recharge release.
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

Name "Recharge"
OutFile "RechargeSetup.exe"
RequestExecutionLevel user
AutoCloseWindow true
ShowInstDetails show

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "install.ps1"
  DetailPrint "Downloading and installing the latest Recharge..."
  nsExec::ExecToLog '"powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\install.ps1"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Couldn't install Recharge (exit code $0).$\nCheck your internet connection and try again."
    Abort
  ${EndIf}
SectionEnd
