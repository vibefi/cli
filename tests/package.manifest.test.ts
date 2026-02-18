import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSourceManifest } from "../src/package";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createManifestDir(vibefi: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibefi-cli-manifest-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "vibefi.json"), JSON.stringify(vibefi, null, 2));
  return dir;
}

describe("readSourceManifest capability validation", () => {
  test("rejects non-positive maxBytes", () => {
    const dir = createManifestDir({
      addresses: {
        pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
      },
      capabilities: {
        ipfs: {
          allow: [
            {
              paths: ["src/**"],
              as: ["snippet"],
              maxBytes: 0,
            },
          ],
        },
      },
    });

    expect(() => readSourceManifest(dir)).toThrow(/maxBytes/i);
  });

  test("rejects invalid read kind in as", () => {
    const dir = createManifestDir({
      addresses: {
        pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
      },
      capabilities: {
        ipfs: {
          allow: [
            {
              paths: ["src/**"],
              as: ["script"],
            },
          ],
        },
      },
    });

    expect(() => readSourceManifest(dir)).toThrow(/read kind/i);
  });

  test("rejects empty paths array", () => {
    const dir = createManifestDir({
      addresses: {
        pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
      },
      capabilities: {
        ipfs: {
          allow: [
            {
              paths: [],
              as: ["text"],
            },
          ],
        },
      },
    });

    expect(() => readSourceManifest(dir)).toThrow(/paths/i);
  });

  test("accepts valid capabilities payload", () => {
    const dir = createManifestDir({
      addresses: {
        pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
      },
      capabilities: {
        ipfs: {
          allow: [
            {
              cid: "bafyexamplecid",
              paths: ["src/**"],
              as: ["snippet", "text"],
              maxBytes: 262144,
            },
          ],
        },
      },
    });

    const manifest = readSourceManifest(dir);
    expect(manifest.capabilities?.ipfs?.allow.length).toBe(1);
    expect(manifest.capabilities?.ipfs?.allow[0]?.as).toEqual(["snippet", "text"]);
  });

  test("requires addresses in vibefi.json", () => {
    const dir = createManifestDir({
      capabilities: {
        ipfs: {
          allow: [],
        },
      },
    });

    expect(() => readSourceManifest(dir)).toThrow(/addresses is required/i);
  });
});
