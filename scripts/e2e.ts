import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const contractsDir = path.join(repoRoot, "contracts");
const cliDir = path.join(repoRoot, "cli");
const devnetJson = path.join(contractsDir, ".devnet", "devnet.json");
const anvilPort = process.env.ANVIL_PORT ?? "8546";
const rpcUrl = `http://127.0.0.1:${anvilPort}`;

function logSection(title: string) {
  console.log("\n=== " + title + " ===");
}

function runCmd(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean } = {}) {
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
        process.stdout.write(chunk);
      });
      child.stderr?.on("data", (data) => {
        process.stderr.write(data.toString());
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

async function main() {
  logSection("Start devnet");
  const devnetProc = spawn("./script/local-devnet.sh", [], {
    cwd: contractsDir,
    env: { ...process.env, ANVIL_PORT: anvilPort },
    stdio: "inherit"
  });

  const rpcReady = await waitForRpc(15000);
  if (!rpcReady) {
    devnetProc.kill("SIGTERM");
    throw new Error(`RPC not ready at ${rpcUrl}`);
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

  logSection("Mine block");
  result = await runCmd("cast", ["rpc", "anvil_mine", "1", "--rpc-url", rpcUrl], {
    cwd: repoRoot,
    capture: true
  });
  if (result.code !== 0) throw new Error("anvil_mine failed");

  logSection("Fetch proposal id");
  result = await runCmd(
    "bun",
    ["run", "src/index.ts", "proposals:list", "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
    { cwd: cliDir, capture: true }
  );
  if (result.code !== 0) throw new Error("proposals:list failed");
  const proposals = JSON.parse(result.stdout || "[]") as Array<{ proposalId: string }>;
  if (!proposals.length) throw new Error("No proposals found");
  const proposalId = proposals[proposals.length - 1].proposalId;
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

  devnetProc.kill("SIGTERM");
  console.log("\nE2E test completed successfully.");
}

main().catch((err) => {
  console.error("E2E test failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
