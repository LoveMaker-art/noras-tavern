param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = "Stop"

Write-Host "[nora-tavern-install] 开始首次安装。"

function Get-InstallerArg {
    param([string]$Name)
    for ($i = 0; $i -lt $Rest.Count; $i++) {
        if ($Rest[$i] -eq $Name -and ($i + 1) -lt $Rest.Count) {
            return $Rest[$i + 1]
        }
        if ($Rest[$i].StartsWith("$Name=")) {
            return $Rest[$i].Substring($Name.Length + 1)
        }
    }
    return ""
}

function Invoke-Python {
    param([string]$Script)
    if ($env:TAVERN_PYTHON) {
        & $env:TAVERN_PYTHON -u -B $Script @Rest
        exit $LASTEXITCODE
    }
    $Candidates = @()
    if ($env:HERMES_HOME) {
        $Candidates += (Join-Path $env:HERMES_HOME "hermes-agent\venv\Scripts\python.exe")
    }
    if ($env:LOCALAPPDATA) {
        $Candidates += (Join-Path $env:LOCALAPPDATA "hermes\hermes-agent\venv\Scripts\python.exe")
    }
    $Candidates += (Join-Path $HOME ".hermes\hermes-agent\venv\Scripts\python.exe")
    foreach ($Candidate in $Candidates) {
        if ($Candidate -and (Test-Path $Candidate)) {
            & $Candidate -B -c "import sys; assert sys.version_info >= (3, 9)"
            & $Candidate -u -B $Script @Rest
            exit $LASTEXITCODE
        }
    }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        python -B -c "import sys; assert sys.version_info >= (3, 9)"
        python -u -B $Script @Rest
        exit $LASTEXITCODE
    }
    if (Get-Command py -ErrorAction SilentlyContinue) {
        py -3 -B -c "import sys; assert sys.version_info >= (3, 9)"
        py -3 -u -B $Script @Rest
        exit $LASTEXITCODE
    }
    throw "未找到 Python 3.9+。请先确认 Hermes 安装完成，并重新打开 PowerShell。"
}

$Base = "https://github.com/LoveMaker-art/noras-tavern/releases/latest/download"
$Tag = Get-InstallerArg "--tag"
if ($Tag) {
    $Base = "https://github.com/LoveMaker-art/noras-tavern/releases/download/$Tag"
}

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("nora-tavern-install." + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Work | Out-Null

try {
    $ManifestPath = Join-Path $Work "first-install-manifest.json"
    $BootstrapPath = Join-Path $Work "nora-tavern-first-install-bootstrap.py"
    Invoke-WebRequest -Uri "$Base/first-install-manifest.json" -OutFile $ManifestPath
    Invoke-WebRequest -Uri "$Base/nora-tavern-first-install-bootstrap.py" -OutFile $BootstrapPath

    $Manifest = Get-Content -Raw -Path $ManifestPath | ConvertFrom-Json
    $Actual = (Get-FileHash -Algorithm SHA256 -Path $BootstrapPath).Hash.ToLowerInvariant()
    if ($Manifest.scope -ne "nora-tavern-first-install-bootstrap" -or $Actual -ne $Manifest.sha256) {
        throw "First installer bootstrap checksum mismatch"
    }

    Invoke-Python $BootstrapPath
}
finally {
    Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
