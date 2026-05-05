#requires -Version 5.1
# Downloads Piper TTS for Windows + an English voice into ./voice/piper/
# Run from project root: pwsh -File voice/setup-piper.ps1
# Or from voice/: pwsh -File setup-piper.ps1

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$piperDir = Join-Path $here "piper"
$voicesDir = Join-Path $here "voices"

New-Item -ItemType Directory -Force -Path $piperDir, $voicesDir | Out-Null

$piperZipUrl = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip"
$piperZip = Join-Path $here "piper_windows_amd64.zip"

if (-not (Test-Path (Join-Path $piperDir "piper.exe"))) {
    Write-Host "Downloading piper.exe (~10MB)..."
    Invoke-WebRequest -Uri $piperZipUrl -OutFile $piperZip
    Write-Host "Extracting..."
    Expand-Archive -Path $piperZip -DestinationPath $here -Force
    Remove-Item $piperZip
    if (-not (Test-Path (Join-Path $piperDir "piper.exe"))) {
        # Some piper releases extract to a 'piper' subdir, others flat. Detect.
        $maybe = Get-ChildItem -Path $here -Recurse -Filter "piper.exe" | Select-Object -First 1
        if ($maybe) {
            $src = Split-Path -Parent $maybe.FullName
            if ($src -ne $piperDir) {
                Get-ChildItem $src | Move-Item -Destination $piperDir -Force
            }
        } else {
            throw "piper.exe not found after extraction"
        }
    }
} else {
    Write-Host "piper.exe already installed, skipping download."
}

$voiceModel = Join-Path $voicesDir "en_US-amy-medium.onnx"
$voiceConfig = Join-Path $voicesDir "en_US-amy-medium.onnx.json"
$voiceModelUrl = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx?download=true"
$voiceConfigUrl = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json?download=true"

if (-not (Test-Path $voiceModel)) {
    Write-Host "Downloading voice model en_US-amy-medium (~63MB)..."
    Invoke-WebRequest -Uri $voiceModelUrl -OutFile $voiceModel
}
if (-not (Test-Path $voiceConfig)) {
    Write-Host "Downloading voice config..."
    Invoke-WebRequest -Uri $voiceConfigUrl -OutFile $voiceConfig
}

Write-Host ""
Write-Host "Done."
Write-Host "  piper.exe : $piperDir\piper.exe"
Write-Host "  voice     : $voiceModel"
Write-Host ""
Write-Host "Now set in your .env:"
Write-Host "  BUDDY_TTS_BACKEND=piper"
Write-Host "  BUDDY_PIPER_EXE=$piperDir\piper.exe"
Write-Host "  BUDDY_PIPER_VOICE=$voiceModel"
Write-Host "Then restart the daemon."
