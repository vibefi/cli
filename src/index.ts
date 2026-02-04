#!/usr/bin/env bun
import { Command } from "commander";
import path from "node:path";
import {
  bytesToHex,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  getAddress,
  hexToString,
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
import { packageDapp } from "./package";
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
import { computeIpfsCid, downloadDappBundle, fetchDappManifest } from "./ipfs";

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
  if (lower === normalizeAddress(devnet.developer).toLowerCase()) return "developer";
  if (lower === normalizeAddress(devnet.voter1).toLowerCase()) return "voter1";
  if (lower === normalizeAddress(devnet.voter2).toLowerCase()) return "voter2";
  if (lower === normalizeAddress(devnet.securityCouncil1).toLowerCase()) return "securityCouncil1";
  if (devnet.securityCouncil2 && lower === normalizeAddress(devnet.securityCouncil2).toLowerCase()) {
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

function toJson(value: unknown) {
  return JSON.stringify(
    value,
    (_key, val) => (typeof val === "bigint" ? val.toString() : val),
    2
  );
}

type DecodedLog = {
  address: string;
  event: string;
  contract?: string;
  args?: unknown;
  data?: Hex;
  topics?: Hex[];
};

async function fetchTxLogs(
  ctx: ReturnType<typeof loadContext>,
  txHash: Hex
) {
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  const logs = receipt.logs ?? [];
  const decodedLogs: DecodedLog[] = logs.map((log) => {
    const address = log.address.toLowerCase();
    const matchGovernor = ctx.contracts.vfiGovernor && address === ctx.contracts.vfiGovernor.toLowerCase();
    const matchRegistry = ctx.contracts.dappRegistry && address === ctx.contracts.dappRegistry.toLowerCase();
    const matchToken = ctx.contracts.vfiToken && address === ctx.contracts.vfiToken.toLowerCase();

    if (matchGovernor) {
      try {
        const decoded = decodeEventLog({
          abi: governorAbi,
          data: log.data,
          topics: log.topics
        }) as { eventName: string; args: unknown };
        return { address: log.address, contract: "VfiGovernor", event: decoded.eventName, args: decoded.args };
      } catch {
        // fallthrough
      }
    }

    if (matchRegistry) {
      try {
        const decoded = decodeEventLog({
          abi: dappRegistryAbi,
          data: log.data,
          topics: log.topics
        }) as { eventName: string; args: unknown };
        return { address: log.address, contract: "DappRegistry", event: decoded.eventName, args: decoded.args };
      } catch {
        // fallthrough
      }
    }

    if (matchToken) {
      try {
        const decoded = decodeEventLog({
          abi: vfiTokenAbi,
          data: log.data,
          topics: log.topics
        }) as { eventName: string; args: unknown };
        return { address: log.address, contract: "VfiToken", event: decoded.eventName, args: decoded.args };
      } catch {
        // fallthrough
      }
    }

    return { address: log.address, event: "Unknown", data: log.data, topics: log.topics };
  });

  return decodedLogs;
}

function printDecodedLogs(label: string, txHash: Hex, logs: DecodedLog[]) {
  console.log(`Logs for ${label}: ${txHash}`);
  for (const entry of logs) {
    if (entry.event === "Unknown") {
      console.log(`  ${entry.address} ${entry.event} data=${entry.data}`);
    } else {
      console.log(`  ${entry.contract}::${entry.event}`);
      console.log(`    ${toJson(entry.args)}`);
    }
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

function requireArgs<T>(log: { args?: T } | undefined, label: string): T {
  if (!log?.args) {
    throw new Error(`Missing log args for ${label}`);
  }
  return log.args as T;
}

async function getProposalCreatedArgs(
  ctx: ReturnType<typeof loadContext>,
  proposalId: string,
  fromBlock: bigint,
  toBlock?: bigint
) {
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  const logs = await ctx.publicClient.getLogs({
    address: governor as Hex,
    event: proposalCreatedEvent as any,
    fromBlock,
    toBlock: toBlock ?? "latest"
  });

  const target = (logs as any[]).find((log) => {
    const args = log.args as ProposalCreatedArgs | undefined;
    return args?.proposalId?.toString() === proposalId;
  });
  if (!target) throw new Error(`Proposal ${proposalId} not found in logs.`);

  return requireArgs<ProposalCreatedArgs>(target as { args?: ProposalCreatedArgs }, "ProposalCreated");
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

program
  .command("package")
  .description("Package a local dapp into a deterministic bundle")
  .requiredOption("--name <name>", "Dapp name")
  .requiredOption("--dapp-version <version>", "Dapp version string")
  .requiredOption("--description <text>", "Dapp description")
  .option("--path <dir>", "Path to dapp directory", ".")
  .option("--out <dir>", "Output directory for bundle")
  .option("--constraints <path>", "Path to constraints JSON override")
  .option("--ipfs-api <url>", "IPFS API URL", "http://127.0.0.1:5001")
  .option("--no-ipfs", "Skip IPFS publish and return a deterministic hash")
  .option("--no-emit-manifest", "Do not write manifest.json to output")
  .option("--json", "Output JSON")
  .action(async (options) => {
    const result = await packageDapp({
      path: options.path,
      outDir: options.out,
      name: options.name,
      version: options.dappVersion,
      description: options.description,
      constraintsPath: options.constraints,
      emitManifest: options.emitManifest,
      ipfs: options.ipfs,
      ipfsApi: options.ipfsApi
    });

    const output = {
      rootCid: result.rootCid,
      outDir: result.outDir,
      manifest: result.manifest,
      ipfsApi: result.ipfsApi
    };

    if (options.json) {
      console.log(toJson(output));
      return;
    }

    console.log(`rootCid: ${result.rootCid}`);
    console.log(`bundle: ${result.outDir}`);
  });

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
    event: proposalCreatedEvent as any,
    fromBlock,
    toBlock: toBlock ?? "latest"
  });

  const proposals = await Promise.all(
    (logs as any[]).map(async (log) => {
      const args = requireArgs<ProposalCreatedArgs>(log as { args?: ProposalCreatedArgs }, "ProposalCreated");
      const proposalId = args.proposalId;
      const state = await ctx.publicClient.readContract({
        address: governor as Hex,
        abi: governorAbi,
        functionName: "state",
        args: [proposalId]
      }) as bigint;
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
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  const args = await getProposalCreatedArgs(
    ctx,
    proposalId,
    BigInt(options.fromBlock),
    options.toBlock ? BigInt(options.toBlock) : undefined
  );
  const state = await ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "state",
    args: [BigInt(proposalId)]
  }) as bigint;

  const snapshot = await ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "proposalSnapshot",
    args: [BigInt(proposalId)]
  }) as bigint;

  const deadline = await ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "proposalDeadline",
    args: [BigInt(proposalId)]
  }) as bigint;

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
    .description("Queue a governance proposal")
    .argument("<proposalId>", "Proposal id")
    .option("--from-block <number>", "Start block", "0")
    .option("--to-block <number>", "End block")
).action(async (proposalId, options) => {
  const ctx = loadContext(options);
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  const args = await getProposalCreatedArgs(
    ctx,
    proposalId,
    BigInt(options.fromBlock),
    options.toBlock ? BigInt(options.toBlock) : undefined
  );
  const descriptionHash = keccak256(toBytes(args.description as string));

  let warning: string | undefined;
  try {
    const state = await ctx.publicClient.readContract({
      address: governor as Hex,
      abi: governorAbi,
      functionName: "state",
      args: [BigInt(proposalId)]
    }) as bigint;
    const stateName = proposalStateNames[Number(state)] ?? String(state);
    if (stateName !== "Succeeded") {
      warning = `Proposal state is ${stateName}, expected Succeeded.`;
    }
  } catch {
    warning = "Failed to read proposal state.";
  }

  const wallet = getWalletContext(ctx, options);
  const hash = await wallet.walletClient.writeContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "queue",
    args: [args.targets, args.values, args.calldatas, descriptionHash]
  });

  const logs = await fetchTxLogs(ctx, hash);
  if (options.json) {
    console.log(toJson({ txHash: hash, logs, warning }));
    return;
  }
  if (warning) console.warn(`Warning: ${warning}`);
  console.log(`Proposal queued: ${hash}`);
  printDecodedLogs("proposals:queue", hash, logs);
});

