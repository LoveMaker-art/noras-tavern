!macro customUnInit
  ; electron-builder calls the old uninstaller during upgrades. Never prompt or
  ; touch runtime/data on that path, including silent upgrades.
  ${IfNot} ${isUpdated}
    Call un.checkAppRunning
    InitPluginsDir
    Delete "$PLUGINSDIR\nora-uninstall.json"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--nora-uninstall-plan=$PLUGINSDIR\nora-uninstall.json"' $0
    ${If} $0 != 0
      Abort
    ${EndIf}
    IfFileExists "$PLUGINSDIR\nora-uninstall.json" +2 0
      Abort
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    SetDetailsView show
    DetailPrint "正在清理诺拉与酒馆文件"
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
    nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\app.asar\uninstall.js" "$PLUGINSDIR\nora-uninstall.json"'
    Pop $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")'
    ${If} $0 != 0
      CopyFiles /SILENT "$PLUGINSDIR\result.json" "$TEMP\nora-uninstall-result.json"
      MessageBox MB_OK|MB_ICONSTOP "清理未完成，应用尚未移除。请重试卸载。错误详情：$TEMP\nora-uninstall-result.json"
      Abort
    ${EndIf}
    DetailPrint "文件清理完成，正在移除启动器和快捷方式"
  ${EndIf}
!macroend
