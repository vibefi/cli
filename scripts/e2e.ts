import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Hex
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import governorAbi from "../src/abis/VfiGovernor.json";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const contractsDir = path.join(repoRoot, "contracts");
const cliDir = path.join(repoRoot, "cli");
const devnetJson = path.join(contractsDir, ".devnet", "devnet.json");
const ipfsApi = process.env.IPFS_API ?? "http://127.0.0.1:5001";
const ipfsGateway = process.env.IPFS_GATEWAY ?? "http://127.0.0.1:8080";
const anvilPort = process.env.ANVIL_PORT ?? "8546";
const rpcUrl = `http://127.0.0.1:${anvilPort}`;
const publicClient = createPublicClient({ transport: http(rpcUrl) });

type DevnetConfig = {
  vfiGovernor: string;
};

function logSection(title: string) {
  console.log("\n=== " + title + " ===");
}

function runCmd(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; stream?: boolean } = {}
) {
  return new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });

    let stdout = "";
    if (options.capture) {
      child.stdout?.on("data", (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (options.stream !== false) {
          process.stdout.write(chunk);
        }
      });
      child.stderr?.on("data", (data) => {
        if (options.stream !== false) {
          process.stderr.write(data.toString());
        }
      });
    }

    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

async function waitForRpc(timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await publicClient.getChainId();
      return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function waitForIpfs(timeoutMs: number) {
  const start = Date.now();
  const url = new URL("/api/v0/version", ipfsApi);
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url.toString(), { method: "POST" });
      if (res.ok) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function getCode(address: string): Promise<string> {
  return publicClient.getBytecode({ address: address as Hex }).then((code) => code ?? "0x");
}

async function deriveKey(index: number, mnemonic: string): Promise<string> {
  const { code, stdout } = await runCmd(
    "cast",
    ["wallet", "private-key", "--mnemonic", mnemonic, "--mnemonic-index", String(index)],
    { cwd: repoRoot, capture: true, stream: false }
  );
  if (code !== 0) throw new Error(`Failed to derive key index ${index}`);
  return stdout.trim();
}

async function ensureContractsDeployed() {
  if (!fs.existsSync(devnetJson)) return false;
  const devnet = JSON.parse(fs.readFileSync(devnetJson, "utf-8")) as DevnetConfig;
  const code = await getCode(devnet.vfiGovernor);
  return code !== "0x";
}

async function deployContracts(mnemonic: string) {
  fs.mkdirSync(path.dirname(devnetJson), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FOUNDRY_PROFILE: "ci",
    RPC_URL: rpcUrl,
    OUTPUT_JSON: devnetJson,
    DEV_PRIVATE_KEY: await deriveKey(0, mnemonic),
    VOTER1_PRIVATE_KEY: await deriveKey(1, mnemonic),
    VOTER2_PRIVATE_KEY: await deriveKey(2, mnemonic),
    SECURITY_COUNCIL_1_PRIVATE_KEY: await deriveKey(3, mnemonic),
    SECURITY_COUNCIL_2_PRIVATE_KEY: await deriveKey(4, mnemonic),
    SECURITY_COUNCIL: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    INITIAL_SUPPLY: "1000000000000000000000000",
    VOTING_DELAY: "1",
    VOTING_PERIOD: "20",
    QUORUM_FRACTION: "4",
    TIMELOCK_DELAY: "1",
    MIN_PROPOSAL_BPS: "100",
    VOTER_ALLOCATION: "100000000000000000000000",
    COUNCIL_ALLOCATION: "50000000000000000000000"
  };

  const result = await runCmd(
    "forge",
    [
      "script",
      "script/LocalDevnet.s.sol:LocalDevnet",
      "--rpc-url",
      rpcUrl,
      "--private-key",
      env.DEV_PRIVATE_KEY as string,
      "--broadcast"
    ],
    { cwd: contractsDir, env, capture: true }
  );
  if (result.code !== 0) throw new Error("Contract deploy failed");
}

async function main() {
  logSection("Start devnet");
  let devnetProc: ReturnType<typeof spawn> | null = null;
  const rpcAlreadyUp = await waitForRpc(2000);
  if (!rpcAlreadyUp) {
    // Remove stale devnet JSON so we don't race with the background deploy.
    // forge script writes it during simulation (before broadcast), so an
    // old file would make ensureContractsDeployed return prematurely.
    fs.rmSync(devnetJson, { force: true });
    devnetProc = spawn("./script/local-devnet.sh", [], {
      cwd: contractsDir,
      env: { ...process.env, ANVIL_PORT: anvilPort },
      stdio: "inherit"
    });
  } else {
    console.log(`RPC already running at ${rpcUrl}, skipping devnet start.`);
  }

  const rpcReady = rpcAlreadyUp || (await waitForRpc(15000));
  if (!rpcReady) {
    devnetProc?.kill("SIGTERM");
    throw new Error(`RPC not ready at ${rpcUrl}`);
  }

  logSection("Check IPFS");
  const ipfsReady = await waitForIpfs(8000);
  if (!ipfsReady) {
    devnetProc?.kill("SIGTERM");
    throw new Error(`IPFS not ready at ${ipfsApi}. Start with docker compose.`);
  }

  const mnemonic = process.env.MNEMONIC ?? "test test test test test test test test test test test junk";
  const devAccount = mnemonicToAccount(mnemonic);
  const walletClient = createWalletClient({
    account: devAccount,
    transport: http(rpcUrl)
  });

  if (devnetProc) {
    // We started the devnet — wait for the background deploy to finish
    // rather than racing it with a second deployContracts call.
    logSection("Wait for contracts");
    const deployTimeout = 60000;
    const deployStart = Date.now();
    while (Date.now() - deployStart < deployTimeout) {
      if (await ensureContractsDeployed()) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!(await ensureContractsDeployed())) {
      devnetProc.kill("SIGTERM");
      throw new Error("Contracts not deployed after waiting for background devnet.");
    }
  } else if (!(await ensureContractsDeployed())) {
    logSection("Deploy contracts");
    await deployContracts(mnemonic);
  }

  logSection("Send sanity tx via viem");
  const sanityTxHash = await walletClient.sendTransaction({
    to: devAccount.address,
    value: 0n
  });
  await publicClient.waitForTransactionReceipt({ hash: sanityTxHash });

  logSection("CLI status");
  let result = await runCmd(
    "bun",
    ["run", "src/index.ts", "status", "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("status failed");

  logSection("List proposals");
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "proposals:list", "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("proposals:list failed");

  logSection("Package dapp");
  const dappDir = path.join(repoRoot, "dapp-examples", "uniswap-v2-example");

  result = await runCmd(
    "bun",
    [
      "run",
      "src/index.ts",
      "package",
      "--path",
      dappDir,
      "--name",
      "Uniswap V2",
      "--dapp-version",
      "0.0.1",
      "--description",
      "Uniswap V2 example",
      "--ipfs-api",
      ipfsApi,
      "--json"
    ],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("package failed");
  const packageJson = JSON.parse(result.stdout || "{}") as { rootCid?: string };
  if (!packageJson.rootCid) throw new Error("Missing rootCid from package");

  logSection("Propose dapp");
  const proposalDescription = `E2E proposal ${Date.now()}`;
  result = await runCmd(
    "bun",
    [
      "run",
      "src/index.ts",
      "dapp:propose",
      "--rpc",
      rpcUrl,
      "--devnet",
      devnetJson,
      "--root-cid",
      packageJson.rootCid,
      "--name",
      "Uniswap V2",
      "--dapp-version",
      "0.0.1",
      "--description",
      "Uniswap V2 example",
      "--proposal-description",
      proposalDescription,
      "--json"
    ],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("dapp:propose failed");
  const proposeJson = JSON.parse(result.stdout || "{}") as { txHash?: string };
  if (!proposeJson.txHash) throw new Error("Missing txHash from dapp:propose");

  logSection("Mine block");
  await publicClient.request({ method: "anvil_mine", params: [1] });

  logSection("Fetch proposal id");
  const devnet = JSON.parse(fs.readFileSync(devnetJson, "utf-8")) as DevnetConfig;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: proposeJson.txHash as Hex,
    timeout: 15000
  });
  const governorAddress = devnet.vfiGovernor.toLowerCase();
  const proposalLog = (receipt.logs ?? []).find((log) => log.address.toLowerCase() === governorAddress);
  if (!proposalLog) throw new Error("ProposalCreated log not found in receipt");
  const decoded = decodeEventLog({
    abi: governorAbi,
    data: proposalLog.data as Hex,
    topics: proposalLog.topics as Hex[]
  });
  const proposalId = (decoded.args as { proposalId: bigint }).proposalId.toString();
  console.log(`Using proposalId=${proposalId}`);

  logSection("Cast vote");
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "vote:cast", proposalId, "--support", "for", "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("vote:cast failed");

  logSection("Mine blocks for voting period");
  await publicClient.request({ method: "anvil_mine", params: [25] });

  logSection("Vote status");
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "vote:status", proposalId, "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("vote:status failed");

  logSection("Queue proposal");
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "proposals:queue", proposalId, "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("proposals:queue failed");
  const queueJson = JSON.parse(result.stdout || "{}") as { txHash?: string };
  if (!queueJson.txHash) throw new Error("Missing txHash from proposals:queue");

  logSection("Advance timelock");
  await publicClient.request({ method: "evm_increaseTime", params: [2] });
  await publicClient.request({ method: "anvil_mine", params: [1] });

  logSection("Execute proposal");
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "proposals:execute", proposalId, "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("proposals:execute failed");
  const executeJson = JSON.parse(result.stdout || "{}") as { txHash?: string };
  if (!executeJson.txHash) throw new Error("Missing txHash from proposals:execute");

  logSection("Dapp list");
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "dapp:list", "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("dapp:list failed");
  const dappList = JSON.parse(result.stdout || "[]") as Array<{ rootCid?: string }>;
  const latest = dappList[dappList.length - 1];
  if (!latest?.rootCid) throw new Error("Missing rootCid from dapp:list");

  logSection("Fetch dapp bundle");
  result = await runCmd(
    "bun",
    [
      "run",
      "src/index.ts",
      "dapp:fetch",
      "--root-cid",
      latest.rootCid,
      "--out",
      path.join(cliDir, ".vibefi", "cache", latest.rootCid),
      "--ipfs-api",
      ipfsApi,
      "--ipfs-gateway",
      ipfsGateway,
      "--json"
    ],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("dapp:fetch failed");

  devnetProc?.kill("SIGTERM");
  console.log("\nE2E test completed successfully.");
}

main().catch((err) => {
  console.error("E2E test failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
