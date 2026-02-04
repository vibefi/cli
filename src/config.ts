import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ContractsConfig = {
  vfiToken?: string;
  vfiGovernor?: string;
  vfiTimelock?: string;
  dappRegistry?: string;
  constraintsRegistry?: string;
  proposalRequirements?: string;
};

export type NetworkConfig = {
  rpcUrl?: string;
  chainId?: number;
  devnetJson?: string;
  contracts?: ContractsConfig;
};

export type VibefiConfig = {
  defaultNetwork: string;
  networks: Record<string, NetworkConfig>;
};

const CONFIG_DIR = path.join(process.cwd(), ".vibefi");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_PATH = path.join(MODULE_DIR, "..", "config.defaults.json");

export function ensureConfig(): VibefiConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const defaultsRaw = fs.readFileSync(DEFAULTS_PATH, "utf-8");
    fs.writeFileSync(CONFIG_PATH, defaultsRaw, "utf-8");
  }

  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as VibefiConfig;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function resolveNetwork(config: VibefiConfig, override?: string): {
  name: string;
  config: NetworkConfig;
} {
  const name = override ?? config.defaultNetwork ?? "mainnet";
  const networkConfig = config.networks?.[name] ?? config.networks?.mainnet ?? {};
  return { name, config: networkConfig };
}

export function resolveRpcUrl(network: NetworkConfig, override?: string): string {
  return override ?? process.env.VIBEFI_RPC_URL ?? network.rpcUrl ?? "";
}

export function resolveDevnetJson(network: NetworkConfig): string | undefined {
  if (!network.devnetJson) return undefined;
  return path.resolve(process.cwd(), network.devnetJson);
}

export type DevnetJson = {
  chainId: number;
  deployBlock?: number;
  vfiToken: string;
  vfiGovernor: string;
  vfiTimelock: string;
  dappRegistry: string;
  constraintsRegistry: string;
  proposalRequirements: string;
  developer: string;
  voter1: string;
  voter2: string;
  securityCouncil1: string;
  securityCouncil2?: string;
  developerPrivateKey: string;
  voter1PrivateKey: string;
  voter2PrivateKey: string;
  securityCouncil1PrivateKey: string;
  securityCouncil2PrivateKey?: string;
};

export function loadDevnetJson(devnetPath?: string): DevnetJson | undefined {
  if (!devnetPath) return undefined;
  if (!fs.existsSync(devnetPath)) return undefined;
  const raw = fs.readFileSync(devnetPath, "utf-8");
  return JSON.parse(raw) as DevnetJson;
}

export function resolveContracts(network: NetworkConfig, devnet?: DevnetJson): ContractsConfig {
  if (devnet) {
    return {
      vfiToken: devnet.vfiToken,
      vfiGovernor: devnet.vfiGovernor,
      vfiTimelock: devnet.vfiTimelock,
      dappRegistry: devnet.dappRegistry,
      constraintsRegistry: devnet.constraintsRegistry,
      proposalRequirements: devnet.proposalRequirements
    };
  }
  return network.contracts ?? {};
}

export function resolveChainId(network: NetworkConfig, devnet?: DevnetJson): number | undefined {
  return devnet?.chainId ?? network.chainId;
}

export function resolveFromBlock(fromBlockOption: string, devnet?: DevnetJson): string {
  // If explicitly set to something other than "0", use that
  if (fromBlockOption !== "0") return fromBlockOption;
  // Otherwise use deployBlock from devnet config if available
  if (devnet?.deployBlock !== undefined) return devnet.deployBlock.toString();
  return "0";
}
