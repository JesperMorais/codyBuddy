#!/usr/bin/env bash
# Installs the XTTS-v2 sidecar's Python dependencies (Task 12.3).
# Run from project root: bash voice/setup-xtts.sh
# Or from voice/:        bash setup-xtts.sh
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

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
venv_dir="$here/.venv"

echo "Setting up XTTS-v2 sidecar dependencies in $here..."

# Prefer the voice venv if setup.sh has created it; otherwise fall back
# to the system python (matches the .ps1 logic).
find_python() {
    if [ -x "$venv_dir/bin/python" ]; then
        echo "$venv_dir/bin/python"
        return
    fi
    for cand in python3.13 python3.12 python3.11 python3 python; do
        if command -v "$cand" >/dev/null 2>&1; then
            echo "$cand"
            return
        fi
    done
    echo "ERROR: No python found on PATH. Install Python 3.11+ first." >&2
    exit 1
}

python="$(find_python)"
echo "Using python: $python"

"$python" -m pip install --upgrade pip
"$python" -m pip install -e "$here[xtts]"

cat <<EOF

Done.

Run the sidecar with:
  cd voice
  uvicorn xtts:app --port 31417

Health check (separate terminal):
  curl http://127.0.0.1:31417/health

First /synth call will download the XTTS-v2 checkpoint (~1.5GB).
EOF
