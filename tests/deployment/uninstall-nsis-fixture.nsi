; Compile-only harness for the real hooks. Does not install the product.
Unicode true
!include LogicLib.nsh
!define APP_EXECUTABLE_FILENAME "NoraFixture.exe"
!define isUpdated '0 = 1'
!include "../installer/desktop/uninstall.nsh"
Name "Nora uninstall syntax fixture"
OutFile "${TEST_OUTPUT}"
RequestExecutionLevel user
Function un.checkAppRunning
FunctionEnd
Function un.onInit
  !insertmacro customUnInit
FunctionEnd
Section
  WriteUninstaller "$TEMP\nora-uninstall-fixture.exe"
SectionEnd
Section "Uninstall"
  !insertmacro customUnInstall
SectionEnd
