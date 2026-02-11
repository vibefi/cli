import { Command } from "commander";
import { getAddress, type Hex } from "viem";
import { governorAbi } from "@vibefi/shared";
import { getWalletContext, loadContext, toJson, withCommonOptions } from "./context";
import { printTxResult } from "./output";
import {
  buildVetoDescriptionHash,
  fetchProposalLogs,
  findProposalByIdOrThrow,
  getGovernorAddress,
  proposalStateNames,
  readProposalDeadline,
  readProposalSnapshot,
  readProposalState,
  requireArgs,
  type ProposalCreatedArgs
} from "./governor";

export function registerProposals(program: Command) {
  withCommonOptions(
    program
      .command("proposals:list")
      .description("List governance proposals")
      .option("--from-block <number>", "Start block", "0")
      .option("--to-block <number>", "End block")
      .option("--limit <number>", "Max proposals to show", "50")
  ).action(async (options) => {
    const ctx = loadContext(options);
    const governor = getGovernorAddress(ctx);

    const logs = await fetchProposalLogs(ctx, {
      fromBlock: options.fromBlock,
      toBlock: options.toBlock
    });

    const proposals = await Promise.all(
      logs.map(async (log) => {
        const args = requireArgs<ProposalCreatedArgs>(log, "ProposalCreated");
        const proposalId = args.proposalId;
        const state = await ctx.publicClient.readContract({
          address: governor as Hex,
          abi: governorAbi,
          functionName: "state",
          args: [proposalId]
        });
        return {
          proposalId: proposalId.toString(),
          proposer: getAddress(args.proposer),
          description: args.description,
          startBlock: args.voteStart.toString(),
          endBlock: args.voteEnd.toString(),
          state: proposalStateNames[Number(state)] ?? String(state)
        };
      })
    );

    const limit = Number(options.limit);
    const sliced = proposals.slice(-limit);

    if (options.json) {
      console.log(toJson(sliced));
      return;
    }

    for (const proposal of sliced) {
      console.log(
        `#${proposal.proposalId} ${proposal.state} proposer=${proposal.proposer} start=${proposal.startBlock} end=${proposal.endBlock}`
      );
      console.log(`  ${proposal.description}`);
    }
  });

  withCommonOptions(
    program
      .command("proposals:show")
      .description("Show proposal details")
      .argument("<proposalId>", "Proposal id")
      .option("--from-block <number>", "Start block", "0")
      .option("--to-block <number>", "End block")
  ).action(async (proposalId, options) => {
    const ctx = loadContext(options);

    const args = await findProposalByIdOrThrow(ctx, proposalId, {
      fromBlock: options.fromBlock,
      toBlock: options.toBlock
    });

    const state = await readProposalState(ctx, BigInt(proposalId));
    const snapshot = await readProposalSnapshot(ctx, BigInt(proposalId));
    const deadline = await readProposalDeadline(ctx, BigInt(proposalId));

    const output = {
      proposalId,
      proposer: getAddress(args.proposer),
      description: args.description,
      targets: args.targets.map((target) => getAddress(target)),
      values: args.values.map((v) => v.toString()),
      calldatas: args.calldatas,
      startBlock: args.voteStart.toString(),
      endBlock: args.voteEnd.toString(),
      snapshot: snapshot.toString(),
      deadline: deadline.toString(),
      state
    };

    if (options.json) {
      console.log(toJson(output));
      return;
    }

    console.log(`Proposal #${proposalId}`);
    console.log(`State: ${output.state}`);
    console.log(`Proposer: ${output.proposer}`);
    console.log(`Start: ${output.startBlock} End: ${output.endBlock}`);
    console.log(`Snapshot: ${output.snapshot} Deadline: ${output.deadline}`);
    console.log(`Description: ${output.description}`);
    console.log(`Targets: ${output.targets.join(", ")}`);
    console.log(`Values: ${output.values.join(", ")}`);
    console.log(`Calldatas: ${output.calldatas.join(", ")}`);
  });

  withCommonOptions(
    program
      .command("proposals:queue")
      .description("Queue a proposal in the timelock")
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
      functionName: "queue",
      args: [args.targets, args.values, args.calldatas, descriptionHash]
    });

    await printTxResult("Queue submitted", ctx, hash, options.json);
  });

  withCommonOptions(
    program
      .command("proposals:execute")
      .description("Execute a queued proposal")
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
      functionName: "execute",
      args: [args.targets, args.values, args.calldatas, descriptionHash]
    });

    await printTxResult("Execute submitted", ctx, hash, options.json);
  });
}
