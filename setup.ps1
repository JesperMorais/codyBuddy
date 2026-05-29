#requires -Version 5.1
# Coding Buddy one-shot installer (Windows) -- Task 15.1.
#
# Verifies prerequisites (Node >=20, pnpm, Python >=3.11), bootstraps
# the workspace, creates voice/.venv, installs voice dependencies,
# downloads the pinned models listed in voice/models.json (skip with
# -SkipVoice or BUDDY_SETUP_SKIP_MODELS=1), and copies
# .env.example -> .env if missing.
#
# Idempotent -- safe to re-run after partial failure or whenever
# you bump dependencies.
#
# Usage:
#   pwsh -File setup.ps1
#   # ...or, after setting execution policy:
#   .\setup.ps1
#
# Optional flags:
#   -SkipVoice    : skip voice/.venv + Python deps (chat-only path)
#   -SkipPnpm     : skip `pnpm install` (you've already run it)
#   -Quiet        : suppress info-level output (errors still printed)

[CmdletBinding()]
param(
    [switch]$SkipVoice,
    [switch]$SkipPnpm,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$voiceDir = Join-Path $here "voice"
$envExample = Join-Path $here ".env.example"
$envFile = Join-Path $here ".env"
$modelsManifest = Join-Path $voiceDir "models.json"

function Write-Info($msg) {
    if (-not $Quiet) { Write-Host "[setup] $msg" }
}

function Write-Warn($msg) {
    Write-Host "[setup] WARN: $msg" -ForegroundColor Yellow
}

function Write-Err($msg) {
    Write-Host "[setup] ERROR: $msg" -ForegroundColor Red
}

# ---- Prereq detection -------------------------------------------

function Test-Command($name) {
    return [bool] (Get-Command $name -ErrorAction SilentlyContinue)
}

function Get-NodeMajor {
    if (-not (Test-Command node)) { return $null }
    $v = & node --version 2>$null
    if (-not $v) { return $null }
    if ($v -match '^v?(\d+)') { return [int]$matches[1] }
    return $null
}

function Get-PythonMajorMinor {
    foreach ($cmd in @("python", "python3", "py")) {
        if (Test-Command $cmd) {
            $v = & $cmd --version 2>$null
            if ($v -match 'Python\s+(\d+)\.(\d+)') {
                return @{ Cmd = $cmd; Major = [int]$matches[1]; Minor = [int]$matches[2] }
            }
        }
    }
    return $null
}

function Test-Pnpm {
    return (Test-Command pnpm)
}

# Surfaces friendly install hints rather than dumping the
# user back at a cryptic "command not found".
function Get-InstallHint($tool) {
    switch ($tool) {
        "node" { return "Install Node 20+ from https://nodejs.org/ or via winget: winget install OpenJS.NodeJS.LTS" }
        "pnpm" { return "Install pnpm: corepack enable; corepack prepare pnpm@latest --activate" }
        "python" { return "Install Python 3.11+ from https://www.python.org/downloads/ or via winget: winget install Python.Python.3.11" }
    }
    return ""
}

Write-Info "Coding Buddy setup starting in $here"

$missing = @()
$nodeMajor = Get-NodeMajor
if (-not $nodeMajor) {
    Write-Err "Node.js not found on PATH."
    Write-Info "  $((Get-InstallHint 'node'))"
    $missing += "node"
} elseif ($nodeMajor -lt 20) {
    Write-Err "Node.js $nodeMajor.x is too old; need 20+."
    Write-Info "  $((Get-InstallHint 'node'))"
    $missing += "node"
} else {
    Write-Info "node: v$nodeMajor.x [ok]"
}

if (-not (Test-Pnpm)) {
    Write-Err "pnpm not found on PATH."
    Write-Info "  $((Get-InstallHint 'pnpm'))"
    $missing += "pnpm"
} else {
    Write-Info "pnpm: [ok]"
}

if (-not $SkipVoice) {
    $py = Get-PythonMajorMinor
    if (-not $py) {
        Write-Err "Python not found on PATH."
        Write-Info "  $((Get-InstallHint 'python'))"
        $missing += "python"
    } elseif ($py.Major -lt 3 -or ($py.Major -eq 3 -and $py.Minor -lt 11)) {
        Write-Err "Python $($py.Major).$($py.Minor) is too old; need 3.11+."
        Write-Info "  $((Get-InstallHint 'python'))"
        $missing += "python"
    } else {
        Write-Info "python: $($py.Cmd) ($($py.Major).$($py.Minor)) [ok]"
    }
} else {
    Write-Info "voice setup skipped (-SkipVoice)"
}

if ($missing.Count -gt 0) {
    Write-Err "Missing prerequisites: $($missing -join ', '). Install them and re-run."
    exit 1
}

# ---- Workspace install ------------------------------------------

if (-not $SkipPnpm) {
    Write-Info "Running pnpm install..."
    & pnpm install
    if ($LASTEXITCODE -ne 0) {
        Write-Err "pnpm install failed (exit $LASTEXITCODE)"
        exit $LASTEXITCODE
    }
} else {
    Write-Info "pnpm install skipped (-SkipPnpm)"
}

# ---- Voice venv + Python deps -----------------------------------

if (-not $SkipVoice) {
    $venvDir = Join-Path $voiceDir ".venv"
    $venvPy = Join-Path $venvDir "Scripts/python.exe"
    if (-not (Test-Path $venvPy)) {
        Write-Info "Creating voice/.venv..."
        & $py.Cmd -m venv $venvDir
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Failed to create voice/.venv (exit $LASTEXITCODE)"
            exit $LASTEXITCODE
        }
    } else {
        Write-Info "voice/.venv exists [ok]"
    }

    Write-Info "Installing voice base dependencies (fastapi/uvicorn/...)"
    & $venvPy -m pip install --upgrade pip --quiet
    & $venvPy -m pip install -e $voiceDir --quiet
    if ($LASTEXITCODE -ne 0) {
        Write-Err "pip install -e voice/ failed (exit $LASTEXITCODE)"
        exit $LASTEXITCODE
    }
    Write-Info "voice base deps installed [ok]"
    Write-Info "Optional extras (run later if you want voice loops):"
    Write-Info "  voice/setup-piper.ps1   -- Piper TTS"
    Write-Info "  voice/setup-whisper.ps1 -- Whisper STT"
    Write-Info "  voice/setup-xtts.ps1    -- XTTS-v2 (~2GB)"
}

