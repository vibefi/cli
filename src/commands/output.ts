import { decodeEventLog, type Hex } from "viem";
import {
  governorAbi,
  dappRegistryAbi,
  vfiTokenAbi
} from "@vibefi/shared";
import { type loadContext, toJson } from "./context";

export type DecodedLog =
  | { address: string; contract: string; event: string; args: unknown }
  | { address: string; event: "Unknown"; data: Hex; topics: Hex[] };

export async function fetchTxLogs(
  ctx: ReturnType<typeof loadContext>,
  txHash: Hex
) {
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  const logs = receipt.logs ?? [];
  const decodedLogs: DecodedLog[] = [];

  for (const log of logs) {
    const address = log.address.toLowerCase();
    const matchGovernor = ctx.contracts.vfiGovernor && address === ctx.contracts.vfiGovernor.toLowerCase();
    const matchRegistry = ctx.contracts.dappRegistry && address === ctx.contracts.dappRegistry.toLowerCase();
    const matchToken = ctx.contracts.vfiToken && address === ctx.contracts.vfiToken.toLowerCase();

    let decoded: DecodedLog | undefined;

    if (matchGovernor) {
      try {
        const result = decodeEventLog({
          abi: governorAbi,
          data: log.data,
          topics: log.topics
        }) as { eventName?: string; args: unknown };
        decoded = { address: log.address, contract: "VfiGovernor", event: result.eventName ?? "Unknown", args: result.args };
      } catch {
        // fallthrough
      }
    }

    if (!decoded && matchRegistry) {
      try {
        const result = decodeEventLog({
          abi: dappRegistryAbi,
          data: log.data,
          topics: log.topics
        }) as { eventName?: string; args: unknown };
        decoded = { address: log.address, contract: "DappRegistry", event: result.eventName ?? "Unknown", args: result.args };
      } catch {
        // fallthrough
      }
    }

    if (!decoded && matchToken) {
      try {
        const result = decodeEventLog({
          abi: vfiTokenAbi,
          data: log.data,
          topics: log.topics
        }) as { eventName?: string; args: unknown };
        decoded = { address: log.address, contract: "VfiToken", event: result.eventName ?? "Unknown", args: result.args };
      } catch {
        // fallthrough
      }
    }

    decodedLogs.push(decoded ?? { address: log.address, event: "Unknown" as const, data: log.data, topics: log.topics as Hex[] });
  }

  return decodedLogs;
}

export function printDecodedLogs(label: string, txHash: Hex, logs: DecodedLog[]) {
  console.log(`Logs for ${label}: ${txHash}`);
  for (const entry of logs) {
    if (entry.event === "Unknown") {
      const unknownEntry = entry as { address: string; event: "Unknown"; data: Hex; topics: Hex[] };
      console.log(`  ${entry.address} ${entry.event} data=${unknownEntry.data}`);
    } else {
      const knownEntry = entry as { address: string; contract: string; event: string; args: unknown };
      console.log(`  ${knownEntry.contract}::${knownEntry.event}`);
      console.log(`    ${toJson(knownEntry.args)}`);
    }
  }
}

export async function printTxResult(
  label: string,
  ctx: ReturnType<typeof loadContext>,
  hash: Hex,
  json: boolean
) {
  const logs = await fetchTxLogs(ctx, hash);
  if (json) {
    console.log(toJson({ txHash: hash, logs }));
    return;
  }
  console.log(`${label}: ${hash}`);
  printDecodedLogs(label, hash, logs);
}
