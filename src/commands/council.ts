import { Command } from "commander";
import { type Hex } from "viem";
import { dappRegistryAbi, governorAbi } from "../abi";
import {
  buildVetoDescriptionHash,
  fetchProposalLogs,
  fetchTxLogs,
  getDappRegistryAddress,
  getGovernorAddress,
  getWalletContext,
  loadContext,
  printDecodedLogs,
  requireArgs,
  toJson,
  withCommonOptions,
  type ProposalCreatedArgs
} from "./shared";

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

    const proposalLogs = await fetchProposalLogs(ctx, {
      fromBlock: options.fromBlock,
      toBlock: options.toBlock
    });

    const target = proposalLogs.find((log) => {
      const args = log.args as ProposalCreatedArgs | undefined;
      return args?.proposalId?.toString() === proposalId;
    });
    if (!target) throw new Error(`Proposal ${proposalId} not found in logs.`);

    const args = requireArgs<ProposalCreatedArgs>(target, "ProposalCreated");
    const descriptionHash = buildVetoDescriptionHash(args.description as string);

    const wallet = getWalletContext(ctx, options);
    const hash = await wallet.walletClient.writeContract({
      address: governor as Hex,
      abi: governorAbi,
      functionName: "vetoProposal",
      args: [args.targets, args.values, args.calldatas, descriptionHash]
    });

    const logs = await fetchTxLogs(ctx, hash);
    if (options.json) {
      console.log(toJson({ txHash: hash, logs }));
      return;
    }
    console.log(`Veto submitted: ${hash}`);
    printDecodedLogs("council:veto", hash, logs);
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

      const logs = await fetchTxLogs(ctx, hash);
      if (options.json) {
        console.log(toJson({ txHash: hash, logs }));
        return;
      }
      console.log(`${name} submitted: ${hash}`);
      printDecodedLogs(name, hash, logs);
    });
  }

  withCouncilCommand("council:pause", "Pause a dapp version", "pauseDappVersion");
  withCouncilCommand("council:unpause", "Unpause a dapp version", "unpauseDappVersion");
  withCouncilCommand("council:deprecate", "Deprecate a dapp version", "deprecateDappVersion");
}