# ---- Pinned-model download -------------------------------------

if (Test-Path $modelsManifest) {
    if ($SkipVoice) {
        Write-Info "Skipping pinned-model download (-SkipVoice)."
    } elseif ($env:BUDDY_SETUP_SKIP_MODELS -eq "1") {
        # Escape hatch for CI / dev environments that don't want to pay
        # the multi-GB upstream download (Hugging Face / GitHub releases)
        # or that run on networks where the pinned URLs aren't reachable
        # without auth. Mirror of the bash side (--skip-models).
        Write-Info "Skipping pinned-model download (BUDDY_SETUP_SKIP_MODELS=1)."
    } else {
        Write-Info "Downloading pinned models per $modelsManifest"
        # Task 16.3.1: hand off to the Node downloader. It streams each
        # entry to disk, verifies size_bytes, and verifies sha256 -- entries
        # whose hash is still TBD-pinned are downloaded and size-checked
        # but the hash check is skipped. Idempotent: cached files with
        # matching hash are reported and skipped.
        & node "$here/daemon/scripts/fetch-models.mjs" $modelsManifest $here
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Pinned-model download failed (see lines above). Re-run setup.ps1 once the network is available, set BUDDY_SETUP_SKIP_MODELS=1 to opt out, or pass -SkipVoice for a chat-only install."
            exit $LASTEXITCODE
        }
    }
} else {
    Write-Info "voice/models.json not present -- skipping model download."
}

# ---- .env bootstrap --------------------------------------------

if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        Write-Info "Copied .env.example -> .env"
    } else {
        Write-Warn ".env.example missing -- you'll need to create .env manually."
    }
} else {
    Write-Info ".env already exists [ok]"
}

# ---- Final message --------------------------------------------

Write-Host ""
Write-Host "Setup complete. Add ANTHROPIC_API_KEY to .env and run pnpm dev." -ForegroundColor Green
exit 0
