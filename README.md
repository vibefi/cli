# vibefi cli

Bun + TypeScript CLI for interacting with VibeFi contracts.

## Setup

```bash
cd cli
bun install
```

If contracts change, refresh ABI snapshots:

```bash
cd contracts
FOUNDRY_PROFILE=ci forge build
cd ../cli
bun run refresh-abis
```

On first run, the CLI creates `.vibefi/config.json` in the current working directory.
Default config is devnet-first but includes mainnet placeholders.

## Local devnet

From `contracts/`:

```bash
./script/local-devnet.sh
```

This writes `contracts/.devnet/devnet.json` which the CLI reads by default.

## Usage

```bash
bun run src/index.ts status
bun run src/index.ts proposals:list
bun run src/index.ts proposals:show 1
bun run src/index.ts package --path ./my-dapp --name "My Dapp" --dapp-version "0.1.0" --description "Hello"
bun run src/index.ts dapp:propose --root-cid 0x1234 --name "Test" --dapp-version "0.1.0" --description "Hello"

bun run src/index.ts vote:cast 1 --support for
bun run src/index.ts vote:status 1
bun run src/index.ts proposals:queue 1
bun run src/index.ts proposals:execute 1

bun run src/index.ts council:pause --dapp-id 1 --version-id 1 --reason "incident"

bun run src/index.ts dapp:list
bun run src/index.ts dapp:fetch --root-cid <cid> --out .vibefi/cache
```

Common options:

- `--network <name>` to select config network
- `--rpc <url>` to override RPC
- `--devnet <path>` to override devnet JSON
- `--pk <hex>` to override private key
- `--json` for machine readable output

State-changing commands (propose/vote/queue/execute/council actions) print decoded logs by default.
With `--json`, the output includes `txHash` and a `logs` array.

## Smoke test

```bash
./scripts/smoke-test.sh
```

## E2E test

Runs a full devnet + CLI flow, sending a sanity transaction via viem and
streaming stdout to the console.

```bash
ANVIL_PORT=8546 bun run test:e2e
```

To run against a forked mainnet during the e2e flow, set `MAINNET_FORK_URL`
in a `.env` file at the repo root or `cli/.env`.

The e2e requires a local IPFS node running at `http://127.0.0.1:5001`
(gateway at `http://127.0.0.1:8080`). Start it from the repo root:

```bash
docker compose -f docker-compose.ipfs.yml up -d
```

## Package workflow

The `package` command validates a local dapp bundle and produces a deterministic
manifest + bundle directory. By default it publishes to a local IPFS node and
prints the folder CID for `dapp:propose`.

```bash
bun run src/index.ts package \
  --path ./my-dapp \
  --name "My Dapp" \
  --dapp-version "0.1.0" \
  --description "My first vapp"

# Skip IPFS publish and return a deterministic hash
bun run src/index.ts package \
  --path ./my-dapp \
  --name "My Dapp" \
  --dapp-version "0.1.0" \
  --description "My first vapp" \
  --no-ipfs
```
