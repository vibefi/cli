#!/usr/bin/env bun
import { Command } from "commander";
import {
  bytesToHex,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isHex,
  keccak256,
  toBytes,
  type Hex
} from "viem";
import {
  dappDeprecatedEvent,
  dappMetadataEvent,
  dappPausedEvent,
  dappPublishedEvent,
  dappRegistryAbi,
  dappUnpausedEvent,
  dappUpgradedEvent,
  governorAbi,
  proposalCreatedEvent,
  vfiTokenAbi
} from "./abi";
import {
  ensureConfig,
  getConfigPath,
  loadDevnetJson,
  resolveChainId,
  resolveContracts,
  resolveDevnetJson,
  resolveNetwork,
  resolveRpcUrl
} from "./config";
import { getPublicClient, getWalletClient, resolvePrivateKey } from "./clients";

const program = new Command();

function withCommonOptions(cmd: Command) {
  return cmd
    .option("-n, --network <name>", "Network name from .vibefi/config.json")
    .option("--rpc <url>", "RPC URL override")
    .option("--devnet <path>", "Path to devnet.json override")
    .option("--pk <hex>", "Private key override (0x...)")
    .option("--json", "Output JSON");
}

function loadContext(options: {
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

function getWalletContext(
  base: ReturnType<typeof loadContext>,
  options: { pk?: string }
) {
  const privateKey = resolvePrivateKey({}, base.devnet, options.pk);
  if (!privateKey) {
    throw new Error("Private key required. Pass --pk or set VIBEFI_PRIVATE_KEY.");
  }
  const walletClient = getWalletClient(base.rpcUrl, base.chainId, privateKey as Hex);
  return { ...base, walletClient, privateKey };
}

function roleHint(address: string | undefined, devnet: ReturnType<typeof loadDevnetJson>) {
  if (!address || !devnet) return undefined;
  const lower = address.toLowerCase();
  if (lower === normalizeAddress(devnet.developer)) return "developer";
  if (lower === normalizeAddress(devnet.voter1)) return "voter1";
  if (lower === normalizeAddress(devnet.voter2)) return "voter2";
  if (lower === normalizeAddress(devnet.securityCouncil1)) return "securityCouncil1";
  if (devnet.securityCouncil2 && lower === normalizeAddress(devnet.securityCouncil2)) {
    return "securityCouncil2";
  }
  return undefined;
}

function normalizeAddress(address: string): string {
  try {
    return getAddress(address);
  } catch {
    return address.toLowerCase();
  }
}

function normalizeAddress(address: string): string {
  try {
    return getAddress(address);
  } catch {
    return address.toLowerCase();
  }
}

const proposalStateNames = [
  "Pending",
  "Active",
  "Canceled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed"
] as const;

const MAX_ROOT_CID_BYTES = 4096;

type ProposalCreatedArgs = {
  proposalId: bigint;
  proposer: Hex;
  targets: Hex[];
  values: bigint[];
  calldatas: Hex[];
  startBlock: bigint;
  endBlock: bigint;
  description: string;
};

type DappLogArgs = {
  dappId: bigint;
  versionId?: bigint;
  fromVersionId?: bigint;
  toVersionId?: bigint;
  rootCid?: Hex;
  proposer?: Hex;
  name?: string;
  version?: string;
  description?: string;
  pausedBy?: Hex;
  unpausedBy?: Hex;
  deprecatedBy?: Hex;
  reason?: string;
};

function requireArgs<T>(log: { args?: unknown }, label: string): T {
  if (!log.args) {
    throw new Error(`Missing log args for ${label}`);
  }
  return log.args as T;
}

function encodeRootCid(input: string): Hex {
  if (!input) {
    throw new Error("rootCid cannot be empty");
  }
  if (isHex(input)) {
    const bytes = toBytes(input as Hex);
    if (bytes.length === 0) {
      throw new Error("rootCid hex must not be empty");
    }
    if (bytes.length > MAX_ROOT_CID_BYTES) {
      throw new Error(`rootCid exceeds ${MAX_ROOT_CID_BYTES} bytes`);
    }
    return input as Hex;
  }
  const bytes = toBytes(input);
  if (bytes.length > MAX_ROOT_CID_BYTES) {
    throw new Error(`rootCid exceeds ${MAX_ROOT_CID_BYTES} bytes`);
  }
  return bytesToHex(bytes);
}

program.name("vibefi").description("VibeFi CLI").version("0.1.0");

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
    console.log(JSON.stringify(output, null, 2));
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

withCommonOptions(
  program
    .command("proposals:list")
    .description("List governance proposals")
    .option("--from-block <number>", "Start block", "0")
    .option("--to-block <number>", "End block")
    .option("--limit <number>", "Max proposals to show", "50")
).action(async (options) => {
  const ctx = loadContext(options);
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  const fromBlock = BigInt(options.fromBlock);
  const toBlock = options.toBlock ? BigInt(options.toBlock) : undefined;

  const logs = await ctx.publicClient.getLogs({
    address: governor as Hex,
    event: proposalCreatedEvent,
    fromBlock,
    toBlock: toBlock ?? "latest"
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
        startBlock: args.startBlock.toString(),
        endBlock: args.endBlock.toString(),
        state: proposalStateNames[Number(state)] ?? String(state)
      };
    })
  );

  const limit = Number(options.limit);
  const sliced = proposals.slice(-limit);

  if (options.json) {
    console.log(JSON.stringify(sliced, null, 2));
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
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  const logs = await ctx.publicClient.getLogs({
    address: governor as Hex,
    event: proposalCreatedEvent,
    fromBlock: BigInt(options.fromBlock),
    toBlock: options.toBlock ? BigInt(options.toBlock) : "latest"
  });

  const target = logs.find((log) => {
    const args = log.args as ProposalCreatedArgs | undefined;
    return args?.proposalId?.toString() === proposalId;
  });
  if (!target) throw new Error(`Proposal ${proposalId} not found in logs.`);

  const args = requireArgs<ProposalCreatedArgs>(target, "ProposalCreated");
  const state = await ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "state",
    args: [BigInt(proposalId)]
  });

  const snapshot = await ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "proposalSnapshot",
    args: [BigInt(proposalId)]
  });

  const deadline = await ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "proposalDeadline",
    args: [BigInt(proposalId)]
  });

  const output = {
    proposalId,
    proposer: getAddress(args.proposer),
    description: args.description,
    targets: args.targets.map((target) => getAddress(target)),
    values: args.values.map((v) => v.toString()),
    calldatas: args.calldatas,
    startBlock: args.startBlock.toString(),
    endBlock: args.endBlock.toString(),
    snapshot: snapshot.toString(),
    deadline: deadline.toString(),
    state: proposalStateNames[Number(state)] ?? String(state)
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
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
    .command("dapp:propose")
    .description("Propose publishing a new dapp")
    .requiredOption("--root-cid <value>", "Root CID (hex 0x... or string)")
    .requiredOption("--name <name>", "Dapp name")
    .requiredOption("--version <version>", "Dapp version string")
    .requiredOption("--description <text>", "Dapp description")
    .option("--proposal-description <text>", "Proposal description")
).action(async (options) => {
  const ctx = loadContext(options);
  const governor = ctx.contracts.vfiGovernor;
  const dappRegistry = ctx.contracts.dappRegistry;
  if (!governor || !dappRegistry) {
    throw new Error("Missing vfiGovernor or dappRegistry address in config/devnet.");
  }

  const wallet = getWalletContext(ctx, options);

  const rootCid = encodeRootCid(options.rootCid as string);

  const calldata = encodeFunctionData({
    abi: dappRegistryAbi,
    functionName: "publishDapp",
    args: [rootCid, options.name, options.version, options.description]
  });

  const description =
    options.proposalDescription ?? `Publish dapp ${options.name} ${options.version}`;

  const hash = await wallet.walletClient.writeContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "propose",
    args: [[dappRegistry as Hex], [0n], [calldata], description]
  });

  const output = { txHash: hash };
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(`Proposal submitted: ${hash}`);
});

