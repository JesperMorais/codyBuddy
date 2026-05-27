#!/usr/bin/env bash
# Coding Buddy one-shot installer (macOS / Linux) — Task 15.1.
#
# Verifies prerequisites (Node ≥20, pnpm, Python ≥3.11), bootstraps
# the workspace, creates voice/.venv, installs voice dependencies,
# downloads the pinned models listed in voice/models.json (skip with
# --skip-voice or BUDDY_SETUP_SKIP_MODELS=1), and copies
# .env.example → .env if missing.
#
# Idempotent — safe to re-run after partial failure or whenever
# you bump dependencies.
#
# Usage:
#   bash setup.sh
#
# Optional flags:
#   --skip-voice    skip voice/.venv + Python deps (chat-only path)
#   --skip-pnpm     skip `pnpm install`
#   --quiet         suppress info-level output

set -euo pipefail

SKIP_VOICE=0
SKIP_PNPM=0
QUIET=0

for arg in "$@"; do
    case "$arg" in
        --skip-voice) SKIP_VOICE=1 ;;
        --skip-pnpm)  SKIP_PNPM=1 ;;
        --quiet)      QUIET=1 ;;
        -h|--help)
            sed -n '2,19p' "$0"
            exit 0
            ;;
        *)
            echo "[setup] WARN: unknown arg '$arg' (ignored)" >&2
            ;;
    esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
VOICE_DIR="$HERE/voice"
ENV_EXAMPLE="$HERE/.env.example"
ENV_FILE="$HERE/.env"
MODELS_MANIFEST="$VOICE_DIR/models.json"

c_red=$'\033[31m'
c_yellow=$'\033[33m'
c_green=$'\033[32m'
c_reset=$'\033[0m'

info()  { [ "$QUIET" = "1" ] || echo "[setup] $*"; }
warn()  { echo "${c_yellow}[setup] WARN: $*${c_reset}"; }
err()   { echo "${c_red}[setup] ERROR: $*${c_reset}" >&2; }
done_msg() { echo "${c_green}$*${c_reset}"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Friendly install hints — saves users a Google trip.
hint() {
    case "$1" in
        node)   echo "Install Node 20+ from https://nodejs.org/ or via your package manager (apt/dnf/brew)." ;;
        pnpm)   echo "Install pnpm: corepack enable && corepack prepare pnpm@latest --activate" ;;
        python) echo "Install Python 3.11+ via your OS package manager (e.g. brew install python@3.11, sudo apt-get install python3.11)." ;;
    esac
}

# ---- Prereq detection -------------------------------------------

info "Coding Buddy setup starting in $HERE"
missing=()

# Node ≥20
node_major=""
if have node; then
    raw="$(node --version 2>/dev/null || true)"
    node_major="$(echo "$raw" | sed -E 's/^v([0-9]+)\..*/\1/')"
fi
if [ -z "$node_major" ]; then
    err "Node.js not found on PATH."
    info "  $(hint node)"
    missing+=("node")
elif [ "$node_major" -lt 20 ]; then
    err "Node.js $node_major.x is too old; need 20+."
    info "  $(hint node)"
    missing+=("node")
else
    info "node: v$node_major.x ✓"
fi

# pnpm
if ! have pnpm; then
    err "pnpm not found on PATH."
    info "  $(hint pnpm)"
    missing+=("pnpm")
else
    info "pnpm: ✓"
fi

# Python ≥3.11 (skip when --skip-voice)
py_cmd=""
if [ "$SKIP_VOICE" = "0" ]; then
    for cand in python3.13 python3.12 python3.11 python3 python; do
        if have "$cand"; then
            v="$($cand --version 2>&1 || true)"
            major="$(echo "$v" | sed -nE 's/^Python ([0-9]+)\.([0-9]+).*/\1/p')"
            minor="$(echo "$v" | sed -nE 's/^Python ([0-9]+)\.([0-9]+).*/\2/p')"
            if [ -n "$major" ] && [ -n "$minor" ]; then
                if [ "$major" -gt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -ge 11 ]; }; then
                    py_cmd="$cand"
                    info "python: $cand ($major.$minor) ✓"
                    break
                fi
            fi
        fi
    done
    if [ -z "$py_cmd" ]; then
        err "Python 3.11+ not found on PATH."
        info "  $(hint python)"
        missing+=("python")
    fi
