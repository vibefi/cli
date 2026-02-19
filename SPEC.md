# VibeFi CLI Specification

This document describes CLI design and behavior (data flow, config, and contract interactions). Usage examples are in `cli/README.md`.

## Goals

- Provide a developer-focused CLI to propose, vote, and manage dapps against VibeFi contracts.
- Default to mainnet configuration, while supporting local/devnet environments.
- Make local iteration frictionless with a devnet JSON file and deterministic accounts.

## Non-Goals (initial scope)

- Rich indexing or caching layer beyond on-demand log reads.
- Chain control commands (mining/time travel). Use external tools instead.

## Configuration

### Config file

- Path: `.vibefi/config.json` relative to the current working directory.
- On first run, if the file does not exist, it is created from `cli/config.defaults.json`.
- Defaults include:
  - `defaultNetwork: "devnet"` (local-only for now).
  - `networks.mainnet` with placeholders.
  - `networks.devnet` pointing at `contracts/.devnet/devnet.json`.

### Network resolution

- The CLI loads config, selects `defaultNetwork` unless `--network` is passed.
- `--rpc` or `VIBEFI_RPC_URL` overrides the network RPC.
- For `devnet`, if `devnetJson` exists, contract addresses + keys are sourced from it.

### Identity

- `--pk` or `VIBEFI_PRIVATE_KEY` selects signer.
- If a devnet JSON is present and no key is provided, the CLI defaults to the devnet developer key.
- Role hints are inferred when a signer address matches any devnet roles (developer/voter/council).

## Commands

### Status

- `vibefi status`
- Displays network, RPC, chainId, contract addresses, and signer + role hint.

### Proposals

- `vibefi proposals:list`
  - Reads `ProposalCreated` logs from `VfiGovernor` and queries `state()` per proposal.
- `vibefi proposals:show <id>`
  - Finds the proposal log, reads `proposalSnapshot` and `proposalDeadline`, prints targets + calldata.
- `vibefi proposals:queue <id>`
  - Finds the proposal log and calls `VfiGovernor.queue` using the original targets/values/calldatas +
    `keccak256(description)`.
  - Warns (non-blocking) if the proposal state is not `Succeeded`.
- `vibefi proposals:execute <id>`
  - Finds the proposal log and calls `VfiGovernor.execute` using the original targets/values/calldatas +
    `keccak256(description)`.
  - Warns (non-blocking) if the proposal state is not `Queued`.

### Propose Dapp

- `vibefi dapp:propose`
  - Builds calldata for `DappRegistry.publishDapp(rootCid, name, version, description)`.
  - Submits it to `VfiGovernor.propose` with a description string.
  - `rootCid` accepts either a hex string (`0x...`) or a raw string (hex-encoded by the CLI).
  - Use `--dapp-version` (not `--version`) to avoid conflicting with CLI version flag.
  - Prints decoded logs from the proposal transaction.

### Upgrade Dapp

- `vibefi dapp:upgrade`
  - Builds calldata for `DappRegistry.upgradeDapp(dappId, rootCid, name, version, description)`.
  - Submits it to `VfiGovernor.propose` with a description string.
  - `rootCid` accepts either a hex string (`0x...`) or a raw string (hex-encoded by the CLI).
  - Requires `--dapp-id` for the existing dapp.
  - Use `--dapp-version` (not `--version`) to avoid conflicting with CLI version flag.
  - Prints decoded logs from the proposal transaction.

### Voting

- `vibefi vote:cast <proposalId> --support for|against|abstain [--reason text]`
  - Sends `castVote` or `castVoteWithReason` to `VfiGovernor`.
  - Prints decoded logs from the vote transaction.
- `vibefi vote:status <proposalId>`
  - Reads `proposalVotes` and `quorum` at the snapshot block.

### Security Council

- `vibefi council:pause|unpause|deprecate --dapp-id --version-id --reason`
  - Calls corresponding methods on `DappRegistry`.
