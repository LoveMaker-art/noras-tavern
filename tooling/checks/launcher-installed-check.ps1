$ErrorActionPreference = 'Stop'
$releaseRoot = node tooling/checks/launcher-artifact-checks.cjs release
if ($LASTEXITCODE -ne 0) { throw 'Expected exactly one release payload' }
$launcher = Join-Path $releaseRoot 'nora-tavern-launcher'
$desktop = Join-Path $launcher 'desktop'
$dist = Join-Path $desktop 'dist'
$setup = @(Get-ChildItem $dist -File -Filter '*-win-x64-setup.exe')
if ($setup.Count -ne 1) { throw 'Expected exactly one actual Windows setup' }
$package = Get-Content (Join-Path $desktop 'package.json') -Raw | ConvertFrom-Json
if ($package.build.nsis.oneClick -ne $false -or $package.build.nsis.script) {
  throw 'This gate requires the packaged assisted NSIS template'
}
$template = Get-Content (Join-Path $desktop 'node_modules/app-builder-lib/templates/nsis/installSection.nsh') -Raw
if ($template -notmatch '\$\{if\}\s+\$\{isForceRun\}\s+\$\{andIf\}\s+\$\{Silent\}') {
  throw 'The pinned NSIS template no longer proves silent installation requires force-run to launch'
}
$include = Get-Content (Join-Path $desktop $package.build.nsis.include) -Raw
if ($include -match '!macro\s+customInstall\b') { throw 'A custom installation hook requires separate launch acceptance' }
foreach ($registry in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
  $existing = @(Get-ChildItem $registry -ErrorAction SilentlyContinue |
    Get-ItemProperty -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq $package.build.productName })
  if ($existing.Count) { throw 'This fresh setup gate must not invoke an existing installation uninstaller' }
}
$installRoot = Join-Path (Join-Path $env:RUNNER_TEMP 'Nora 用户安装验收') 'app'
if ($installRoot.Length -ge 248 -or (Test-Path $installRoot)) { throw 'Expected a fresh short isolated setup directory' }
$setupReport = Join-Path $env:RUNNER_TEMP 'nora-installed-setup-acceptance.json'
if (Test-Path $setupReport) { throw 'Refusing a stale setup acceptance report' }
# NSIS /D must be last and unquoted even with spaces. /S without force-run
# does not launch the app in the pinned assisted installer template.
$installer = Start-Process -FilePath $setup[0].FullName -ArgumentList "/S /currentuser /D=$installRoot" -PassThru
if (-not $installer.WaitForExit(240000)) {
  taskkill /PID $installer.Id /T /F
  throw 'Actual Windows setup timed out'
}
if ($installer.ExitCode -ne 0) { throw "Actual Windows setup exited $($installer.ExitCode)" }
$unpacked = Join-Path $dist 'win-unpacked'
$main = @(Get-ChildItem $unpacked -File -Filter '*.exe')
if ($main.Count -ne 1) { throw 'Expected one original unpacked main executable' }
$executable = Join-Path $installRoot $main[0].Name
if (-not (Test-Path $executable -PathType Leaf)) { throw 'Setup did not install the main executable at the requested directory' }
$checked = 0
foreach ($file in (Get-ChildItem $unpacked -Recurse -File -Force)) {
  $relative = [System.IO.Path]::GetRelativePath($unpacked, $file.FullName)
  $installed = Join-Path $installRoot $relative
  if (-not (Test-Path $installed -PathType Leaf)) { throw "Setup omitted $relative" }
  if ((Get-FileHash $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash $installed -Algorithm SHA256).Hash) {
    throw "Setup changed packaged bytes: $relative"
  }
  $checked++
}
if (@(Get-Process | Where-Object { $_.Path -eq $executable }).Count) { throw 'Silent setup unexpectedly launched the installed application' }
$setupProof = @{schema='nora-installed-setup/1'; installer=$setup[0].Name; installerSha256=(Get-FileHash $setup[0].FullName -Algorithm SHA256).Hash.ToLower(); exitCode=$installer.ExitCode; installRoot=$installRoot; verifiedUnpackedFiles=$checked; autoLaunch=$false}
$setupProof | ConvertTo-Json -Depth 5 | Set-Content $setupReport -Encoding utf8
# The shared Node runner owns executable selection, child completion and fresh evidence.
$env:NORA_APP_CHECK_PYTHON = Join-Path $env:RUNNER_TEMP 'hermes-build-source/python/python.exe'
node tooling/checks/launcher-artifact-checks.cjs app --installed $installRoot
if ($LASTEXITCODE -ne 0) { throw 'The actual installed application gate failed' }
