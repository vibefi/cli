import fs from "node:fs";
import path from "node:path";
import { getAddress, isHex, keccak256, toBytes } from "viem";
import {
  ensureDir,
  walkFiles,
  ipfsAdd,
  type ManifestCapabilities,
  validateManifestCapabilities
} from "@vibefi/shared";

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
  allowedSrcExtensions: string[];
  allowedAssetExtensions: string[];
  allowedAbiExtensions: string[];
  forbiddenPatterns: string[];
  maxRootCidBytes: number;
};

type BundleLayout = "constrained" | "static-html";

const STATIC_HTML_ALLOWED_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".json"
]);

type ManifestFile = {
  path: string;
  bytes: number;
};

type SourceManifest = {
  addresses: unknown;
  capabilities?: ManifestCapabilities;
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
    shadcn: "3.7.0",
    "@tanstack/react-query": "5.90.20"
  },
  allowedDevDependencies: {
    "@vitejs/plugin-react": "5.1.2",
    "@types/react": "19.2.4",
    typescript: "5.9.3",
    vite: "7.2.4"
  },
  allowedSrcExtensions: [".ts", ".tsx", ".css"],
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

function relativeTo(root: string, fullPath: string) {
  return path.relative(root, fullPath).replace(/\\/g, "/");
}

function hasRequiredEntries(baseDir: string, requiredDirs: string[], requiredFiles: string[]) {
  const missingDirs = requiredDirs.filter((entry) => {
    const full = path.join(baseDir, entry);
    return !fs.existsSync(full) || !fs.statSync(full).isDirectory();
  });
  const missingFiles = requiredFiles.filter((entry) => {
    const full = path.join(baseDir, entry);
    return !fs.existsSync(full) || !fs.statSync(full).isFile();
  });
  return { missingDirs, missingFiles };
}

function detectBundleLayout(baseDir: string): BundleLayout {
  const constrained = hasRequiredEntries(baseDir, ["src", "assets", "abis"], ["vibefi.json", "index.html", "package.json"]);
  if (constrained.missingDirs.length === 0 && constrained.missingFiles.length === 0) {
    return "constrained";
  }
  const staticHtml = hasRequiredEntries(baseDir, [], ["vibefi.json", "index.html"]);
  if (staticHtml.missingFiles.length === 0) {
    return "static-html";
  }
  throw new Error(
    "Unsupported dapp layout. Expected either constrained layout (src/, assets/, abis/, vibefi.json, index.html, package.json) or static-html layout (vibefi.json, index.html)."
  );
}

function validateConstrainedTopLevel(baseDir: string) {
  const requiredDirs = ["src", "assets", "abis"];
  for (const required of requiredDirs) {
    const full = path.join(baseDir, required);
    if (!fs.existsSync(full)) {
      throw new Error(`Missing required entry: ${required}`);
    }
    if (!fs.statSync(full).isDirectory()) {
      throw new Error(`Expected directory: ${required}`);
    }
  }

  const requiredFiles = ["vibefi.json", "index.html", "package.json"];
  for (const required of requiredFiles) {
    const full = path.join(baseDir, required);
    if (!fs.existsSync(full)) {
      throw new Error(`Missing required entry: ${required}`);
    }
    if (!fs.statSync(full).isFile()) {
      throw new Error(`Expected file: ${required}`);
    }
  }
}

