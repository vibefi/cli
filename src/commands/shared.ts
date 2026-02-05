import { Command } from "commander";
import {
  bytesToHex,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isHex,
  keccak256,
  toBytes,
  type Hex
} from "viem";
import {
  dappDeprecatedEvent,
  dappMetadataEvent,
  dappPausedEvent,
  dappPublishedEvent,
  dappRegistryAbi,
  dappUnpausedEvent,
  dappUpgradedEvent,
  governorAbi,
  proposalCreatedEvent,
  vfiTokenAbi
} from "../abi";
import {
  ensureConfig,
  getConfigPath,
  loadDevnetJson,
  resolveChainId,
  resolveContracts,
  resolveDevnetJson,
  resolveFromBlock,
  resolveNetwork,
  resolveRpcUrl
} from "../config";
import { getPublicClient, getWalletClient, resolvePrivateKey } from "../clients";

export function withCommonOptions(cmd: Command) {
  return cmd
    .option("-n, --network <name>", "Network name from .vibefi/config.json")
    .option("--rpc <url>", "RPC URL override")
    .option("--devnet <path>", "Path to devnet.json override")
    .option("--pk <hex>", "Private key override (0x...)")
    .option("--json", "Output JSON");
}

export function loadContext(options: {
  network?: string;
  rpc?: string;
  devnet?: string;
  pk?: string;
}) {
  const config = ensureConfig();
  const network = resolveNetwork(config, options.network);
  const devnetPath = options.devnet ?? resolveDevnetJson(network.config);
  const devnet = loadDevnetJson(devnetPath);
  const rpcUrl = resolveRpcUrl(network.config, options.rpc);

  if (!rpcUrl) {
    throw new Error(
      `RPC URL missing. Set VIBEFI_RPC_URL, pass --rpc, or update ${getConfigPath()}`
    );
  }

  const chainId = resolveChainId(network.config, devnet);
  const contracts = resolveContracts(network.config, devnet);
  const publicClient = getPublicClient(rpcUrl, chainId);

  return {
    config,
    networkName: network.name,
    rpcUrl,
    chainId,
    devnetPath,
    devnet,
    contracts,
    publicClient
  };
}

export function getWalletContext(
  base: ReturnType<typeof loadContext>,
  options: { pk?: string }
) {
  const privateKey = resolvePrivateKey({}, base.devnet, options.pk);
  if (!privateKey) {
    throw new Error("Private key required. Pass --pk or set VIBEFI_PRIVATE_KEY.");
  }
  const walletClient = getWalletClient(base.rpcUrl, base.chainId, privateKey as Hex);
  return { ...base, walletClient, privateKey };
}

function normalizeAddress(address: string): string {
  try {
    return getAddress(address);
  } catch {
    return address.toLowerCase();
  }
}

export function roleHint(address: string | undefined, devnet: ReturnType<typeof loadDevnetJson>) {
  if (!address || !devnet) return undefined;
  const lower = address.toLowerCase();
  if (lower === normalizeAddress(devnet.developer).toLowerCase()) return "developer";
  if (lower === normalizeAddress(devnet.voter1).toLowerCase()) return "voter1";
  if (lower === normalizeAddress(devnet.voter2).toLowerCase()) return "voter2";
  if (lower === normalizeAddress(devnet.securityCouncil1).toLowerCase()) return "securityCouncil1";
  if (devnet.securityCouncil2 && lower === normalizeAddress(devnet.securityCouncil2).toLowerCase()) {
    return "securityCouncil2";
  }
  return undefined;
}

export function toJson(value: unknown) {
  return JSON.stringify(
    value,
    (_key, val) => (typeof val === "bigint" ? val.toString() : val),
    2
  );
}

export type DecodedLog =
  | { address: string; contract: string; event: string; args: unknown }
  | { address: string; event: "Unknown"; data: Hex; topics: Hex[] };

