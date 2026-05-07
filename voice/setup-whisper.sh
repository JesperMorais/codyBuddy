#!/usr/bin/env bash
# Builds whisper.cpp from source on Linux/macOS and downloads the
# ggml-base.en model into ./voice/whisper/.
# Run from project root: bash voice/setup-whisper.sh
# Or from voice/:        bash setup-whisper.sh
#
# whisper.cpp does not ship prebuilt binaries for Linux/macOS — only
# Windows zips and an iOS xcframework — so we clone the v1.7.6 source
# and build with cmake. Requires git, cmake, and a C/C++ toolchain
# (gcc/clang+make) on PATH.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
w_dir="$here/whisper"
src_dir="$w_dir/src"
model_dir="$w_dir/models"
whisper_tag="v1.7.6"

mkdir -p "$w_dir" "$model_dir"

case "$(uname -s)" in
    Linux|Darwin) ;;
    *) echo "ERROR: this script supports Linux and macOS only (uname -s='$(uname -s)')." >&2
       echo "       On Windows, run voice/setup-whisper.ps1 instead." >&2
       exit 1 ;;
esac

need() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "ERROR: '$1' not found on PATH. Install it and re-run." >&2
        echo "       (whisper.cpp ships no Linux/macOS prebuilts; we have to build.)" >&2
        exit 1
    fi
}

need git
need cmake

# Locate the built binary regardless of which CMake layout this whisper.cpp
# release happens to use.
find_built_exe() {
    local p
    for p in "$src_dir/build/bin/whisper-cli" "$src_dir/build/bin/main" \
             "$src_dir/build/whisper-cli" "$src_dir/build/main"; do
        [ -x "$p" ] && { echo "$p"; return 0; }
    done
    return 1
}

existing_exe=""
for cand in "$w_dir/whisper-cli" "$w_dir/main"; do
    if [ -x "$cand" ]; then existing_exe="$cand"; break; fi
done

if [ -z "$existing_exe" ]; then
    if [ ! -d "$src_dir/.git" ]; then
        echo "Cloning whisper.cpp $whisper_tag…"
        git clone --depth 1 --branch "$whisper_tag" \
            https://github.com/ggml-org/whisper.cpp.git "$src_dir"
    else
        echo "whisper.cpp source already cloned, pulling tag $whisper_tag…"
        git -C "$src_dir" fetch --depth 1 origin "refs/tags/$whisper_tag:refs/tags/$whisper_tag" || true
        git -C "$src_dir" checkout "$whisper_tag"
    fi

    echo "Configuring + building whisper.cpp (this can take a few minutes)…"
    cmake -S "$src_dir" -B "$src_dir/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
    cmake --build "$src_dir/build" --config Release -j

    built="$(find_built_exe || true)"
    if [ -z "$built" ]; then
        echo "ERROR: whisper-cli/main binary not found under $src_dir/build/" >&2
        exit 1
    fi
    cp "$built" "$w_dir/whisper-cli"
    existing_exe="$w_dir/whisper-cli"
else
    echo "whisper.cpp already built at $existing_exe."
fi

model_path="$model_dir/ggml-base.en.bin"
if [ ! -f "$model_path" ]; then
    echo "Downloading ggml-base.en.bin model (~150MB)…"
    model_url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true"
    if command -v curl >/dev/null 2>&1; then
        curl -fL --retry 3 -o "$model_path" "$model_url"
    elif command -v wget >/dev/null 2>&1; then
        wget -O "$model_path" "$model_url"
    else
        echo "ERROR: need curl or wget to download the model." >&2
        exit 1
    fi
else
    echo "Model already present."
fi

cat <<EOF

Done.
  exe   : $existing_exe
  model : $model_path

Add to .env:
  BUDDY_WHISPER_EXE=$existing_exe
  BUDDY_WHISPER_MODEL=$model_path
Then restart the daemon.
EOF
