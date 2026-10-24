#!/usr/bin/env bash
# Generated local Cartethyia CLI; keeps package/config roots tied to this install.
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

export CARTETHYIA_CONFIG_DIR="$ROOT"
export CARTETHYIA_PACKAGE_ROOT="$ROOT"
export CARTETHYIA_GATEWAY_BINARY="$ROOT/dist/cartethyia"
cd "$ROOT"
if [ ! -f .env ]; then
  echo "Cartethyia configuration is missing: $ROOT/.env" >&2
  exit 1
fi
ENV_FILE="$ROOT/.env" exec bun -e 'const env=await Bun.file(process.env.ENV_FILE).text(); for(const line of env.split(/\r?\n/)){if(!line||line.startsWith("#"))continue; const i=line.indexOf("="); if(i>0)process.env[line.slice(0,i).trim()]=line.slice(i+1).trim();} process.argv=["bun","scripts/cli/main.ts",...Bun.argv.slice(1)]; Bun.argv=process.argv; await import("./scripts/cli/main.ts");' "$@"