withCommonOptions(
  program
    .command("proposals:execute")
    .description("Execute a queued governance proposal")
    .argument("<proposalId>", "Proposal id")
    .option("--from-block <number>", "Start block", "0")
    .option("--to-block <number>", "End block")
).action(async (proposalId, options) => {
  const ctx = loadContext(options);
  const governor = ctx.contracts.vfiGovernor;
  if (!governor) throw new Error("Missing vfiGovernor address in config/devnet.");

  const args = await getProposalCreatedArgs(
    ctx,
    proposalId,
    BigInt(options.fromBlock),
    options.toBlock ? BigInt(options.toBlock) : undefined
  );
  const descriptionHash = keccak256(toBytes(args.description as string));

  let warning: string | undefined;
  try {
    const state = await ctx.publicClient.readContract({
      address: governor as Hex,
      abi: governorAbi,
      functionName: "state",
      args: [BigInt(proposalId)]
    }) as bigint;
    const stateName = proposalStateNames[Number(state)] ?? String(state);
    if (stateName !== "Queued") {
      warning = `Proposal state is ${stateName}, expected Queued.`;
    }
  } catch {
    warning = "Failed to read proposal state.";
  }

  const totalValue = args.values.reduce((acc, value) => acc + value, 0n);
  const wallet = getWalletContext(ctx, options);
  const hash = await wallet.walletClient.writeContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "execute",
    args: [args.targets, args.values, args.calldatas, descriptionHash],
    ...(totalValue > 0n ? { value: totalValue } : {})
  });

  const logs = await fetchTxLogs(ctx, hash);
  if (options.json) {
    console.log(toJson({ txHash: hash, logs, warning }));
    return;
  }
  if (warning) console.warn(`Warning: ${warning}`);
  console.log(`Proposal executed: ${hash}`);
  printDecodedLogs("proposals:execute", hash, logs);
});

