import { Command } from "commander";
import { type Hex } from "viem";
import { getWalletClient, resolvePrivateKey } from "../clients";
import { loadContext, roleHint, toJson, withCommonOptions } from "./shared";

export function registerStatus(program: Command) {
  withCommonOptions(
    program
      .command("status")
      .description("Show network, contracts, and signer info")
  ).action(async (options) => {
    const ctx = loadContext(options);
    const privateKey = resolvePrivateKey({}, ctx.devnet, options.pk);
    const walletClient = privateKey
      ? getWalletClient(ctx.rpcUrl, ctx.chainId, privateKey as Hex)
      : undefined;
    const account = walletClient?.account?.address;
    const hint = roleHint(account, ctx.devnet);

    const output = {
      network: ctx.networkName,
      rpcUrl: ctx.rpcUrl,
      chainId: ctx.chainId,
      contracts: ctx.contracts,
      signer: account,
      roleHint: hint
    };

    if (options.json) {
      console.log(toJson(output));
      return;
    }

    console.log(`Network: ${ctx.networkName}`);
    console.log(`RPC: ${ctx.rpcUrl}`);
    console.log(`ChainId: ${ctx.chainId ?? "unknown"}`);
    console.log("Contracts:");
    for (const [key, value] of Object.entries(ctx.contracts)) {
      console.log(`  ${key}: ${value ?? ""}`);
    }
    if (account) {
      console.log(`Signer: ${account}${hint ? ` (${hint})` : ""}`);
    } else {
      console.log("Signer: none (read-only)");
    }
  });
}
