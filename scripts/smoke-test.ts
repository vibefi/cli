import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const contractsDir = path.join(repoRoot, "contracts");
const cliDir = path.join(repoRoot, "cli");
const devnetJson = path.join(contractsDir, ".devnet", "devnet.json");
const anvilPort = process.env.ANVIL_PORT ?? "8545";
const rpcUrl = `http://127.0.0.1:${anvilPort}`;

function runCmd(command: string, args: string[], cwd?: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function waitForDevnet(timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(devnetJson)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  if (!fs.existsSync(path.join(contractsDir, "script", "local-devnet.sh"))) {
    throw new Error("contracts/script/local-devnet.sh not found");
  }

  fs.rmSync(devnetJson, { force: true });

  const devnetProc = spawn("./script/local-devnet.sh", [], {
    cwd: contractsDir,
    env: { ...process.env, ANVIL_PORT: anvilPort },
    stdio: "inherit"
  });

  const ready = await waitForDevnet(30000);
  if (!ready) {
    devnetProc.kill("SIGTERM");
    throw new Error(`devnet.json not found at ${devnetJson}`);
  }

  const commands: string[][] = [
    ["status"],
    ["proposals:list"],
    [
      "dapp:propose",
      "--root-cid",
      "hello",
      "--name",
      "Smoke",
      "--dapp-version",
      "0.1.0",
      "--description",
      "Smoke test",
      "--proposal-description",
      "Smoke test proposal"
    ]
  ];

  for (const cmd of commands) {
    const code = await runCmd(
      "bun",
      ["run", "src/index.ts", ...cmd, "--rpc", rpcUrl, "--devnet", devnetJson, "--json"],
      cliDir
    );
    if (code !== 0) {
      devnetProc.kill("SIGTERM");
      throw new Error(`CLI command failed: ${cmd[0]}`);
    }
  }

  devnetProc.kill("SIGTERM");
  console.log("CLI smoke test completed successfully.");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
