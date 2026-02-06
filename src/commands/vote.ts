import { Command } from "commander";
import { formatUnits, type Hex } from "viem";
import { governorAbi } from "@vibefi/shared";
import { getWalletContext, loadContext, toJson, withCommonOptions } from "./context";
import { printTxResult } from "./output";
import {
  getGovernorAddress,
  readProposalSnapshot,
  readProposalVotes,
  readQuorum
} from "./governor";
import { readTokenDecimals } from "./registry";

export function registerVote(program: Command) {
  withCommonOptions(
    program
      .command("vote:cast")
      .description("Cast a vote on a proposal")
      .argument("<proposalId>", "Proposal id")
      .requiredOption("--support <for|against|abstain>", "Vote support")
      .option("--reason <text>", "Vote reason")
  ).action(async (proposalId, options) => {
    const ctx = loadContext(options);
    const governor = getGovernorAddress(ctx);

    const wallet = getWalletContext(ctx, options);
    const supportMap: Record<string, number> = { against: 0, for: 1, abstain: 2 };
    const support = supportMap[String(options.support).toLowerCase()];
    if (support === undefined) throw new Error("Support must be for|against|abstain");

    const args = [BigInt(proposalId), support] as const;
    const hash = options.reason
      ? await wallet.walletClient.writeContract({
          address: governor as Hex,
          abi: governorAbi,
          functionName: "castVoteWithReason",
          args: [...args, options.reason]
        })
      : await wallet.walletClient.writeContract({
          address: governor as Hex,
          abi: governorAbi,
          functionName: "castVote",
          args
        });

    await printTxResult("Vote submitted", ctx, hash, options.json);
  });

  withCommonOptions(
    program
      .command("vote:status")
      .description("Show proposal vote totals and quorum")
      .argument("<proposalId>", "Proposal id")
  ).action(async (proposalId, options) => {
    const ctx = loadContext(options);

    const snapshot = await readProposalSnapshot(ctx, BigInt(proposalId));
    const votes = await readProposalVotes(ctx, BigInt(proposalId));
    const quorum = await readQuorum(ctx, snapshot);
    const decimals = await readTokenDecimals(ctx);

    const output = {
      proposalId,
      snapshot: snapshot.toString(),
      quorum: quorum.toString(),
      againstVotes: votes[0].toString(),
      forVotes: votes[1].toString(),
      abstainVotes: votes[2].toString()
    };

    if (options.json) {
      console.log(toJson(output));
      return;
    }

    console.log(`Proposal #${proposalId}`);
    console.log(`Snapshot: ${output.snapshot}`);
    console.log(`Quorum: ${formatUnits(quorum, decimals)} VFI`);
    console.log(`Against: ${formatUnits(votes[0], decimals)} VFI`);
    console.log(`For: ${formatUnits(votes[1], decimals)} VFI`);
    console.log(`Abstain: ${formatUnits(votes[2], decimals)} VFI`);
  });
}
