#requires -Version 5.1
# Downloads whisper.cpp Windows binaries + ggml-base.en model into ./voice/whisper/.
# Run from project root: pwsh -File voice/setup-whisper.ps1

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$wDir = Join-Path $here "whisper"
$modelDir = Join-Path $wDir "models"

New-Item -ItemType Directory -Force -Path $wDir, $modelDir | Out-Null

# Pin a known-good release. v1.8.4 ships whisper-cli.exe + DLLs.
$zipUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-x64.zip"
$zipPath = Join-Path $here "whisper-bin-x64.zip"

$exeCandidates = @("whisper-cli.exe")
$existingExe = $null
foreach ($c in $exeCandidates) {
  $p = Join-Path $wDir $c
  if (Test-Path $p) { $existingExe = $p; break }
}

if (-not $existingExe) {
  Write-Host "Downloading whisper.cpp Windows build (~30MB)..."
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
  Write-Host "Extracting..."
  Expand-Archive -Path $zipPath -DestinationPath $wDir -Force
  Remove-Item $zipPath

  foreach ($c in $exeCandidates) {
    $p = Join-Path $wDir $c
    if (Test-Path $p) { $existingExe = $p; break }
  }
  if (-not $existingExe) {
    $maybe = Get-ChildItem -Path $wDir -Recurse -Include "whisper-cli.exe","main.exe" | Select-Object -First 1
    if ($maybe) {
      $src = Split-Path -Parent $maybe.FullName
      if ($src -ne $wDir) {
        Get-ChildItem $src | Move-Item -Destination $wDir -Force
      }
      $existingExe = Join-Path $wDir $maybe.Name
    } else {
      throw "whisper-cli.exe not found after extraction"
    }
  }
} else {
  Write-Host "whisper.cpp already installed."
}

$modelPath = Join-Path $modelDir "ggml-base.en.bin"
if (-not (Test-Path $modelPath)) {
  Write-Host "Downloading ggml-base.en.bin model (~150MB)..."
  $modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true"
  Invoke-WebRequest -Uri $modelUrl -OutFile $modelPath
} else {
  Write-Host "Model already present."
}

Write-Host ""
Write-Host "Done."
Write-Host "  exe   : $existingExe"
Write-Host "  model : $modelPath"
Write-Host ""
Write-Host "Add to .env:"
Write-Host "  BUDDY_WHISPER_EXE=$existingExe"
Write-Host "  BUDDY_WHISPER_MODEL=$modelPath"
Write-Host "Then restart the daemon."
