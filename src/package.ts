import fs from "node:fs";
import path from "node:path";
import { getAddress, isHex, keccak256, toBytes } from "viem";

export type PackageOptions = {
  path: string;
  outDir?: string;
  name: string;
  version: string;
  description: string;
  constraintsPath?: string;
  emitManifest?: boolean;
  ipfs?: boolean;
  ipfsApi?: string;
};

type Constraints = {
  allowedDependencies: Record<string, string>;
  allowedDevDependencies: Record<string, string>;
  allowedTopLevel: string[];
  allowedSrcExtensions: string[];
  allowedAssetExtensions: string[];
  allowedAbiExtensions: string[];
  forbiddenPatterns: string[];
  maxRootCidBytes: number;
};

type ManifestFile = {
  path: string;
  bytes: number;
};

export type PackageResult = {
  rootCid: string;
  outDir: string;
  manifest: Record<string, unknown>;
  ipfsApi?: string;
};

const DEFAULT_CONSTRAINTS: Constraints = {
  allowedDependencies: {
    react: "19.2.4",
    "react-dom": "19.2.4",
    wagmi: "3.4.1",
    viem: "2.45.0",
    shadcn: "3.7.0"
  },
  allowedDevDependencies: {
    "@vitejs/plugin-react": "5.1.2",
    typescript: "5.9.3",
    vite: "7.2.4"
  },
  allowedTopLevel: [
    "src",
    "assets",
    "abis",
    "addresses.json",
    "index.html",
    "package.json",
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.node.json"
  ],
  allowedSrcExtensions: [".ts", ".tsx"],
  allowedAssetExtensions: [".webp"],
  allowedAbiExtensions: [".json"],
  forbiddenPatterns: [
    "fetch(",
    "XMLHttpRequest",
    "WebSocket",
    "import(\"http",
    "import('http",
    "http://",
    "https://"
  ],
  maxRootCidBytes: 4096
};

function loadConstraints(constraintsPath?: string): Constraints {
  if (!constraintsPath) return DEFAULT_CONSTRAINTS;
  const raw = fs.readFileSync(constraintsPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<Constraints>;
  return {
    ...DEFAULT_CONSTRAINTS,
    ...parsed,
    allowedDependencies: { ...DEFAULT_CONSTRAINTS.allowedDependencies, ...parsed.allowedDependencies },
    allowedDevDependencies: { ...DEFAULT_CONSTRAINTS.allowedDevDependencies, ...parsed.allowedDevDependencies }
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function walkFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function relativeTo(root: string, fullPath: string) {
  return path.relative(root, fullPath).replace(/\\/g, "/");
}

function validateTopLevel(baseDir: string, constraints: Constraints) {
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!constraints.allowedTopLevel.includes(entry.name)) {
      throw new Error(`Unexpected top-level entry: ${entry.name}`);
    }
  }

  for (const required of ["src", "assets", "abis", "addresses.json", "index.html", "package.json"]) {
    const full = path.join(baseDir, required);
    if (!fs.existsSync(full)) {
      throw new Error(`Missing required entry: ${required}`);
    }
  }
}

function validatePackageJson(baseDir: string, constraints: Constraints) {
  const pkgPath = path.join(baseDir, "package.json");
  const pkg = readJsonFile(pkgPath) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
    throw new Error("package.json scripts are not allowed in bundled dapps");
  }

  const deps = pkg.dependencies ?? {};
  for (const [name, version] of Object.entries(deps)) {
    const allowed = constraints.allowedDependencies[name];
    if (!allowed) {
      throw new Error(`Dependency not allowed: ${name}`);
    }
    if (allowed !== version) {
      throw new Error(`Dependency ${name} must be pinned to ${allowed}`);
    }
  }

  const devDeps = pkg.devDependencies ?? {};
  for (const [name, version] of Object.entries(devDeps)) {
    const allowed = constraints.allowedDevDependencies[name];
    if (!allowed) {
      throw new Error(`Dev dependency not allowed: ${name}`);
    }
    if (allowed !== version) {
      throw new Error(`Dev dependency ${name} must be pinned to ${allowed}`);
    }
  }
}

function validateFiles(baseDir: string, constraints: Constraints) {
  const srcDir = path.join(baseDir, "src");
  const assetDir = path.join(baseDir, "assets");
  const abiDir = path.join(baseDir, "abis");
  const files = walkFiles(baseDir);
  for (const file of files) {
    const rel = relativeTo(baseDir, file);
    if (rel.startsWith("src/")) {
      if (!constraints.allowedSrcExtensions.includes(path.extname(file))) {
        throw new Error(`Invalid source extension: ${rel}`);
      }
      const content = fs.readFileSync(file, "utf-8");
      for (const pattern of constraints.forbiddenPatterns) {
        if (content.includes(pattern)) {
          throw new Error(`Forbidden pattern in ${rel}: ${pattern}`);
        }
      }
    } else if (rel.startsWith("assets/")) {
      if (!constraints.allowedAssetExtensions.includes(path.extname(file))) {
        throw new Error(`Invalid asset extension: ${rel}`);
      }
    } else if (rel.startsWith("abis/")) {
      if (!constraints.allowedAbiExtensions.includes(path.extname(file))) {
        throw new Error(`Invalid ABI extension: ${rel}`);
      }
      readJsonFile(file);
    } else if (rel === "addresses.json") {
      const data = readJsonFile(file);
      validateAddresses(data, "addresses.json");
    } else if (rel === "index.html") {
      const content = fs.readFileSync(file, "utf-8");
      for (const pattern of constraints.forbiddenPatterns) {
        if (content.includes(pattern)) {
          throw new Error(`Forbidden pattern in ${rel}: ${pattern}`);
        }
      }
    } else if (rel === "package.json") {
      // validated separately
    } else if (rel === "vite.config.ts" || rel.startsWith("tsconfig")) {
      // allowed but not bundled
    } else {
      const allowed = [srcDir, assetDir, abiDir].some((dir) => file.startsWith(dir));
      if (!allowed) {
        throw new Error(`Unexpected file: ${rel}`);
      }
    }
  }
}