- `vibefi council:veto <proposalId>`
  - Calls `VfiGovernor.vetoProposal` using the original proposal’s target/values/calldata + description hash.
  - Prints decoded logs from the transaction.

### Dapp List

- `vibefi dapp:list`
  - Reads `DappRegistry` logs:
    - `DappPublished`, `DappUpgraded`, `DappMetadata`, `DappPaused`, `DappUnpaused`, `DappDeprecated`.
  - Combines logs in block/logIndex order to compute the latest version per `dappId`.
  - Outputs: `dappId`, latest `versionId`, `name`, `version`, `description`, `status`, `rootCid`.

### Dapp Fetch

- `vibefi dapp:fetch --root-cid <cid>`
  - Downloads `manifest.json` and bundle files from an IPFS gateway.
  - Computes the bundle CID locally via `ipfs add --only-hash` and verifies it matches.
  - Output includes `outDir` and verification status.

### Package Dapp

- `vibefi package`
  - Use `--dapp-version` (not `--version`) to avoid conflicting with CLI version flag.
  - Validates a local dapp bundle and outputs a deterministic `rootCid`.
  - Publishes the bundle to IPFS by default (uses `http://127.0.0.1:5001`).
  - `--no-ipfs` skips publish and returns a deterministic hash of the manifest.
  - `--ipfs-api` overrides the IPFS API URL.
  - Supports two layouts:
    - constrained: `src/`, `assets/`, `abis/`, `vibefi.json`, `index.html`, `package.json`.
    - static-html: `vibefi.json`, `index.html`, plus approved static file types only.
  - Constrained layout enforces dependency allowlist + exact versions.
  - Constrained layout rejects forbidden patterns (HTTP, fetch/XHR/WebSocket, dynamic HTTP imports).
  - Static-html layout bundles non-dotfiles recursively (excluding build/cache dirs like `node_modules`, `dist`, `.vibefi`) and rejects disallowed extensions.
  - Reads source properties from `vibefi.json` (`addresses`, optional `capabilities`).
  - Generates a post-bundle `manifest.json` with file hashes and metadata.
  - Emits a bundle directory that can be proposed via `dapp:propose`.

## Contract Interactions

- `VfiGovernor` functions: `propose`, `queue`, `execute`, `state`, `proposalSnapshot`, `proposalDeadline`,
  `proposalVotes`, `quorum`, `castVote`, `castVoteWithReason`, `vetoProposal`.
- `DappRegistry` functions: `publishDapp`, `upgradeDapp`, `pauseDappVersion`, `unpauseDappVersion`,
  `deprecateDappVersion`.

## ABI Management

- ABI files used by CLI are stored in `packages/shared/src/abis/`.
- Use `bun run refresh-abis` from `cli/` to regenerate those JSONs from `contracts/out`
  (requires `forge build` in `contracts/`).

## Linting & Reproducibility

- `bun run lint` uses `tsc --noEmit` for now.
- `bun.lockb` is committed for reproducible installs.

## Output Format

- Human-readable by default.
- `--json` emits JSON objects/arrays for easy scripting.
- For write actions (`dapp:propose`, `vote:cast`, `council:*`), JSON output includes
  `txHash` and a `logs` array with decoded events (unknown logs are preserved).

## Error Handling

- Missing RPC or contract addresses result in a clear error.
- Missing private key for write actions results in a clear error.
- Proposal/council commands fail fast if contracts are not configured.

## Local Devnet Integration

- `contracts/script/local-devnet.sh` starts Anvil, deploys contracts, and writes `contracts/.devnet/devnet.json`.
- The CLI reads devnet JSON to resolve addresses and known roles for local testing.

## Smoke Test

- `cli/scripts/smoke-test.ts` (run via `bun run test:smoke`):
  - Starts local devnet in background.
  - Submits a `publishDapp` proposal.
  - Mines 1 block and casts a vote.
  - Verifies proposals and dapp list commands.