withCommonOptions(
  program
    .command("vote:cast")
    .description("Cast a vote on a proposal")
    .argument("<proposalId>", "Proposal id")
    .requiredOption("--support <for|against|abstain>", "Vote support")
    .option("--reason <text>", "Vote reason")
).action(async (proposalId, options) => {
  const ctx = loadContext(options);
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

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

  const output = { txHash: hash };
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(`Vote submitted: ${hash}`);
});

withCommonOptions(
  program
    .command("vote:status")
    .description("Show proposal vote totals and quorum")
    .argument("<proposalId>", "Proposal id")
).action(async (proposalId, options) => {
  const ctx = loadContext(options);
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  const snapshot = await ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "proposalSnapshot",
    args: [BigInt(proposalId)]
  });

  const votes = await ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "proposalVotes",
    args: [BigInt(proposalId)]
  });

  const quorum = await ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "quorum",
    args: [snapshot]
  });

  let decimals = 18;
  if (ctx.contracts.vfiToken) {
    try {
      const tokenDecimals = await ctx.publicClient.readContract({
        address: ctx.contracts.vfiToken as Hex,
        abi: vfiTokenAbi,
        functionName: "decimals"
      });
      decimals = Number(tokenDecimals);
    } catch {
      decimals = 18;
    }
  }

  const output = {
    proposalId,
    snapshot: snapshot.toString(),
    quorum: quorum.toString(),
    againstVotes: votes[0].toString(),
    forVotes: votes[1].toString(),
    abstainVotes: votes[2].toString()
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Proposal #${proposalId}`);
  console.log(`Snapshot: ${output.snapshot}`);
  console.log(`Quorum: ${formatUnits(quorum, decimals)} VFI`);
  console.log(`Against: ${formatUnits(votes[0], decimals)} VFI`);
  console.log(`For: ${formatUnits(votes[1], decimals)} VFI`);
  console.log(`Abstain: ${formatUnits(votes[2], decimals)} VFI`);
});

