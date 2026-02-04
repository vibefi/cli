#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
CLI_DIR="$ROOT_DIR/cli"
DEVNET_JSON="$CONTRACTS_DIR/.devnet/devnet.json"
ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC_URL="http://127.0.0.1:${ANVIL_PORT}"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found on PATH. Install bun to run this smoke test."
  exit 1
fi

if ! command -v cast >/dev/null 2>&1; then
  echo "cast not found on PATH. Install foundry to run this smoke test."
  exit 1
fi

# Remove stale devnet JSON so the wait loop below actually waits for
# the fresh deploy rather than exiting on a leftover file.
rm -f "$DEVNET_JSON"

# Start devnet in background
(
  cd "$CONTRACTS_DIR"
  ANVIL_PORT="$ANVIL_PORT" ./script/local-devnet.sh
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
  if cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

# Wait for governor contract to actually be deployed on-chain.
# forge script writes devnet.json during simulation (before broadcast),
# so the file can exist before contracts are live.
GOVERNOR=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$DEVNET_JSON','utf8')).vfiGovernor)")
for _ in {1..80}; do
  CODE=$(cast code "$GOVERNOR" --rpc-url "$RPC_URL" 2>/dev/null || true)
  if [ -n "$CODE" ] && [ "$CODE" != "0x" ]; then
    break
  fi
  sleep 0.25
done

cd "$CLI_DIR"

bun install >/dev/null 2>&1 || bun install

run_cli() {
  bun run src/index.ts "$@"
}

run_cli status --rpc "$RPC_URL" --devnet "$DEVNET_JSON" --json >/dev/null
run_cli proposals:list --rpc "$RPC_URL" --devnet "$DEVNET_JSON" --json >/dev/null

run_cli dapp:propose \
  --rpc "$RPC_URL" \
  --devnet "$DEVNET_JSON" \
  --root-cid "hello-world" \
  --name "Hello Dapp" \
  --dapp-version "0.1.0" \
  --description "Test proposal" \
  --proposal-description "Smoke test proposal" \
  --json >/dev/null

# Mine a block to move proposal out of Pending
cast rpc anvil_mine 1 --rpc-url "$RPC_URL" >/dev/null

# Get latest proposal id
PROPOSAL_ID=$(run_cli proposals:list --rpc "$RPC_URL" --devnet "$DEVNET_JSON" --json | bun -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(0,'utf8'));console.log(d[d.length-1].proposalId);")

run_cli proposals:show "$PROPOSAL_ID" --rpc "$RPC_URL" --devnet "$DEVNET_JSON" --json >/dev/null
run_cli vote:cast "$PROPOSAL_ID" --support for --rpc "$RPC_URL" --devnet "$DEVNET_JSON" --json >/dev/null
run_cli vote:status "$PROPOSAL_ID" --rpc "$RPC_URL" --devnet "$DEVNET_JSON" --json >/dev/null
run_cli dapp:list --rpc "$RPC_URL" --devnet "$DEVNET_JSON" --json >/dev/null

echo "CLI smoke test completed successfully."
