import { Command } from "commander";
import { packageDapp } from "../package";
import { toJson } from "./shared";

export function registerPackage(program: Command) {
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
}