withCommonOptions(
  program
    .command("council:veto")
    .description("Security council veto a proposal")
    .argument("<proposalId>", "Proposal id")
    .option("--from-block <number>", "Start block", "0")
    .option("--to-block <number>", "End block")
).action(async (proposalId, options) => {
  const ctx = loadContext(options);
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  const logs = await ctx.publicClient.getLogs({
    address: governor as Hex,
    event: proposalCreatedEvent,
    fromBlock: BigInt(options.fromBlock),
    toBlock: options.toBlock ? BigInt(options.toBlock) : "latest"
  });

  const target = logs.find((log) => {
    const args = log.args as ProposalCreatedArgs | undefined;
    return args?.proposalId?.toString() === proposalId;
  });
  if (!target) throw new Error(`Proposal ${proposalId} not found in logs.`);

  const args = requireArgs<ProposalCreatedArgs>(target, "ProposalCreated");
  const descriptionHash = keccak256(toBytes(args.description as string));

  const wallet = getWalletContext(ctx, options);
  const hash = await wallet.walletClient.writeContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "vetoProposal",
    args: [args.targets, args.values, args.calldatas, descriptionHash]
  });

  const output = { txHash: hash };
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(`Veto submitted: ${hash}`);
});

function withCouncilCommand(name: string, description: string, fn: "pauseDappVersion" | "unpauseDappVersion" | "deprecateDappVersion") {
  return withCommonOptions(
    program
      .command(name)
      .description(description)
      .requiredOption("--dapp-id <id>", "Dapp id")
      .requiredOption("--version-id <id>", "Version id")
      .requiredOption("--reason <text>", "Reason")
  ).action(async (options) => {
    const ctx = loadContext(options);
    const dappRegistry = ctx.contracts.dappRegistry;
    if (!dappRegistry) throw new Error("Missing dappRegistry address in config/devnet.");

    const wallet = getWalletContext(ctx, options);
    const hash = await wallet.walletClient.writeContract({
      address: dappRegistry as Hex,
      abi: dappRegistryAbi,
      functionName: fn,
      args: [BigInt(options.dappId), BigInt(options.versionId), options.reason]
    });

    const output = { txHash: hash };
    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    console.log(`${name} submitted: ${hash}`);
  });
}

withCouncilCommand("council:pause", "Pause a dapp version", "pauseDappVersion");
withCouncilCommand("council:unpause", "Unpause a dapp version", "unpauseDappVersion");
withCouncilCommand("council:deprecate", "Deprecate a dapp version", "deprecateDappVersion");

