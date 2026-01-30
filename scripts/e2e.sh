#!/usr/bin/env bash
set -euo pipefail

ANVIL_PORT="${ANVIL_PORT:-8546}"

bun run scripts/e2e.ts
