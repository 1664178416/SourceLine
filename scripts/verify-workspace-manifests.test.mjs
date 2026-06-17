import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
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

  it("rejects root manifests that are not private", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir, {
        root: {
          private: false
        }
      });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Root package.json must be private.");
    });
  });

  it("rejects root manifests without a pinned pnpm package manager", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir, {
        root: {
          packageManager: "npm@11.0.0"
        }
      });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Root package.json packageManager must pin pnpm as pnpm@x.y.z.");
    });
  });

  it("rejects workspace manifests that are not private", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir, {
        core: {
          private: false
        }
      });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "packages/core/package.json must be private before publishing is deliberately enabled."
      );
    });
  });

  it("rejects workspace manifests that pack more than dist", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir, {
        cli: {
          files: ["dist", "src"]
        }
      });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('packages/cli/package.json files must only include "dist".');
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

  it("rejects duplicate workspace package names", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir, {
        core: {
          name: "sourceline"
        }
      });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Duplicate workspace package name "sourceline" in packages/cli/package.json and packages/core/package.json.'
      );
    });
  });

  it("rejects workspace package patterns that match no package manifests", async () => {
    await withWorkspace(async (dir) => {
      await writeJson(join(dir, "package.json"), {
        name: "workspace-root",
        version: "1.2.3",
        engines: {
          node: ">=24"
        }
      });
      await writeFile(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n', "utf8");
      await mkdir(join(dir, "packages"), { recursive: true });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "pnpm-workspace.yaml package patterns must match at least one workspace package manifest."
      );
    });
  });

  it("rejects invalid workspace package names", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir, {
        core: {
          name: "SourceLine CLI"
        }
      });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'packages/core/package.json package name "SourceLine CLI" must be a lowercase npm package name (name or @scope/name).'
      );
    });
  });

  it("rejects invalid root package names", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir);
      await writeJson(join(dir, "package.json"), {
        name: "@sourceline/",
        version: "1.2.3",
        engines: {
          node: ">=24"
        }
      });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Root package.json package name "@sourceline/" must be a lowercase npm package name (name or @scope/name).'
      );
    });
  });

  it("rejects dependency sections that are not objects", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir, {
        cli: {
          dependencies: "not-an-object"
        }
      });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("packages/cli/package.json dependencies must be an object.");
    });
  });

  it("rejects invalid dependency names", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir, {
        cli: {
          dependencies: {
            "Bad Dependency": "^1.0.0"
          }
        }
      });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "packages/cli/package.json dependencies.Bad Dependency must be a lowercase npm package name (name or @scope/name)."
      );
    });
  });

  it("rejects invalid dependency versions", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir, {
        cli: {
          dependencies: {
            commander: ""
          }
        }
      });

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "packages/cli/package.json dependencies.commander must be a non-empty string without control characters."
      );
    });
  });

  it("rejects oversized package manifests before parsing JSON", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir);
      await truncate(join(dir, "packages", "core", "package.json"), 1_000_001);

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("packages/core/package.json is larger than 1000000 bytes.");
    });
  });

  it("rejects oversized pnpm workspace manifests before parsing patterns", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir);
      await truncate(join(dir, "pnpm-workspace.yaml"), 1_000_001);

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Could not read pnpm-workspace.yaml:");
      expect(result.stderr).toContain("pnpm-workspace.yaml is larger than 1000000 bytes.");
    });
  });

  it("rejects duplicate workspace package patterns", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir);
      await writeFile(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n  - "packages/*"\n', "utf8");

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Duplicate pnpm workspace package pattern: packages/*");
    });
  });

  it("rejects unsupported pnpm workspace top-level keys", async () => {
    await withWorkspace(async (dir) => {
      await writeWorkspace(dir);
      await writeFile(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\nignored: true\n', "utf8");

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unsupported pnpm-workspace.yaml top-level key: ignored.");
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
  await writeJson(
    join(dir, "package.json"),
    mergeRootManifest(
      {
        name: "workspace-root",
        version: "1.2.3",
        private: true,
        type: "module",
        license: "UNLICENSED",
        packageManager: "pnpm@11.5.2",
        engines: {
          node: ">=24"
        }
      },
      overrides.root
    )
  );
  await writeFile(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n', "utf8");
  await mkdir(join(dir, "packages", "core"), { recursive: true });
  await mkdir(join(dir, "packages", "cli"), { recursive: true });
  await writeJson(
    join(dir, "packages", "core", "package.json"),
    mergeManifest(
      {
        name: "@sourceline/core",
        version: "1.2.3",
        private: true,
        type: "module",
        license: "UNLICENSED",
        engines: {
          node: ">=24"
        },
        files: ["dist"]
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
        private: true,
        type: "module",
        license: "UNLICENSED",
        engines: {
          node: ">=24"
        },
        files: ["dist"],
        dependencies: {
          "@sourceline/core": "workspace:*",
          commander: "^14.0.0"
        }
      },
      overrides.cli
    )
  );
}

function mergeRootManifest(base, override = {}) {
  return {
    ...base,
    ...override,
    engines: override.engines ?? base.engines
  };
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
