import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, "scripts", "verify-workspace-manifests.mjs");

describe("verify-workspace-manifests", () => {
  it("accepts aligned workspace package manifests", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir);

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("2 packages at version 1.2.3");
    });
  });

  it("rejects workspace package version drift", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir, {
        core: {
          version: "1.2.4"
        }
      });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("packages/core/package.json version must match root version 1.2.3.");
    });
  });

  it("rejects workspace package engine drift", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir, {
        cli: {
          engines: {
            node: ">=22"
          }
        }
      });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("packages/cli/package.json engines.node must match root engines.node >=24.");
    });
  });

  it("rejects internal dependencies that are not workspace protocol before packing", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir, {
        cli: {
          dependencies: {
            "@sourceline/core": "1.2.3"
          }
        }
      });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("packages/cli/package.json dependencies.@sourceline/core must use workspace:* before packing.");
    });
  });
});

async function withWorkspace(callback) {
  const dir = await mkdtemp(join(tmpdir(), "sourceline-manifest-test-"));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runVerifier(target) {
  try {
    const result = await execFileAsync(process.execPath, [scriptPath, target], { cwd: repoRoot });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? ""
    };
  }
}

async function writeWorkspace(dir, overrides = {}) {
  await writeJson(join(dir, "package.json"), {
    name: "workspace-root",
    version: "1.2.3",
    engines: {
      node: ">=24"
    }
  });
  await writeFile(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n', "utf8");
  await mkdir(join(dir, "packages", "core"), { recursive: true });
  await mkdir(join(dir, "packages", "cli"), { recursive: true });
  await writeJson(
    join(dir, "packages", "core", "package.json"),
    mergeManifest(
      {
        name: "@sourceline/core",
        version: "1.2.3",
        engines: {
          node: ">=24"
        }
      },
      overrides.core
    )
  );
  await writeJson(
    join(dir, "packages", "cli", "package.json"),
    mergeManifest(
      {
        name: "sourceline",
        version: "1.2.3",
        engines: {
          node: ">=24"
        },
        dependencies: {
          "@sourceline/core": "workspace:*",
          commander: "^14.0.0"
        }
      },
      overrides.cli
    )
  );
}

function mergeManifest(base, override = {}) {
  return {
    ...base,
    ...override,
    engines: override.engines ?? base.engines,
    dependencies: override.dependencies ?? base.dependencies
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}