function validateStaticTopLevel(baseDir: string) {
  for (const required of ["vibefi.json", "index.html"]) {
    const full = path.join(baseDir, required);
    if (!fs.existsSync(full)) {
      throw new Error(`Missing required entry: ${required}`);
    }
    if (!fs.statSync(full).isFile()) {
      throw new Error(`Expected file: ${required}`);
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

function validateConstrainedFiles(baseDir: string, constraints: Constraints) {
  const srcDir = path.join(baseDir, "src");
  const assetDir = path.join(baseDir, "assets");
  const abiDir = path.join(baseDir, "abis");

  const srcFiles = walkFiles(srcDir, { skipDotfiles: true });
  for (const file of srcFiles) {
    const rel = relativeTo(baseDir, file);
    if (!constraints.allowedSrcExtensions.includes(path.extname(file))) {
      throw new Error(`Invalid source extension: ${rel}`);
    }
    const content = fs.readFileSync(file, "utf-8");
    for (const pattern of constraints.forbiddenPatterns) {
      if (content.includes(pattern)) {
        throw new Error(`Forbidden pattern in ${rel}: ${pattern}`);
      }
    }
  }

  const assetFiles = walkFiles(assetDir, { skipDotfiles: true });
  for (const file of assetFiles) {
    const rel = relativeTo(baseDir, file);
    if (!constraints.allowedAssetExtensions.includes(path.extname(file))) {
      throw new Error(`Invalid asset extension: ${rel}`);
    }
  }

  const abiFiles = walkFiles(abiDir, { skipDotfiles: true });
  for (const file of abiFiles) {
    const rel = relativeTo(baseDir, file);
    if (!constraints.allowedAbiExtensions.includes(path.extname(file))) {
      throw new Error(`Invalid ABI extension: ${rel}`);
    }
    readJsonFile(file);
  }

  const indexHtml = fs.readFileSync(path.join(baseDir, "index.html"), "utf-8");
  for (const pattern of constraints.forbiddenPatterns) {
    if (indexHtml.includes(pattern)) {
      throw new Error(`Forbidden pattern in index.html: ${pattern}`);
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
  throw new Error(`Invalid vibefi.json addresses structure at ${context}`);
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

export function readSourceManifest(baseDir: string): SourceManifest {
  const manifestPath = path.join(baseDir, "vibefi.json");
  const raw = readJsonFile(manifestPath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("vibefi.json must be an object");
  }
  const addresses = (raw as Record<string, unknown>).addresses;
  if (addresses === undefined) {
    throw new Error("vibefi.json.addresses is required");
  }
  validateAddresses(addresses, "vibefi.json.addresses");
  const capabilities = validateManifestCapabilities(
    (raw as Record<string, unknown>).capabilities
  );
  return {
    addresses,
    capabilities
  };
}

function collectConstrainedBundleFiles(baseDir: string) {
  const bundlePaths = ["src", "assets", "abis", "vibefi.json", "index.html"];
  const files: string[] = [];
  for (const entry of bundlePaths) {
    const full = path.join(baseDir, entry);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) {
      files.push(...walkFiles(full, { skipDotfiles: true }));
    } else {
      files.push(full);
    }
  }
  return files;
}

function collectStaticBundleFiles(baseDir: string) {
  const ignoredTopLevelEntries = new Set(["node_modules", "dist", "coverage", ".vibefi"]);
  const files: string[] = [];

  function walk(currentDir: string, depth: number) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (depth === 0 && ignoredTopLevelEntries.has(entry.name)) continue;

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }
      const rel = relativeTo(baseDir, fullPath);
      if (rel === "manifest.json") continue;
      const extension = path.extname(rel).toLowerCase();
      if (!STATIC_HTML_ALLOWED_EXTENSIONS.has(extension)) {
        throw new Error(
          `Static-html layout does not allow file type: ${rel} (extension ${extension || "<none>"})`
        );
      }
      files.push(fullPath);
    }
  }

  walk(baseDir, 0);
  return files;
}

function writeBundle(baseDir: string, outDir: string, files: string[]) {
  // Ensure deterministic contents across repeated runs by removing stale files.
  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);
  for (const file of files) {
    const rel = relativeTo(baseDir, file);
    const dest = path.join(outDir, rel);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(file, dest);
  }
}

export async function packageDapp(options: PackageOptions): Promise<PackageResult> {
  const baseDir = path.resolve(options.path);
  if (!fs.existsSync(baseDir)) {
    throw new Error(`Path does not exist: ${baseDir}`);
  }

  const constraints = loadConstraints(options.constraintsPath);
  const layout = detectBundleLayout(baseDir);
  if (layout === "constrained") {
    validateConstrainedTopLevel(baseDir);
    validatePackageJson(baseDir, constraints);
    validateConstrainedFiles(baseDir, constraints);
  } else {
    validateStaticTopLevel(baseDir);
  }
  const sourceManifest = readSourceManifest(baseDir);

  const bundleFiles = layout === "constrained"
    ? collectConstrainedBundleFiles(baseDir)
    : collectStaticBundleFiles(baseDir);
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
    layout,
    capabilities: sourceManifest.capabilities,
    constraints: layout === "constrained"
      ? {
        type: "default",
        allowedDependencies: constraints.allowedDependencies,
        allowedDevDependencies: constraints.allowedDevDependencies
      }
      : { type: "static-html" },
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
    const rootCid = await ipfsAdd(outDir, ipfsApi, { pin: true });
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
