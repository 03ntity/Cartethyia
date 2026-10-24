#!/usr/bin/env bash
# One-command Cartethyia bootstrap. Install policy lives in scripts/install/.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ORIGINAL_ARGS=("$@")
ROOT="${CARTETHYIA_ROOT:-}"
TARGET="local"
for arg in "$@"; do
  case "$arg" in
    --vps) TARGET="vps" ;;
    --docker) TARGET="docker" ;;
    --local) TARGET="local" ;;
  esac
done
while [ $# -gt 0 ]; do
  if [ "$1" = "--root" ]; then
    [ $# -ge 2 ] || { echo "--root requires a path" >&2; exit 2; }
    ROOT="$2"
    shift 2
  else
    shift
  fi
done
set -- "${ORIGINAL_ARGS[@]}"

if [ -f "$SCRIPT_DIR/../package.json" ] && [ -f "$SCRIPT_DIR/install/install.ts" ]; then
  ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
else
  if [ "$TARGET" = "docker" ]; then
    echo "Docker requires a full checkout. Clone Cartethyia, then run bash scripts/install.sh --docker --lite|--full." >&2
    exit 1
  fi
  if [ -z "$ROOT" ]; then
    if [ "$TARGET" = "vps" ]; then ROOT="/opt/cartethyia"
    elif [ "$(uname -s)" = "Darwin" ]; then ROOT="$HOME/Library/Application Support/Cartethyia/app"
    else ROOT="$HOME/.local/share/Cartethyia/app"
    fi
  fi
  case "$ROOT" in
    /*) ;;
    *) ROOT="$(pwd)/$ROOT" ;;
  esac
  for tool in git curl python3; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      if [ "$(uname -s)" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
        if [ "$(id -u)" = "0" ]; then SUDO=""
        elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"
        else echo "Bootstrap requires $tool and root or non-interactive sudo to install it" >&2; exit 1
        fi
        $SUDO apt-get update
        $SUDO apt-get install -y git curl unzip ca-certificates python3
        break
      elif [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
        brew install git curl python3
        break
      else
        echo "Bootstrap requires $tool. Install it or use a supported apt/Homebrew host." >&2
        exit 1
      fi
    fi
  done
  if [ -e "$ROOT" ] && [ ! -d "$ROOT/.git" ]; then
    if [ -n "$(ls -A "$ROOT" 2>/dev/null)" ]; then
      echo "Installation root is not an empty git checkout: $ROOT" >&2
      exit 1
    fi
  fi
  mkdir -p "$ROOT"
  if [ ! -d "$ROOT/.git" ]; then
    git clone --depth 1 --branch "${CARTETHYIA_BRANCH:-dev}" "${CARTETHYIA_REPO_URL:-https://github.com/risunCode/Cartethyia.git}" "$ROOT"
  fi
fi

REQUIRED=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["engines"]["bun"].lstrip(">= "))' "$ROOT/package.json")
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
python3 - "$REQUIRED" "$(bun --version)" <<'PY'
import sys
need = [int(x) for x in sys.argv[1].split('.')]
actual = [int(x) for x in sys.argv[2].split('.')]
length = max(len(need), len(actual))
need += [0] * (length-len(need)); actual += [0] * (length-len(actual))
if actual < need:
    raise SystemExit(f"Bun {sys.argv[1]}+ is required; found {sys.argv[2]}")
PY
if [ "$TARGET" = "vps" ]; then
  BUN_PATH=$(command -v bun)
  if [ "$BUN_PATH" != "/usr/local/bin/bun" ]; then
    if [ "$(id -u)" = "0" ]; then SUDO=""
    elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"
    else echo "VPS install requires root or non-interactive sudo" >&2; exit 1
    fi
    $SUDO install -m 0755 "$BUN_PATH" /usr/local/bin/bun
    export PATH="/usr/local/bin:$PATH"
  fi
fi
exec bun run "$ROOT/scripts/install/install.ts" "$@"
