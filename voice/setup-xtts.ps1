#requires -Version 5.1
# Installs the XTTS-v2 sidecar's Python dependencies (Task 12.3).
# Run from project root: pwsh -File voice/setup-xtts.ps1
# Or from voice/:        pwsh -File setup-xtts.ps1
#
# This installs the `xtts` optional extra defined in pyproject.toml,
# which pulls in coqui-TTS + torch + numpy. The XTTS-v2 model
# checkpoint itself (~1.5GB) is downloaded on first /synth request,
# not by this script.
#
# GPU note: torch ships with CPU-only wheels by default; if you have
# an NVIDIA GPU, install the matching CUDA build of torch FIRST,
# then re-run this script. CPU fallback works but synth is ~3×
# slower than real-time, which is too slow for live voice.

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvDir = Join-Path $here ".venv"

Write-Host "Setting up XTTS-v2 sidecar dependencies in $here..."

# Pick a python: prefer the venv if present, otherwise system python.
function Find-Python {
    if (Test-Path (Join-Path $venvDir "Scripts/python.exe")) {
        return Join-Path $venvDir "Scripts/python.exe"
    }
    foreach ($cmd in @("python", "python3", "py")) {
        $resolved = Get-Command $cmd -ErrorAction SilentlyContinue
        if ($resolved) { return $resolved.Source }
    }
    throw "No python found on PATH. Install Python 3.11+ first."
}

$python = Find-Python
Write-Host "Using python: $python"

# Install the [xtts] optional dependency group.
& $python -m pip install --upgrade pip
& $python -m pip install -e "$here[xtts]"

Write-Host ""
Write-Host "Done."
Write-Host ""
Write-Host "Run the sidecar with:"
Write-Host "  cd voice"
Write-Host "  uvicorn xtts:app --port 31417"
Write-Host ""
Write-Host "Health check (separate terminal):"
Write-Host "  curl http://127.0.0.1:31417/health"
Write-Host ""
Write-Host "First /synth call will download the XTTS-v2 checkpoint (~1.5GB)."
