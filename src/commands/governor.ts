import { keccak256, toBytes, type AbiEvent, type Hex } from "viem";
import {
  governorAbi,
  proposalCreatedEvent,
  resolveFromBlock
} from "@vibefi/shared";
import { type loadContext } from "./context";

export const proposalStateNames = [
  "Pending",
  "Active",
  "Canceled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed"
] as const;

export type ProposalCreatedArgs = {
  proposalId: bigint;
  proposer: Hex;
  targets: Hex[];
  values: bigint[];
  calldatas: Hex[];
  startBlock: bigint;
  endBlock: bigint;
  description: string;
};

export function requireArgs<T>(log: unknown, label: string): T {
  const entry = log as { args?: unknown };
  if (!entry.args) {
    throw new Error(`Missing log args for ${label}`);
  }
  return entry.args as T;
}

export function getGovernorAddress(ctx: ReturnType<typeof loadContext>) {
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");
  return governor as Hex;
}

export async function fetchProposalLogs(
  ctx: ReturnType<typeof loadContext>,
  options: { fromBlock: string; toBlock?: string }
) {
  const governor = getGovernorAddress(ctx);

  const fromBlock = resolveFromBlock(options.fromBlock, ctx.devnet);
  return ctx.publicClient.getLogs({
    address: governor,
    event: proposalCreatedEvent as AbiEvent,
    fromBlock: BigInt(fromBlock),
    toBlock: options.toBlock ? BigInt(options.toBlock) : "latest"
  });
}

export async function findProposalByIdOrThrow(
  ctx: ReturnType<typeof loadContext>,
  proposalId: string,
  options: { fromBlock: string; toBlock?: string }
) {
  const proposalLogs = await fetchProposalLogs(ctx, options);
  const target = proposalLogs.find((log) => {
    const args = log.args as ProposalCreatedArgs | undefined;
    return args?.proposalId?.toString() === proposalId;
  });
  if (!target) throw new Error(`Proposal ${proposalId} not found in logs.`);
  return requireArgs<ProposalCreatedArgs>(target, "ProposalCreated");
}

export async function readProposalState(ctx: ReturnType<typeof loadContext>, proposalId: bigint) {
  const governor = getGovernorAddress(ctx);

  const state = await ctx.publicClient.readContract({
    address: governor,
    abi: governorAbi,
    functionName: "state",
    args: [proposalId]
  });
  return proposalStateNames[Number(state)] ?? String(state);
}

export async function readProposalSnapshot(ctx: ReturnType<typeof loadContext>, proposalId: bigint): Promise<bigint> {
  const governor = getGovernorAddress(ctx);

  return ctx.publicClient.readContract({
    address: governor,
    abi: governorAbi,
    functionName: "proposalSnapshot",
    args: [proposalId]
  }) as Promise<bigint>;
}

export async function readProposalDeadline(ctx: ReturnType<typeof loadContext>, proposalId: bigint): Promise<bigint> {
  const governor = getGovernorAddress(ctx);

  return ctx.publicClient.readContract({
    address: governor,
    abi: governorAbi,
    functionName: "proposalDeadline",
    args: [proposalId]
  }) as Promise<bigint>;
}

export async function readProposalVotes(ctx: ReturnType<typeof loadContext>, proposalId: bigint): Promise<readonly [bigint, bigint, bigint]> {
  const governor = getGovernorAddress(ctx);

  return ctx.publicClient.readContract({
    address: governor,
    abi: governorAbi,
    functionName: "proposalVotes",
    args: [proposalId]
  }) as Promise<readonly [bigint, bigint, bigint]>;
}

export async function readQuorum(ctx: ReturnType<typeof loadContext>, snapshot: bigint): Promise<bigint> {
  const governor = getGovernorAddress(ctx);

  return ctx.publicClient.readContract({
    address: governor,
    abi: governorAbi,
    functionName: "quorum",
    args: [snapshot]
  }) as Promise<bigint>;
}

export function buildVetoDescriptionHash(description: string) {
  return keccak256(toBytes(description));
}