else
    info "voice setup skipped (--skip-voice)"
fi

if [ "${#missing[@]}" -gt 0 ]; then
    err "Missing prerequisites: ${missing[*]}. Install them and re-run."
    exit 1
fi

# ---- Workspace install ------------------------------------------

if [ "$SKIP_PNPM" = "0" ]; then
    info "Running pnpm install…"
    pnpm install
else
    info "pnpm install skipped (--skip-pnpm)"
fi

# ---- Voice venv + Python deps -----------------------------------

if [ "$SKIP_VOICE" = "0" ]; then
    venv_dir="$VOICE_DIR/.venv"
    venv_py="$venv_dir/bin/python"
    if [ ! -x "$venv_py" ]; then
        info "Creating voice/.venv…"
        "$py_cmd" -m venv "$venv_dir"
    else
        info "voice/.venv exists ✓"
    fi
    info "Installing voice base dependencies (fastapi/uvicorn/...)"
    "$venv_py" -m pip install --upgrade pip --quiet
    "$venv_py" -m pip install -e "$VOICE_DIR" --quiet
    info "voice base deps installed ✓"
    info "Optional extras (run later if you want voice loops):"
    info "  bash voice/setup-piper.sh   — Piper TTS"
    info "  bash voice/setup-whisper.sh — Whisper STT (builds whisper.cpp from source; needs git+cmake)"
    info "  bash voice/setup-xtts.sh    — XTTS-v2 (~2GB)"
fi

# ---- Pinned-model download -------------------------------------

if [ -f "$MODELS_MANIFEST" ]; then
    if [ "$SKIP_VOICE" = "1" ]; then
        info "Skipping pinned-model download (--skip-voice)."
    elif [ "${BUDDY_SETUP_SKIP_MODELS:-}" = "1" ]; then
        # Escape hatch for CI / dev environments that don't want to pay
        # the multi-GB upstream download (Hugging Face / GitHub releases)
        # or that run on networks where the pinned URLs aren't reachable
        # without auth. The verifier already skips TBD-pinned entries
        # cleanly, so the chat-only path stays functional without the
        # downloads. Until 16.3.2 lands real hashes + a CI smoke
        # download, the full voice job sets this to keep the matrix
        # green without depending on upstream availability.
        info "Skipping pinned-model download (BUDDY_SETUP_SKIP_MODELS=1)."
    else
        info "Downloading pinned models per $MODELS_MANIFEST"
        # Task 16.3.1: hand off to the Node downloader. It streams each
        # entry to disk, verifies size_bytes, and verifies sha256 — entries
        # whose hash is still TBD-pinned are downloaded and size-checked
        # but the hash check is skipped. Idempotent: cached files with
        # matching hash are reported and skipped.
        if ! node "$HERE/daemon/scripts/fetch-models.mjs" "$MODELS_MANIFEST" "$HERE"; then
            err "Pinned-model download failed (see lines above). Re-run setup.sh once the network is available, set BUDDY_SETUP_SKIP_MODELS=1 to opt out, or pass --skip-voice for a chat-only install."
            exit 1
        fi
    fi
else
    info "voice/models.json not present — skipping model download."
fi

# ---- .env bootstrap --------------------------------------------

if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$ENV_EXAMPLE" ]; then
        cp "$ENV_EXAMPLE" "$ENV_FILE"
        info "Copied .env.example → .env"
    else
        warn ".env.example missing — you'll need to create .env manually."
    fi
else
    info ".env already exists ✓"
fi

# ---- Final message --------------------------------------------

echo
done_msg "Setup complete. Add ANTHROPIC_API_KEY to .env and run pnpm dev."
