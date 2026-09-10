param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = "Stop"
$Candidates = @(
    (Join-Path $PSScriptRoot "诺拉·酒馆.exe"),
    (Join-Path $PSScriptRoot "desktop\dist\win-unpacked\诺拉·酒馆.exe")
)
foreach ($App in $Candidates) {
    if (Test-Path -LiteralPath $App) {
        if ($Rest.Count) { Start-Process -FilePath $App -ArgumentList $Rest }
        else { Start-Process -FilePath $App }
        exit 0
    }
}
throw "此目录没有桌面启动器。请从项目 Releases 下载 Windows 启动器安装包或便携包。"
