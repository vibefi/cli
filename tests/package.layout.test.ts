import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageDapp } from "../src/package";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

describe("packageDapp layout support", () => {
  test("packages constrained layout", async () => {
    const dir = createTempDir("vibefi-cli-constrained-");
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.mkdirSync(path.join(dir, "abis"));
    writeText(path.join(dir, "src", "main.ts"), "export const ok = 1;\n");
    fs.writeFileSync(path.join(dir, "assets", "logo.webp"), "webp");
    writeJson(path.join(dir, "abis", "Foo.json"), []);
    writeText(path.join(dir, "index.html"), "<!doctype html><title>ok</title>\n");
    writeJson(path.join(dir, "package.json"), { name: "constrained", private: true, version: "0.0.1", type: "module" });
    writeJson(path.join(dir, "vibefi.json"), {
      addresses: {
        "31337": {
          dappRegistry: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
        }
      }
    });

    const result = await packageDapp({
      path: dir,
      name: "Constrained",
      version: "0.0.1",
      description: "test",
      ipfs: false
    });

    expect((result.manifest as { layout?: string }).layout).toBe("constrained");
    expect(fs.existsSync(path.join(result.outDir, "src", "main.ts"))).toBe(true);
    expect(fs.existsSync(path.join(result.outDir, "assets", "logo.webp"))).toBe(true);
    expect(fs.existsSync(path.join(result.outDir, "abis", "Foo.json"))).toBe(true);
  });

  test("packages static-html layout without package.json/src/assets/abis", async () => {
    const dir = createTempDir("vibefi-cli-static-");
    writeText(path.join(dir, "index.html"), "<!doctype html><script src=\"https://cdn.example/app.js\"></script>\n");
    writeText(path.join(dir, "app.js"), "console.log('ok');\n");
    writeText(path.join(dir, "domains", "index.html"), "<!doctype html><title>subpage</title>\n");
    writeJson(path.join(dir, "vibefi.json"), {
      addresses: {
        "31337": {
          dappRegistry: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
        }
      }
    });
    writeText(path.join(dir, "manifest.json"), "{\"stale\":true}\n");
    writeText(path.join(dir, "node_modules", "pkg", "index.js"), "ignored");

    const result = await packageDapp({
      path: dir,
      name: "Static",
      version: "0.0.1",
      description: "test",
      ipfs: false
    });

    expect((result.manifest as { layout?: string }).layout).toBe("static-html");
    expect(fs.existsSync(path.join(result.outDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(result.outDir, "app.js"))).toBe(true);
    expect(fs.existsSync(path.join(result.outDir, "domains", "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(result.outDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.outDir, "node_modules"))).toBe(false);
  });

  test("still validates constrained dependency allowlist", async () => {
    const dir = createTempDir("vibefi-cli-constrained-bad-deps-");
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.mkdirSync(path.join(dir, "abis"));
    writeText(path.join(dir, "src", "main.ts"), "export const ok = 1;\n");
    fs.writeFileSync(path.join(dir, "assets", "logo.webp"), "webp");
    writeJson(path.join(dir, "abis", "Foo.json"), []);
    writeText(path.join(dir, "index.html"), "<!doctype html><title>ok</title>\n");
    writeJson(path.join(dir, "package.json"), {
      name: "constrained",
      private: true,
      version: "0.0.1",
      type: "module",
      dependencies: {
        lodash: "4.17.21"
      }
    });
    writeJson(path.join(dir, "vibefi.json"), {
      addresses: {
        "31337": {
          dappRegistry: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
        }
      }
    });

    await expect(
      packageDapp({
        path: dir,
        name: "Constrained",
        version: "0.0.1",
        description: "test",
        ipfs: false
      })
    ).rejects.toThrow(/Dependency not allowed/i);
  });

  test("rejects disallowed file extensions in static-html layout", async () => {
    const dir = createTempDir("vibefi-cli-static-bad-ext-");
    writeText(path.join(dir, "index.html"), "<!doctype html><title>static</title>\n");
    writeText(path.join(dir, "app.js"), "console.log('ok');\n");
    writeText(path.join(dir, "payload.bin"), "not allowed");
    writeJson(path.join(dir, "vibefi.json"), {
      addresses: {
        "31337": {
          dappRegistry: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
        }
      }
    });

    await expect(
      packageDapp({
        path: dir,
        name: "Static",
        version: "0.0.1",
        description: "test",
        ipfs: false
      })
    ).rejects.toThrow(/Static-html layout does not allow file type/i);
  });
});
