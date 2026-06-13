import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, "scripts", "verify-cli-tarball.mjs");
const cliPackage = JSON.parse(readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8"));
const cliVersion = cliPackage.version;

const requiredDistEntries = [
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/errors.js",
  "package/dist/errors.d.ts",
  "package/dist/commands/cache.js",
  "package/dist/commands/cache.d.ts",
  "package/dist/commands/check.js",
  "package/dist/commands/check.d.ts",
  "package/dist/commands/init.js",
  "package/dist/commands/init.d.ts"
];

describe("verify-cli-tarball", () => {
  it("accepts a valid current-version CLI tarball from a directory", async () => {
    await withTempDir(async (dir) => {
      await writeTarball(dir, `sourceline-${cliVersion}.tgz`, createValidEntries());

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`sourceline-${cliVersion}.tgz`);
    });
  });

  it("prefers the current-version tarball when old tarballs are present", async () => {
    await withTempDir(async (dir) => {
      await writeTarball(dir, "sourceline-999.999.999.tgz", createValidEntries({ omit: ["package/dist/index.js"] }));
      await writeTarball(dir, `sourceline-${cliVersion}.tgz`, createValidEntries());

      const result = await runVerifier(dir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`sourceline-${cliVersion}.tgz`);
    });
  });

  it("rejects tarballs that include source or test-only content", async () => {
    await withTempDir(async (dir) => {
      const tarball = await writeTarball(dir, `sourceline-${cliVersion}.tgz`, [
        ...createValidEntries(),
        { name: "package/src/index.ts", content: "export {};\n" }
      ]);

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unexpected tarball entry: package/src/index.ts");
      expect(result.stderr).toContain("Tarball contains local-only content: package/src/index.ts");
    });
  });

  it("rejects tarballs that are missing required CLI entry files", async () => {
    await withTempDir(async (dir) => {
      const tarball = await writeTarball(
        dir,
        `sourceline-${cliVersion}.tgz`,
        createValidEntries({ omit: ["package/dist/commands/check.js"] })
      );

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing tarball entry: package/dist/commands/check.js");
    });
  });

  it("rejects tarballs with malformed entry size headers", async () => {
    await withTempDir(async (dir) => {
      const tarball = await writeTarball(dir, `sourceline-${cliVersion}.tgz`, [
        {
          ...createValidEntries()[0],
          sizeHeader: "0000000012x\0"
        },
        ...createValidEntries().slice(1)
      ]);

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid tar entry size for package/package.json");
    });
  });

  it("rejects tarballs with non-executable CLI entry files", async () => {
    await withTempDir(async (dir) => {
      const entries = createValidEntries().map((entry) =>
        entry.name === "package/dist/index.js"
          ? {
              ...entry,
              mode: "0000644\0"
            }
          : entry
      );
      const tarball = await writeTarball(dir, `sourceline-${cliVersion}.tgz`, entries);

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("package/dist/index.js must be executable in the packed tarball.");
    });
  });

  it("rejects bare dist imports that are missing from runtime dependencies", async () => {
    await withTempDir(async (dir) => {
      const entries = createValidEntries().map((entry) =>
        entry.name === "package/dist/commands/check.js"
          ? {
              ...entry,
              content: "import { readFile } from 'node:fs/promises';\nimport './cache.js';\nimport missingRuntime from 'missing-runtime';\nexport { missingRuntime };\n"
            }
          : entry
      );
      const tarball = await writeTarball(dir, `sourceline-${cliVersion}.tgz`, entries);

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "package/dist/commands/check.js imports missing-runtime, but package/package.json dependencies.missing-runtime is missing."
      );
      expect(result.stderr).not.toContain("dependencies.node:fs");
      expect(result.stderr).not.toContain("dependencies..");
    });
  });
  it("rejects packed manifests missing CLI runtime dependencies", async () => {
    await withTempDir(async (dir) => {
      const tarball = await writeTarball(
        dir,
        `sourceline-${cliVersion}.tgz`,
        createValidEntries({
          dependencies: {
            "@sourceline/config": cliVersion,
            "@sourceline/core": cliVersion,
            "@sourceline/providers": cliVersion,
            commander: "^14.0.0",
            picocolors: "^1.1.1"
          }
        })
      );

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("dependencies.@sourceline/report must be present for the CLI runtime.");
    });
  });
  it("rejects packed manifests that still contain workspace dependencies", async () => {
    await withTempDir(async (dir) => {
      const tarball = await writeTarball(
        dir,
        `sourceline-${cliVersion}.tgz`,
        createValidEntries({ dependencies: { "@sourceline/core": "workspace:*" } })
      );

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("dependencies.@sourceline/core was not rewritten from workspace protocol.");
    });
  });
});

async function withTempDir(callback) {
  const dir = await mkdtemp(join(tmpdir(), "sourceline-tarball-test-"));
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

async function writeTarball(dir, name, entries) {
  const tarballPath = join(dir, name);
  await writeFile(tarballPath, gzipSync(createTar(entries)));
  return tarballPath;
}

function createValidEntries(options = {}) {
  const omitted = new Set(options.omit ?? []);
  const manifest = {
    name: "sourceline",
    version: cliVersion,
    type: "module",
    bin: {
      sourceline: "./dist/index.js"
    },
    engines: {
      node: ">=24"
    },
    dependencies: options.dependencies ?? {
      "@sourceline/config": cliVersion,
      "@sourceline/core": cliVersion,
      "@sourceline/providers": cliVersion,
      "@sourceline/report": cliVersion,
      commander: "^14.0.0",
      picocolors: "^1.1.1"
    }
  };

  return [
    { name: "package/package.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    ...requiredDistEntries.map((name) => ({
      name,
      content: name === "package/dist/index.js" ? "#!/usr/bin/env node\nconsole.log('SourceLine');\n" : "export {};\n"
    }))
  ].filter((entry) => !omitted.has(entry.name));
}

function createTar(entries) {
  const chunks = [];

  for (const entry of entries) {
    const content = Buffer.from(entry.content, "utf8");
    const header = Buffer.alloc(512);
    writeTarString(header, entry.name, 0, 100);
    writeTarString(header, entry.mode ?? "0000777\0", 100, 8);
    writeTarString(header, "0000000\0", 108, 8);
    writeTarString(header, "0000000\0", 116, 8);
    writeTarString(header, entry.sizeHeader ?? `${content.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    writeTarString(header, "00000000000\0", 136, 12);
    header[156] = "0".charCodeAt(0);

    chunks.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }

  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function writeTarString(buffer, value, offset, length) {
  Buffer.from(value, "utf8").copy(buffer, offset, 0, length);
}
