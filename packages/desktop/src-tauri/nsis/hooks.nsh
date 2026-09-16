; PocketRocket installer hooks (bundle.windows.nsis.installerHooks).
;
; The local hub runs on the node.exe installed next to PocketRocket.exe. Builds before 0.3 did not put it in a
; kill-on-close job, so a crashed or force-killed app could leave that node.exe running; Windows then refuses
; to overwrite or delete $INSTDIR\node.exe and the upgrade or uninstall fails half way.
;
; Before installing or uninstalling: first ask to close PocketRocket (the same prompt Tauri shows right after
; this hook), then stop node.exe processes whose executable is exactly $INSTDIR\node.exe. Never by image name:
; the person's own Node processes, and a PocketRocket installed somewhere else, are left alone.

!macro POCKETROCKET_STOP_BUNDLED_NODE
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ; Hand the path over in the environment rather than splicing it into the command line, so a quote or
  ; dollar sign in the install folder can't change the PowerShell code.
  System::Call 'Kernel32::SetEnvironmentVariable(t "POCKETROCKET_NODE_EXE", t "$INSTDIR\node.exe") i .r0'
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$p = $$env:POCKETROCKET_NODE_EXE; if ($$p) { Get-CimInstance Win32_Process -Filter 'Name = ''node.exe''' | Where-Object { $$_.ExecutablePath -and ($$_.ExecutablePath -ieq $$p) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }"`
  Pop $0
  Sleep 300
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro POCKETROCKET_STOP_BUNDLED_NODE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro POCKETROCKET_STOP_BUNDLED_NODE
!macroend
