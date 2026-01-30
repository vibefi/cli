import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decodeEventLog, type Hex } from "viem";
import governorAbi from "../src/abis/VfiGovernor.json";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const contractsDir = path.join(repoRoot, "contracts");
const cliDir = path.join(repoRoot, "cli");
const devnetJson = path.join(contractsDir, ".devnet", "devnet.json");
const anvilPort = process.env.ANVIL_PORT ?? "8546";
const rpcUrl = `http://127.0.0.1:${anvilPort}`;

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
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })
      });
      if (res.ok) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function getCode(address: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] })
  });
  const json = (await res.json()) as { result?: string };
  return json.result ?? "0x";
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

async function waitForReceipt(txHash: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [txHash]
        })
      });
      if (res.ok) {
        const json = (await res.json()) as { result?: { logs?: Array<{ address: string; topics: string[]; data: string }> } };
        if (json.result) return json.result;
      }
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function main() {
  logSection("Start devnet");
  let devnetProc: ReturnType<typeof spawn> | null = null;
  const rpcAlreadyUp = await waitForRpc(2000);
  if (!rpcAlreadyUp) {
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

  const mnemonic = process.env.MNEMONIC ?? "test test test test test test test test test test test junk";
  const hasContracts = await ensureContractsDeployed();
  if (!hasContracts) {
    logSection("Deploy contracts");
    await deployContracts(mnemonic);
  }

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

  logSection("Propose dapp");
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
      "hello",
      "--name",
      "Hello",
      "--dapp-version",
      "0.1.0",
      "--description",
      "Test",
      "--proposal-description",
      "E2E proposal",
      "--json"
    ],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("dapp:propose failed");
  const proposeJson = JSON.parse(result.stdout || "{}") as { txHash?: string };
  if (!proposeJson.txHash) throw new Error("Missing txHash from dapp:propose");

  logSection("Mine block");
  result = await runCmd("cast", ["rpc", "anvil_mine", "1", "--rpc-url", rpcUrl], {
    cwd: repoRoot,
    capture: true
  });
  if (result.code !== 0) throw new Error("anvil_mine failed");

  logSection("Fetch proposal id");
  const devnet = JSON.parse(fs.readFileSync(devnetJson, "utf-8")) as DevnetConfig;
  const receipt = await waitForReceipt(proposeJson.txHash, 15000);
  if (!receipt) throw new Error("Transaction receipt not found for proposal");
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

  logSection("Vote status");
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "vote:status", proposalId, "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("vote:status failed");

  logSection("Dapp list");
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "dapp:list", "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("dapp:list failed");

  devnetProc?.kill("SIGTERM");
  console.log("\nE2E test completed successfully.");
}

main().catch((err) => {
  console.error("E2E test failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
