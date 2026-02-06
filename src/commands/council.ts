import { Command } from "commander";
import { type Hex } from "viem";
import { dappRegistryAbi, governorAbi } from "@vibefi/shared";
import { getWalletContext, loadContext, toJson, withCommonOptions } from "./context";
import { printTxResult } from "./output";
import {
  buildVetoDescriptionHash,
  findProposalByIdOrThrow,
  getGovernorAddress
} from "./governor";
import { getDappRegistryAddress } from "./registry";

export function registerCouncil(program: Command) {
  withCommonOptions(
    program
      .command("council:veto")
      .description("Security council veto a proposal")
      .argument("<proposalId>", "Proposal id")
      .option("--from-block <number>", "Start block", "0")
      .option("--to-block <number>", "End block")
  ).action(async (proposalId, options) => {
    const ctx = loadContext(options);
    const governor = getGovernorAddress(ctx);

    const args = await findProposalByIdOrThrow(ctx, proposalId, {
      fromBlock: options.fromBlock,
      toBlock: options.toBlock
    });

    const descriptionHash = buildVetoDescriptionHash(args.description as string);

    const wallet = getWalletContext(ctx, options);
    const hash = await wallet.walletClient.writeContract({
      address: governor as Hex,
      abi: governorAbi,
      functionName: "vetoProposal",
      args: [args.targets, args.values, args.calldatas, descriptionHash]
    });

    await printTxResult("Veto submitted", ctx, hash, options.json);
  });

  function withCouncilCommand(
    name: string,
    description: string,
    fn: "pauseDappVersion" | "unpauseDappVersion" | "deprecateDappVersion"
  ) {
    return withCommonOptions(
      program
        .command(name)
        .description(description)
        .requiredOption("--dapp-id <id>", "Dapp id")
        .requiredOption("--version-id <id>", "Version id")
        .requiredOption("--reason <text>", "Reason")
    ).action(async (options) => {
      const ctx = loadContext(options);
      const dappRegistry = getDappRegistryAddress(ctx);

      const wallet = getWalletContext(ctx, options);
      const hash = await wallet.walletClient.writeContract({
        address: dappRegistry as Hex,
        abi: dappRegistryAbi,
        functionName: fn,
        args: [BigInt(options.dappId), BigInt(options.versionId), options.reason]
      });

      await printTxResult(`${name} submitted`, ctx, hash, options.json);
    });
  }

  withCouncilCommand("council:pause", "Pause a dapp version", "pauseDappVersion");
  withCouncilCommand("council:unpause", "Unpause a dapp version", "unpauseDappVersion");
  withCouncilCommand("council:deprecate", "Deprecate a dapp version", "deprecateDappVersion");
}
