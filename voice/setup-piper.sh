#!/usr/bin/env bash
# Downloads Piper TTS for Linux/macOS + an English voice into ./voice/piper/.
# Run from project root: bash voice/setup-piper.sh
# Or from voice/:        bash setup-piper.sh

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
piper_dir="$here/piper"
voices_dir="$here/voices"

mkdir -p "$piper_dir" "$voices_dir"

# Map host OS+arch to the right Piper release artifact.
# Pinned to 2023.11.14-2 to match setup-piper.ps1 — this is also the
# latest rhasspy/piper release on GitHub (upstream has been dormant
# since Nov 2023). Bump in lockstep with the .ps1 if a newer release
# ships.
piper_release="2023.11.14-2"
uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s" in
    Linux)
        case "$uname_m" in
            x86_64)  piper_asset="piper_linux_x86_64.tar.gz" ;;
            aarch64|arm64) piper_asset="piper_linux_aarch64.tar.gz" ;;
            armv7l)  piper_asset="piper_linux_armv7l.tar.gz" ;;
            *) echo "ERROR: unsupported Linux arch '$uname_m'." >&2; exit 1 ;;
        esac
        ;;
    Darwin)
        case "$uname_m" in
            x86_64)  piper_asset="piper_macos_x64.tar.gz" ;;
            arm64|aarch64) piper_asset="piper_macos_aarch64.tar.gz" ;;
            *) echo "ERROR: unsupported macOS arch '$uname_m'." >&2; exit 1 ;;
        esac
        ;;
    *)
        echo "ERROR: this script supports Linux and macOS only (uname -s='$uname_s')." >&2
        echo "       On Windows, run voice/setup-piper.ps1 instead." >&2
        exit 1
        ;;
esac

# Pick a downloader.
download() {
    local url="$1" dest="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fL --retry 3 -o "$dest" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -O "$dest" "$url"
    else
        echo "ERROR: need curl or wget to download files." >&2
        exit 1
    fi
}

piper_url="https://github.com/rhasspy/piper/releases/download/$piper_release/$piper_asset"
piper_archive="$here/$piper_asset"

if [ ! -x "$piper_dir/piper" ]; then
    echo "Downloading $piper_asset (~10MB)..."
    download "$piper_url" "$piper_archive"

    echo "Extracting..."
    # Piper Linux/macOS releases extract to a top-level 'piper/' directory.
    tar -xzf "$piper_archive" -C "$here"
    rm -f "$piper_archive"

    if [ ! -x "$piper_dir/piper" ]; then
        echo "ERROR: piper binary not found after extraction at $piper_dir/piper" >&2
        exit 1
    fi
else
    echo "piper already installed, skipping download."
fi

voice_model="$voices_dir/en_US-amy-medium.onnx"
voice_config="$voices_dir/en_US-amy-medium.onnx.json"
voice_model_url="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx?download=true"
voice_config_url="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json?download=true"

if [ ! -f "$voice_model" ]; then
    echo "Downloading voice model en_US-amy-medium (~63MB)..."
    download "$voice_model_url" "$voice_model"
fi
if [ ! -f "$voice_config" ]; then
    echo "Downloading voice config..."
    download "$voice_config_url" "$voice_config"
fi

cat <<EOF

Done.
  piper : $piper_dir/piper
  voice : $voice_model

Now set in your .env:
  BUDDY_TTS_BACKEND=piper
  BUDDY_PIPER_EXE=$piper_dir/piper
  BUDDY_PIPER_VOICE=$voice_model
Then restart the daemon.
EOF