export async function fetchTxLogs(
  ctx: ReturnType<typeof loadContext>,
  txHash: Hex
) {
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  const logs = receipt.logs ?? [];
  const decodedLogs: DecodedLog[] = logs.map((log) => {
    const address = log.address.toLowerCase();
    const matchGovernor = ctx.contracts.vfiGovernor && address === ctx.contracts.vfiGovernor.toLowerCase();
    const matchRegistry = ctx.contracts.dappRegistry && address === ctx.contracts.dappRegistry.toLowerCase();
    const matchToken = ctx.contracts.vfiToken && address === ctx.contracts.vfiToken.toLowerCase();

    if (matchGovernor) {
      try {
        const decoded = decodeEventLog({
          abi: governorAbi,
          data: log.data,
          topics: log.topics
        });
        return { address: log.address, contract: "VfiGovernor", event: decoded.eventName, args: decoded.args };
      } catch {
        // fallthrough
      }
    }

    if (matchRegistry) {
      try {
        const decoded = decodeEventLog({
          abi: dappRegistryAbi,
          data: log.data,
          topics: log.topics
        });
        return { address: log.address, contract: "DappRegistry", event: decoded.eventName, args: decoded.args };
      } catch {
        // fallthrough
      }
    }

    if (matchToken) {
      try {
        const decoded = decodeEventLog({
          abi: vfiTokenAbi,
          data: log.data,
          topics: log.topics
        });
        return { address: log.address, contract: "VfiToken", event: decoded.eventName, args: decoded.args };
      } catch {
        // fallthrough
      }
    }

    return { address: log.address, event: "Unknown", data: log.data, topics: log.topics };
  });

  return decodedLogs;
}

export function printDecodedLogs(label: string, txHash: Hex, logs: DecodedLog[]) {
  console.log(`Logs for ${label}: ${txHash}`);
  for (const entry of logs) {
    if (entry.event === "Unknown") {
      console.log(`  ${entry.address} ${entry.event} data=${entry.data}`);
    } else {
      console.log(`  ${entry.contract}::${entry.event}`);
      console.log(`    ${toJson(entry.args)}`);
    }
  }
}

export const proposalStateNames = [
  "Pending",
  "Active",
  "Canceled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed"
] as const;

const MAX_ROOT_CID_BYTES = 4096;

export type ProposalCreatedArgs = {
  proposalId: bigint;
  proposer: Hex;
  targets: Hex[];
  values: bigint[];
  calldatas: Hex[];
  startBlock: bigint;
  endBlock: bigint;
  description: string;
};

export type DappLogArgs = {
  dappId: bigint;
  versionId?: bigint;
  fromVersionId?: bigint;
  toVersionId?: bigint;
  rootCid?: Hex;
  proposer?: Hex;
  name?: string;
  version?: string;
  description?: string;
  pausedBy?: Hex;
  unpausedBy?: Hex;
  deprecatedBy?: Hex;
  reason?: string;
};

export function requireArgs<T>(log: { args?: unknown }, label: string): T {
  if (!log.args) {
    throw new Error(`Missing log args for ${label}`);
  }
  return log.args as T;
}

export function encodeRootCid(input: string): Hex {
  if (!input) {
    throw new Error("rootCid cannot be empty");
  }
  if (isHex(input)) {
    const bytes = toBytes(input as Hex);
    if (bytes.length === 0) {
      throw new Error("rootCid hex must not be empty");
    }
    if (bytes.length > MAX_ROOT_CID_BYTES) {
      throw new Error(`rootCid exceeds ${MAX_ROOT_CID_BYTES} bytes`);
    }
    return input as Hex;
  }
  const bytes = toBytes(input);
  if (bytes.length > MAX_ROOT_CID_BYTES) {
    throw new Error(`rootCid exceeds ${MAX_ROOT_CID_BYTES} bytes`);
  }
  return bytesToHex(bytes);
}

