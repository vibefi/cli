import {
  bytesToHex,
  encodeFunctionData,
  isHex,
  toBytes,
  type AbiEvent,
  type Hex
} from "viem";
import {
  dappRegistryAbi,
  dappPublishedEvent,
  dappUpgradedEvent,
  dappMetadataEvent,
  dappPausedEvent,
  dappUnpausedEvent,
  dappDeprecatedEvent,
  vfiTokenAbi,
  resolveFromBlock
} from "@vibefi/shared";
import { type loadContext } from "./context";

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

const MAX_ROOT_CID_BYTES = 4096;

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

export async function fetchDappLogs(
  ctx: ReturnType<typeof loadContext>,
  options: { fromBlock: string; toBlock?: string }
) {
  const dappRegistry = getDappRegistryAddress(ctx);

  const resolvedFromBlock = resolveFromBlock(options.fromBlock, ctx.devnet);
  const fromBlock = BigInt(resolvedFromBlock);
  const toBlock = options.toBlock ? BigInt(options.toBlock) : "latest";

  const [published, upgraded, metadata, paused, unpaused, deprecated] = await Promise.all([
    ctx.publicClient.getLogs({ address: dappRegistry, event: dappPublishedEvent as AbiEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry, event: dappUpgradedEvent as AbiEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry, event: dappMetadataEvent as AbiEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry, event: dappPausedEvent as AbiEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry, event: dappUnpausedEvent as AbiEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry, event: dappDeprecatedEvent as AbiEvent, fromBlock, toBlock })
  ]);

  return [...published, ...upgraded, ...metadata, ...paused, ...unpaused, ...deprecated].sort(
    (a, b) => {
      const blockDiff = Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n));
      if (blockDiff !== 0) return blockDiff;
      return Number((a.logIndex ?? 0n) - (b.logIndex ?? 0n));
    }
  );
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

export function getDappRegistryAddress(ctx: ReturnType<typeof loadContext>) {
  const dappRegistry = ctx.contracts.dappRegistry;
  if (!dappRegistry) throw new Error("Missing dappRegistry address in config/devnet.");
  return dappRegistry as Hex;
}

export function getTokenAddress(ctx: ReturnType<typeof loadContext>) {
  return ctx.contracts.vfiToken ? (ctx.contracts.vfiToken as Hex) : undefined;
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
