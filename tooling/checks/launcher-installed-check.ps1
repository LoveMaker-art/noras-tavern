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
function Get-CimBirthTicks([DateTime]$Value) {
  $birthTicks=$Value.ToUniversalTime().Ticks
  return ($birthTicks-($birthTicks%10))
}
function Get-HeldInstallerIdentity($Process, [string]$Executable) {
  $Process.Handle | Out-Null
  $rawBirth=$Process.StartTime.ToUniversalTime()
  return [pscustomobject]@{process=$Process;pid=$Process.Id;birth=$rawBirth;birthCimTicks=(Get-CimBirthTicks $rawBirth);path=[IO.Path]::GetFullPath($Executable);sha256=(Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant();stopError=$null}
}
function Add-HeldInstallerDescendants($Known, $Unknown) {
  $all = @(Get-CimInstance Win32_Process)
  foreach ($parent in $Known.ToArray()) {
    $parent.process.Refresh()
    $parentClosed=$parent.process.HasExited
    $actualParent=@($all | Where-Object {$_.ProcessId -eq $parent.pid -and (Get-CimBirthTicks $_.CreationDate) -eq $parent.birthCimTicks})
    if (-not $parentClosed -and $actualParent.Count -ne 1) { continue }
    foreach ($candidate in $all) {
      if ($candidate.ParentProcessId -ne $parent.pid -or (Get-CimBirthTicks $candidate.CreationDate) -lt $parent.birthCimTicks) { continue }
      if ($parentClosed -and (Get-CimBirthTicks $candidate.CreationDate) -gt (Get-CimBirthTicks $parent.process.ExitTime)) { continue }
      if (@($Known.ToArray() | Where-Object { $_.pid -eq $candidate.ProcessId -and $_.birthCimTicks -eq (Get-CimBirthTicks $candidate.CreationDate) }).Count) { continue }
      try {
        if (-not $candidate.ExecutablePath) { throw 'Descendant executable identity unavailable' }
        $held = Get-Process -Id $candidate.ProcessId -ErrorAction Stop
        $entry = Get-HeldInstallerIdentity $held $candidate.ExecutablePath
        if ($entry.birthCimTicks -ne (Get-CimBirthTicks $candidate.CreationDate)) { throw 'Descendant birth changed before capture' }
        $Known.Add($entry)
      } catch { $Unknown.Add([pscustomobject]@{pid=$candidate.ProcessId;birth=$candidate.CreationDate.ToUniversalTime().ToString('o');birthCimTicks=(Get-CimBirthTicks $candidate.CreationDate);reason=$_.Exception.Message}) }
    }
  }
}
function Stop-HeldInstallerIdentity($Entry) {
  $Entry.process.Refresh()
  if ($Entry.process.HasExited) { return }
  try {
    $actual = @(Get-CimInstance Win32_Process -Filter ('ProcessId='+$Entry.pid))
    if ($actual.Count -ne 1 -or (Get-CimBirthTicks $actual[0].CreationDate) -ne $Entry.birthCimTicks -or
      -not $actual[0].ExecutablePath -or [IO.Path]::GetFullPath($actual[0].ExecutablePath) -ine $Entry.path -or
      (Get-FileHash -LiteralPath $Entry.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Entry.sha256) { throw 'Held installer identity changed; preserve unknown process' }
    Stop-Process -InputObject $Entry.process -Force -ErrorAction Stop
  } catch { $Entry.stopError=$_.Exception.Message }
}
function Get-HeldInstallerCloseProof($Known, $Unknown) {
  $rows = @($Known.ToArray() | ForEach-Object {
    $_.process.Refresh();$closed=$_.process.HasExited
    [ordered]@{pid=$_.pid;birth=$_.birth.ToString('o');birthCimTicks=$_.birthCimTicks;birthResolution='CIM1-microsecond';path=$_.path;sha256=$_.sha256;closed=$closed;exitCode=$(if($closed){$_.process.ExitCode}else{$null});stopError=$_.stopError}
  })
  $censusError=$null;$current=@();$queriedAt=$null
  if ($Unknown.Count) {
    try { $current=@(Get-CimInstance Win32_Process -ErrorAction Stop);$queriedAt=[DateTime]::UtcNow.ToString('o') }
    catch { $censusError=$_.Exception.Message }
  }
  $uncertain=@($Unknown.ToArray() | ForEach-Object {
    $original=$_;$originalBirth=$null;$birthError=$null;$closed=$false;$currentBirth=$null;$resolution=$null
    try {
      if ($null -ne $original.birthCimTicks) { $originalBirth=[long]$original.birthCimTicks }
      elseif ($original.birth) { $originalBirth=Get-CimBirthTicks ([DateTime]::ParseExact($original.birth,'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)) }
      if ($null -eq $originalBirth -or $originalBirth -le 0) { throw 'Original descendant birth unavailable' }
      if ($censusError) { throw $censusError }
      $matches=@($current | Where-Object {$_.ProcessId -eq $original.pid})
      if ($matches.Count -eq 0) { $closed=$true;$resolution='Fresh CIM query: original PID absent' }
      elseif ($matches.Count -eq 1 -and $matches[0].CreationDate) {
        $currentBirth=Get-CimBirthTicks $matches[0].CreationDate
        if ($currentBirth -ne $originalBirth) { $closed=$true;$resolution='Fresh CIM query: original birth absent; replacement PID untouched' }
        else { $resolution='Fresh CIM query: same birth remains present' }
      } else { throw 'Current descendant birth unavailable or ambiguous' }
    } catch { $birthError=$_.Exception.Message }
    [ordered]@{pid=$original.pid;birth=$original.birth;birthCimTicks=$originalBirth;reason=$original.reason;closed=$closed;closureEvidence=$resolution;queryAt=$queriedAt;currentBirthCimTicks=$currentBirth;queryError=$birthError;noProcessStopped=$true}
  })
  return [ordered]@{schema='nora-installed-setup-lifecycle/1';captured=$rows;uncertainDescendants=$uncertain;allCapturedClosed=(@($rows | Where-Object {-not $_.closed}).Count -eq 0 -and @($uncertain | Where-Object {-not $_.closed}).Count -eq 0);observationLimit='Held installer and sampled causal descendants only; original unknown evidence is preserved; fresh census proves absence only of the recorded birth';rootPreserved=$true}
}
$installer = Start-Process -FilePath $setup[0].FullName -ArgumentList "/S /currentuser /D=$installRoot" -PassThru
$heldInstaller = New-Object 'Collections.Generic.List[object]'
$unknownInstaller = New-Object 'Collections.Generic.List[object]'
$heldInstaller.Add((Get-HeldInstallerIdentity $installer $setup[0].FullName))
$setupDeadline = [DateTime]::UtcNow.AddMilliseconds(240000)
$timedOut = $false
while (-not $installer.WaitForExit(100)) {
  Add-HeldInstallerDescendants $heldInstaller $unknownInstaller
  if ([DateTime]::UtcNow -ge $setupDeadline) { $timedOut=$true;break }
}
Add-HeldInstallerDescendants $heldInstaller $unknownInstaller
if ($timedOut) {
  foreach ($entry in @($heldInstaller.ToArray() | Sort-Object birth -Descending)) { Stop-HeldInstallerIdentity $entry }
}
$closeDeadline = [DateTime]::UtcNow.AddMilliseconds(10000)
do {
  $lifecycle = Get-HeldInstallerCloseProof $heldInstaller $unknownInstaller
  if ($lifecycle.allCapturedClosed -or [DateTime]::UtcNow -ge $closeDeadline) { break }
  Start-Sleep -Milliseconds 100
} while ($true)
$lifecycle.timedOut=$timedOut
$lifecycle | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $env:RUNNER_TEMP 'nora-installed-setup-lifecycle.json') -Encoding utf8
if ($timedOut) { throw 'Actual Windows setup timed out; held closure evidence recorded and root preserved' }
if (-not $lifecycle.allCapturedClosed) { throw 'Installer descendant closure remains unconfirmed; preserve the installed root' }
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
# The shared Node runner selects and verifies the moved cold or restored Python
# runtime before checking the installed application's fresh receipt evidence.
node tooling/checks/launcher-artifact-checks.cjs app --installed $installRoot
if ($LASTEXITCODE -ne 0) { throw 'The actual installed application gate failed' }