export async function fetchProposalLogs(
  ctx: ReturnType<typeof loadContext>,
  options: { fromBlock: string; toBlock?: string }
) {
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  const fromBlock = resolveFromBlock(options.fromBlock, ctx.devnet);
  return ctx.publicClient.getLogs({
    address: governor as Hex,
    event: proposalCreatedEvent,
    fromBlock: BigInt(fromBlock),
    toBlock: options.toBlock ? BigInt(options.toBlock) : "latest"
  });
}

export async function fetchDappLogs(
  ctx: ReturnType<typeof loadContext>,
  options: { fromBlock: string; toBlock?: string }
) {
  const dappRegistry = ctx.contracts.dappRegistry;
  if (!dappRegistry) throw new Error("Missing dappRegistry address in config/devnet.");

  const resolvedFromBlock = resolveFromBlock(options.fromBlock, ctx.devnet);
  const fromBlock = BigInt(resolvedFromBlock);
  const toBlock = options.toBlock ? BigInt(options.toBlock) : "latest";

  const [published, upgraded, metadata, paused, unpaused, deprecated] = await Promise.all([
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappPublishedEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappUpgradedEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappMetadataEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappPausedEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappUnpausedEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappDeprecatedEvent, fromBlock, toBlock })
  ]);

  return [...published, ...upgraded, ...metadata, ...paused, ...unpaused, ...deprecated].sort(
    (a, b) => {
      const blockDiff = Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n));
      if (blockDiff !== 0) return blockDiff;
      return Number((a.logIndex ?? 0n) - (b.logIndex ?? 0n));
    }
  );
}

export async function readTokenDecimals(ctx: ReturnType<typeof loadContext>) {
  if (ctx.contracts.vfiToken) {
    try {
      const tokenDecimals = await ctx.publicClient.readContract({
        address: ctx.contracts.vfiToken as Hex,
        abi: vfiTokenAbi,
        functionName: "decimals"
      });
      return Number(tokenDecimals);
    } catch {
      return 18;
    }
  }
  return 18;
}

export async function readProposalState(ctx: ReturnType<typeof loadContext>, proposalId: bigint) {
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  const state = await ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "state",
    args: [proposalId]
  });
  return proposalStateNames[Number(state)] ?? String(state);
}

export async function readProposalSnapshot(ctx: ReturnType<typeof loadContext>, proposalId: bigint) {
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  return ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "proposalSnapshot",
    args: [proposalId]
  });
}

export async function readProposalDeadline(ctx: ReturnType<typeof loadContext>, proposalId: bigint) {
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  return ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "proposalDeadline",
    args: [proposalId]
  });
}

export async function readProposalVotes(ctx: ReturnType<typeof loadContext>, proposalId: bigint) {
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  return ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "proposalVotes",
    args: [proposalId]
  });
}

export async function readQuorum(ctx: ReturnType<typeof loadContext>, snapshot: bigint) {
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  return ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "quorum",
    args: [snapshot]
  });
}

export function formatUnitsSafe(value: bigint, decimals: number) {
  return formatUnits(value, decimals);
}

export function encodeProposeCalldata(
  rootCid: Hex,
  name: string,
  version: string,
  description: string
) {
  return encodeFunctionData({
    abi: dappRegistryAbi,
    functionName: "publishDapp",
    args: [rootCid, name, version, description]
  });
}

export function getGovernorAddress(ctx: ReturnType<typeof loadContext>) {
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");
  return governor as Hex;
}

export function getDappRegistryAddress(ctx: ReturnType<typeof loadContext>) {
  const dappRegistry = ctx.contracts.dappRegistry;
  if (!dappRegistry) throw new Error("Missing dappRegistry address in config/devnet.");
  return dappRegistry as Hex;
}

export function getTokenAddress(ctx: ReturnType<typeof loadContext>) {
  return ctx.contracts.vfiToken ? (ctx.contracts.vfiToken as Hex) : undefined;
}

export function buildVetoDescriptionHash(description: string) {
  return keccak256(toBytes(description));
}
