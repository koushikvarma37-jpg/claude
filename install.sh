#!/usr/bin/env sh
# Motes installer for macOS and Linux.
#   From a clone:   sh install.sh
#   From the web:   curl -fsSL https://raw.githubusercontent.com/koushikvarma37-jpg/claude/main/install.sh | sh
# Installs Motes into ~/.motes/venv, puts `motes` on your PATH, then runs `motes setup`.
set -e

REPO="${MOTES_REPO:-https://github.com/koushikvarma37-jpg/claude}"
VENV="$HOME/.motes/venv"
BIN="$HOME/.local/bin"

say() { printf '\033[1m%s\033[0m\n' "$1"; }

PY=""
for p in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
    PY="$p"; break
  fi
done
if [ -z "$PY" ]; then
  echo "Motes needs Python 3.10 or newer. Install it from https://www.python.org/downloads/ and run this again."
  exit 1
fi

say "Installing Motes with $($PY --version)..."
mkdir -p "$HOME/.motes" "$BIN"
"$PY" -m venv "$VENV"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/pyproject.toml" ] && grep -q 'name = "motes"' "$HERE/pyproject.toml"; then
  "$VENV/bin/pip" install --quiet "$HERE"
else
  "$VENV/bin/pip" install --quiet "git+$REPO"
fi
ln -sf "$VENV/bin/motes" "$BIN/motes"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say "Add this line to your shell profile so 'motes' is found:"; echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

if ! command -v ollama >/dev/null 2>&1; then
  say "Motes runs on Ollama, which isn't installed yet."
  case "$(uname -s)" in
    Darwin) echo "  Download it from https://ollama.com/download (or: brew install ollama)" ;;
    *)      echo "  Install it with:  curl -fsSL https://ollama.com/install.sh | sh" ;;
  esac
  echo "Then run:  motes setup && motes up"
  exit 0
fi

"$VENV/bin/motes" setup || true
say "Done. Start Motes with:  motes up"