withCommonOptions(
  program
    .command("dapp:list")
    .description("List dapps with latest version and status")
    .option("--from-block <number>", "Start block", "0")
    .option("--to-block <number>", "End block")
).action(async (options) => {
  const ctx = loadContext(options);
  const dappRegistry = ctx.contracts.dappRegistry;
  if (!dappRegistry) throw new Error("Missing dappRegistry address in config/devnet.");

  const fromBlock = BigInt(options.fromBlock);
  const toBlock = options.toBlock ? BigInt(options.toBlock) : "latest";

  const [published, upgraded, metadata, paused, unpaused, deprecated] = await Promise.all([
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappPublishedEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappUpgradedEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappMetadataEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappPausedEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappUnpausedEvent, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappDeprecatedEvent, fromBlock, toBlock })
  ]);

  const allLogs = [...published, ...upgraded, ...metadata, ...paused, ...unpaused, ...deprecated].sort(
    (a, b) => {
      const blockDiff = Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n));
      if (blockDiff !== 0) return blockDiff;
      return Number((a.logIndex ?? 0n) - (b.logIndex ?? 0n));
    }
  );

  type Version = {
    versionId: bigint;
    rootCid?: string;
    name?: string;
    version?: string;
    description?: string;
    status?: string;
  };
  type Dapp = { dappId: bigint; latestVersionId: bigint; versions: Map<string, Version> };

  const dapps = new Map<string, Dapp>();

  const getVersion = (dappId: bigint, versionId: bigint) => {
    const key = dappId.toString();
    const dapp = dapps.get(key) ?? {
      dappId,
      latestVersionId: 0n,
      versions: new Map()
    };
    const vKey = versionId.toString();
    const version = dapp.versions.get(vKey) ?? { versionId };
    dapp.versions.set(vKey, version);
    dapps.set(key, dapp);
    return { dapp, version };
  };

  for (const log of allLogs) {
    const args = requireArgs<DappLogArgs>(log, log.eventName ?? "DappEvent");
    if (log.eventName === "DappPublished") {
      const dappId = args.dappId;
      const versionId = args.versionId ?? 0n;
      const { dapp, version } = getVersion(dappId, versionId);
      version.rootCid = args.rootCid as string;
      version.status = "Published";
      dapp.latestVersionId = versionId;
    } else if (log.eventName === "DappUpgraded") {
      const dappId = args.dappId;
      const versionId = args.toVersionId ?? 0n;
      const { dapp, version } = getVersion(dappId, versionId);
      version.rootCid = args.rootCid as string;
      version.status = "Published";
      dapp.latestVersionId = versionId;
    } else if (log.eventName === "DappMetadata") {
      const { version } = getVersion(args.dappId, args.versionId ?? 0n);
      version.name = args.name;
      version.version = args.version;
      version.description = args.description;
    } else if (log.eventName === "DappPaused") {
      const { version } = getVersion(args.dappId, args.versionId ?? 0n);
      version.status = "Paused";
    } else if (log.eventName === "DappUnpaused") {
      const { version } = getVersion(args.dappId, args.versionId ?? 0n);
      version.status = "Published";
    } else if (log.eventName === "DappDeprecated") {
      const { version } = getVersion(args.dappId, args.versionId ?? 0n);
      version.status = "Deprecated";
    }
  }

  const result = Array.from(dapps.values()).map((dapp) => {
    const latest = dapp.versions.get(dapp.latestVersionId.toString());
    return {
      dappId: dapp.dappId.toString(),
      versionId: dapp.latestVersionId.toString(),
      name: latest?.name ?? "",
      version: latest?.version ?? "",
      description: latest?.description ?? "",
      status: latest?.status ?? "Unknown",
      rootCid: latest?.rootCid ?? ""
    };
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  for (const dapp of result) {
    console.log(`#${dapp.dappId} v${dapp.versionId} ${dapp.name} (${dapp.version}) ${dapp.status}`);
    if (dapp.rootCid) console.log(`  rootCid: ${dapp.rootCid}`);
    if (dapp.description) console.log(`  ${dapp.description}`);
  }
});

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
