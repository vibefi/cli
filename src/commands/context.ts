import { Command } from "commander";
import { getAddress, type Hex } from "viem";
import {
  resolveRpcUrl,
  resolveDevnetJson,
  loadDevnetJson,
  resolveChainId,
  resolveContracts,
  getPublicClient,
  getWalletClient,
  resolvePrivateKey
} from "@vibefi/shared";
import { ensureConfig, getConfigPath, resolveNetwork } from "../cli-config";

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
  const privateKey = resolvePrivateKey(base.devnet, options.pk);
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
