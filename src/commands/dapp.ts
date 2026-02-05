import path from "node:path";
import { Command } from "commander";
import { hexToString, isHex, type Hex } from "viem";
import { governorAbi } from "../abi";
import { computeIpfsCid, downloadDappBundle, fetchDappManifest } from "../ipfs";
import {
  encodeProposeCalldata,
  encodeRootCid,
  fetchDappLogs,
  fetchTxLogs,
  getDappRegistryAddress,
  getGovernorAddress,
  getWalletContext,
  loadContext,
  printDecodedLogs,
  requireArgs,
  toJson,
  withCommonOptions,
  type DappLogArgs
} from "./shared";

export function registerDapp(program: Command) {
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
    const governor = getGovernorAddress(ctx);
    const dappRegistry = getDappRegistryAddress(ctx);

    const wallet = getWalletContext(ctx, options);

    const rootCid = encodeRootCid(options.rootCid as string);

    const calldata = encodeProposeCalldata(
      rootCid,
      options.name,
      options.dappVersion,
      options.description
    );

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
      .command("dapp:list")
      .description("List dapps with latest version and status")
      .option("--from-block <number>", "Start block", "0")
      .option("--to-block <number>", "End block")
  ).action(async (options) => {
    const ctx = loadContext(options);

    const allLogs = await fetchDappLogs(ctx, {
      fromBlock: options.fromBlock,
      toBlock: options.toBlock
    });

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
}
