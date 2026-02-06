import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VibefiConfig, NetworkConfig } from "@vibefi/shared";

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