function validateAddresses(value: unknown, context: string) {
  if (typeof value === "string") {
    if (!isHex(value)) {
      throw new Error(`Invalid address string in ${context}: ${value}`);
    }
    try {
      getAddress(value);
    } catch {
      throw new Error(`Invalid address checksum in ${context}: ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateAddresses(entry, `${context}[${index}]`));
    return;
  }
  if (typeof value === "number") {
    // Allow numeric metadata fields (e.g. chainId).
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      validateAddresses(entry, `${context}.${key}`);
    }
    return;
  }
  throw new Error(`Invalid addresses.json structure at ${context}`);
}

function readJsonFile(filePath: string): unknown {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse JSON in ${filePath}: ${message}`);
  }
}

function collectBundleFiles(baseDir: string) {
  const bundlePaths = ["src", "assets", "abis", "addresses.json", "index.html"];
  const files: string[] = [];
  for (const entry of bundlePaths) {
    const full = path.join(baseDir, entry);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) {
      files.push(...walkFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

function writeBundle(baseDir: string, outDir: string, files: string[]) {
  ensureDir(outDir);
  for (const file of files) {
    const rel = relativeTo(baseDir, file);
    const dest = path.join(outDir, rel);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(file, dest);
  }
}

async function publishToIpfs(outDir: string, ipfsApi: string): Promise<string> {
  const form = new FormData();
  const files = walkFiles(outDir);
  for (const file of files) {
    const rel = relativeTo(outDir, file);
    const data = fs.readFileSync(file);
    form.append("file", new Blob([data]), rel);
  }

  const url = new URL("/api/v0/add", ipfsApi);
  url.searchParams.set("recursive", "true");
  url.searchParams.set("wrap-with-directory", "true");
  url.searchParams.set("cid-version", "1");
  url.searchParams.set("pin", "true");

  const response = await fetch(url.toString(), { method: "POST", body: form });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`IPFS add failed: ${response.status} ${text}`);
  }
  const body = await response.text();
  const lines = body.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    throw new Error("IPFS add returned empty response");
  }
  const last = JSON.parse(lines[lines.length - 1]) as { Hash?: string; Cid?: { "/": string } };
  const cid = last.Hash ?? last.Cid?.["/"];
  if (!cid) {
    throw new Error("IPFS add response missing CID");
  }
  return cid;
}

export async function packageDapp(options: PackageOptions): Promise<PackageResult> {
  const baseDir = path.resolve(options.path);
  if (!fs.existsSync(baseDir)) {
    throw new Error(`Path does not exist: ${baseDir}`);
  }

  const constraints = loadConstraints(options.constraintsPath);
  validateTopLevel(baseDir, constraints);
  validatePackageJson(baseDir, constraints);
  validateFiles(baseDir, constraints);

  const bundleFiles = collectBundleFiles(baseDir);
  const manifestFiles: ManifestFile[] = bundleFiles
    .map((file) => {
      const content = fs.readFileSync(file);
      return {
        path: relativeTo(baseDir, file),
        bytes: content.length
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    name: options.name,
    version: options.version,
    description: options.description,
    createdAt: new Date().toISOString(),
    constraints: {
      type: "default",
      allowedDependencies: constraints.allowedDependencies,
      allowedDevDependencies: constraints.allowedDevDependencies
    },
    entry: "index.html",
    files: manifestFiles
  };

  const outDir = options.outDir
    ? path.resolve(options.outDir)
    : path.join(baseDir, ".vibefi", "bundle", `${options.name}-${options.version}`);
  writeBundle(baseDir, outDir, bundleFiles);
  if (options.emitManifest !== false) {
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }

  if (options.ipfs !== false) {
    const ipfsApi = options.ipfsApi ?? "http://127.0.0.1:5001";
    const rootCid = await publishToIpfs(outDir, ipfsApi);
    if (toBytes(rootCid).length > constraints.maxRootCidBytes) {
      throw new Error(`rootCid exceeds ${constraints.maxRootCidBytes} bytes`);
    }
    return { rootCid, outDir, manifest, ipfsApi };
  }

  const manifestJson = stableStringify(manifest);
  const rootCid = keccak256(toBytes(manifestJson));
  if (toBytes(rootCid).length > constraints.maxRootCidBytes) {
    throw new Error(`rootCid exceeds ${constraints.maxRootCidBytes} bytes`);
  }
  return { rootCid, outDir, manifest };
}
