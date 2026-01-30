#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
CLI_DIR="$ROOT_DIR/cli"
DEVNET_JSON="$CONTRACTS_DIR/.devnet/devnet.json"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found on PATH. Install bun to run this smoke test."
  exit 1
fi

if ! command -v cast >/dev/null 2>&1; then
  echo "cast not found on PATH. Install foundry to run this smoke test."
  exit 1
fi

# Start devnet in background
(
  cd "$CONTRACTS_DIR"
  ./script/local-devnet.sh
) &
DEVNET_PID=$!

cleanup() {
  kill "$DEVNET_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Wait for devnet JSON
for _ in {1..80}; do
  if [ -f "$DEVNET_JSON" ]; then
    break
  fi
  sleep 0.25
done

if [ ! -f "$DEVNET_JSON" ]; then
  echo "Devnet JSON not found at $DEVNET_JSON"
  exit 1
fi

# Ensure RPC is ready
for _ in {1..80}; do
  if cast chain-id --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

# Ensure RPC is ready
for _ in {1..80}; do
  if cast chain-id --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

cd "$CLI_DIR"

bun install >/dev/null 2>&1 || bun install

run_cli() {
  bun run src/index.ts "$@"
}

run_cli status --json >/dev/null
run_cli proposals:list --json >/dev/null

run_cli dapp:propose \
  --root-cid "hello-world" \
  --name "Hello Dapp" \
  --version "0.1.0" \
  --description "Test proposal" \
  --proposal-description "Smoke test proposal" \
  --json >/dev/null

# Mine a block to move proposal out of Pending
cast rpc anvil_mine 1 --rpc-url http://127.0.0.1:8545 >/dev/null

# Get latest proposal id
PROPOSAL_ID=$(run_cli proposals:list --json | bun -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(0,'utf8'));console.log(d[d.length-1].proposalId);")

run_cli proposals:show "$PROPOSAL_ID" --json >/dev/null
run_cli vote:cast "$PROPOSAL_ID" --support for --json >/dev/null
run_cli vote:status "$PROPOSAL_ID" --json >/dev/null
run_cli dapp:list --json >/dev/null

echo "CLI smoke test completed successfully."
