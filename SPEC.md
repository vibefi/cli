# VibeFi CLI Specification

This document describes CLI design and behavior (data flow, config, and contract interactions). Usage examples are in `cli/README.md`.

## Goals

- Provide a developer-focused CLI to propose, vote, and manage dapps against VibeFi contracts.
- Default to mainnet configuration, while supporting local/devnet environments.
- Make local iteration frictionless with a devnet JSON file and deterministic accounts.

## Non-Goals (initial scope)

- IPFS packaging/publishing of dapp bundles.
- Full governance lifecycle automation (queue/execute).
- Rich indexing or caching layer beyond on-demand log reads.

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

### Propose Dapp

- `vibefi dapp:propose`
  - Builds calldata for `DappRegistry.publishDapp(rootCid, name, version, description)`.
  - Submits it to `VfiGovernor.propose` with a description string.
  - `rootCid` accepts either a hex string (`0x...`) or a raw string (hex-encoded by the CLI).

### Voting

- `vibefi vote:cast <proposalId> --support for|against|abstain [--reason text]`
  - Sends `castVote` or `castVoteWithReason` to `VfiGovernor`.
- `vibefi vote:status <proposalId>`
  - Reads `proposalVotes` and `quorum` at the snapshot block.

### Security Council

- `vibefi council:pause|unpause|deprecate --dapp-id --version-id --reason`
  - Calls corresponding methods on `DappRegistry`.
- `vibefi council:veto <proposalId>`
  - Calls `VfiGovernor.vetoProposal` using the original proposal’s target/values/calldata + description hash.

### Dapp List

- `vibefi dapp:list`
  - Reads `DappRegistry` logs:
    - `DappPublished`, `DappUpgraded`, `DappMetadata`, `DappPaused`, `DappUnpaused`, `DappDeprecated`.
  - Combines logs in block/logIndex order to compute the latest version per `dappId`.
  - Outputs: `dappId`, latest `versionId`, `name`, `version`, `description`, `status`, `rootCid`.

## Contract Interactions

- `VfiGovernor` functions: `propose`, `state`, `proposalSnapshot`, `proposalDeadline`, `proposalVotes`, `quorum`, `castVote`, `castVoteWithReason`, `vetoProposal`.
- `DappRegistry` functions: `publishDapp`, `pauseDappVersion`, `unpauseDappVersion`, `deprecateDappVersion`.

## ABI Management

- ABI files are stored in `cli/src/abis/` and generated from the latest `contracts/out` artifacts.
- Use `bun run refresh-abis` to regenerate ABI JSONs (requires `forge build` in `contracts/`).

## Linting & Reproducibility

- `bun run lint` uses `tsc --noEmit` for now.
- `bun.lockb` is committed for reproducible installs.

## Linting & Reproducibility

- `bun run lint` uses `tsc --noEmit` for now.
- `bun.lockb` is committed for reproducible installs.

## Output Format

- Human-readable by default.
- `--json` emits JSON objects/arrays for easy scripting.

## Error Handling

- Missing RPC or contract addresses result in a clear error.
- Missing private key for write actions results in a clear error.
- Proposal/council commands fail fast if contracts are not configured.

## Local Devnet Integration

- `contracts/script/local-devnet.sh` starts Anvil, deploys contracts, and writes `contracts/.devnet/devnet.json`.
- The CLI reads devnet JSON to resolve addresses and known roles for local testing.

## Smoke Test

- `cli/scripts/smoke-test.sh`:
  - Starts local devnet in background.
  - Submits a `publishDapp` proposal.
  - Mines 1 block and casts a vote.
  - Verifies proposals and dapp list commands.
