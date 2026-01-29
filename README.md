# vibefi cli

Bun + TypeScript CLI for interacting with VibeFi contracts.

## Setup

```bash
cd cli
bun install
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
bun run src/index.ts dapp:propose --root-cid 0x1234 --name "Test" --version "0.1.0" --description "Hello"

bun run src/index.ts vote:cast 1 --support for
bun run src/index.ts vote:status 1

bun run src/index.ts council:pause --dapp-id 1 --version-id 1 --reason "incident"

bun run src/index.ts dapp:list
```

Common options:

- `--network <name>` to select config network
- `--rpc <url>` to override RPC
- `--devnet <path>` to override devnet JSON
- `--pk <hex>` to override private key
- `--json` for machine readable output

## Smoke test

```bash
./scripts/smoke-test.sh
```
