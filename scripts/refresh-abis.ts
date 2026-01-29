import fs from "node:fs";
import path from "node:path";

const REQUIRED_ARTIFACTS = ["VfiGovernor", "DappRegistry"]; // extend as needed

function findRepoRoot(start: string): string {
  let current = start;
  for (let i = 0; i < 6; i += 1) {
    const contractsDir = path.join(current, "contracts");
    if (fs.existsSync(contractsDir)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Could not locate repo root (expected ./contracts directory)");
}

function findArtifact(contractsOut: string, name: string): string {
  const matches: string[] = [];
  const stack = [contractsOut];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === `${name}.json`) {
        matches.push(full);
      }
    }
  }
  if (matches.length === 0) {
    throw new Error(`Artifact not found for ${name}. Expected in ${contractsOut}`);
  }
  if (matches.length > 1) {
    const preferred = matches.find((p) => p.includes(`/src/`));
    return preferred ?? matches[0];
  }
  return matches[0];
}

const cliDir = process.cwd();
const repoRoot = findRepoRoot(cliDir);
const contractsOut = path.join(repoRoot, "contracts", "out");

if (!fs.existsSync(contractsOut)) {
  throw new Error(`Contracts out directory not found at ${contractsOut}. Run forge build first.`);
}

const outDir = path.join(cliDir, "src", "abis");
fs.mkdirSync(outDir, { recursive: true });

for (const name of REQUIRED_ARTIFACTS) {
  const artifactPath = findArtifact(contractsOut, name);
  const artifactRaw = fs.readFileSync(artifactPath, "utf-8");
  const artifact = JSON.parse(artifactRaw);
  if (!artifact.abi) throw new Error(`ABI missing in artifact ${artifactPath}`);

  const dest = path.join(outDir, `${name}.json`);
  fs.writeFileSync(dest, JSON.stringify(artifact.abi, null, 2));
  console.log(`Wrote ${dest}`);
}

console.log("ABI refresh complete.");