withCommonOptions(
  program
    .command("dapp:propose")
    .description("Propose publishing a new dapp")
    .requiredOption("--root-cid <value>", "Root CID (hex 0x... or string)")
    .requiredOption("--name <name>", "Dapp name")
    .requiredOption("--dapp-version <version>", "Dapp version string")
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
    args: [rootCid, options.name, options.dappVersion, options.description]
  });

  const description =
    options.proposalDescription ?? `Publish dapp ${options.name} ${options.dappVersion}`;

  const hash = await wallet.walletClient.writeContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "propose",
    args: [[dappRegistry as Hex], [0n], [calldata], description]
  });

  const logs = await fetchTxLogs(ctx, hash);
  if (options.json) {
    console.log(toJson({ txHash: hash, logs }));
    return;
  }
  console.log(`Proposal submitted: ${hash}`);
  printDecodedLogs("dapp:propose", hash, logs);
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

  const logs = await fetchTxLogs(ctx, hash);
  if (options.json) {
    console.log(toJson({ txHash: hash, logs }));
    return;
  }
  console.log(`Vote submitted: ${hash}`);
  printDecodedLogs("vote:cast", hash, logs);
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
  }) as bigint;

  const votes = await ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "proposalVotes",
    args: [BigInt(proposalId)]
  }) as readonly [bigint, bigint, bigint];

  const quorum = await ctx.publicClient.readContract({
    address: governor as Hex,
    abi: governorAbi,
    functionName: "quorum",
    args: [snapshot]
  }) as bigint;

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
  const args = await getProposalCreatedArgs(
    ctx,
    proposalId,
    BigInt(options.fromBlock),
    options.toBlock ? BigInt(options.toBlock) : undefined
  );
  const descriptionHash = keccak256(toBytes(args.description as string));

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
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappPublishedEvent as any, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappUpgradedEvent as any, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappMetadataEvent as any, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappPausedEvent as any, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappUnpausedEvent as any, fromBlock, toBlock }),
    ctx.publicClient.getLogs({ address: dappRegistry as Hex, event: dappDeprecatedEvent as any, fromBlock, toBlock })
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

  for (const log of allLogs as any[]) {
    const args = requireArgs<DappLogArgs>(log as { args?: DappLogArgs }, log.eventName ?? "DappEvent");
    if (log.eventName === "DappPublished") {
      const dappId = args.dappId;
      const versionId = args.versionId ?? 0n;
      const { dapp, version } = getVersion(dappId, versionId);
      version.rootCid = new TextDecoder().decode(toBytes(args.rootCid as Hex));
      version.status = "Published";
      dapp.latestVersionId = versionId;
    } else if (log.eventName === "DappUpgraded") {
      const dappId = args.dappId;
      const versionId = args.toVersionId ?? 0n;
      const { dapp, version } = getVersion(dappId, versionId);
      version.rootCid = new TextDecoder().decode(toBytes(args.rootCid as Hex));
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
    console.log(toJson(result));
    return;
  }

  for (const dapp of result) {
    console.log(`#${dapp.dappId} v${dapp.versionId} ${dapp.name} (${dapp.version}) ${dapp.status}`);
    if (dapp.rootCid) console.log(`  rootCid: ${dapp.rootCid}`);
    if (dapp.description) console.log(`  ${dapp.description}`);
  }
});

program
  .command("dapp:fetch")
  .description("Download a published dapp bundle from IPFS")
  .requiredOption("--root-cid <cid>", "Root CID")
  .option("--out <dir>", "Output directory", ".vibefi/cache")
  .option("--ipfs-api <url>", "IPFS API URL", "http://127.0.0.1:5001")
  .option("--ipfs-gateway <url>", "IPFS gateway URL", "http://127.0.0.1:8080")
  .option("--no-verify", "Skip CID verification")
  .option("--json", "Output JSON")
  .action(async (options) => {
    const inputRootCid = options.rootCid as string;
    const decodedRootCid = isHex(inputRootCid)
      ? hexToString(inputRootCid as Hex).replace(/\0+$/g, "")
      : inputRootCid;
    const outDir = path.resolve(options.out);
    const manifest = await fetchDappManifest(decodedRootCid, options.ipfsGateway);
    await downloadDappBundle(decodedRootCid, outDir, options.ipfsGateway, manifest);

    let computedCid: string | undefined;
    let verified: boolean | undefined;
    if (options.verify !== false) {
      computedCid = await computeIpfsCid(outDir, options.ipfsApi);
      verified = computedCid === decodedRootCid;
      if (!verified) {
        throw new Error(`CID mismatch: expected ${decodedRootCid} got ${computedCid}`);
      }
    }

    const output = {
      rootCid: decodedRootCid,
      outDir,
      ipfsApi: options.ipfsApi,
      ipfsGateway: options.ipfsGateway,
      verified,
      computedCid
    };
    if (options.json) {
      console.log(toJson(output));
      return;
    }
    console.log(`Fetched ${options.rootCid} to ${outDir}`);
    if (verified) {
      console.log(`Verified CID: ${computedCid}`);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
