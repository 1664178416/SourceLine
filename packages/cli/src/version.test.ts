import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCliVersion, readPackageVersion } from "./version.js";

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("readCliVersion", () => {
  it("matches the CLI package manifest version", () => {
    const manifest = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as { version?: unknown };

    expect(readCliVersion()).toBe(manifest.version);
  });

  it("rejects package manifests that are not regular files", async () => {
    await withTempDir(async (dir) => {
      const packagePath = join(dir, "package.json");
      await mkdir(packagePath);

      expect(() => readPackageVersion(packagePath, "test package.json")).toThrow("test package.json must be a file.");
    });
  });

  it("rejects oversized package manifests before parsing JSON", async () => {
    await withTempDir(async (dir) => {
      const packagePath = join(dir, "package.json");
      await writeFile(packagePath, "");
      await truncate(packagePath, 1_000_001);

      expect(() => readPackageVersion(packagePath, "test package.json")).toThrow("test package.json is larger than 1000000 bytes.");
    });
  });

  it("rejects package manifests that are not JSON objects", async () => {
    await withTempDir(async (dir) => {
      const packagePath = join(dir, "package.json");
      await writeFile(packagePath, "null\n", "utf8");

      expect(() => readPackageVersion(packagePath, "test package.json")).toThrow("test package.json must be a JSON object.");
    });
  });

  it("rejects package manifests without a version", async () => {
    await withTempDir(async (dir) => {
      const packagePath = join(dir, "package.json");
      await writeFile(packagePath, "{}\n", "utf8");

      expect(() => readPackageVersion(packagePath, "test package.json")).toThrow("test package.json must define a version.");
    });
  });
});

async function withTempDir(callback: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sourceline-version-test-"));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
