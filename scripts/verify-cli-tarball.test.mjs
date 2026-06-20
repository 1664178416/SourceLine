import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
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

  it("rejects tarballs with duplicate entry names", async () => {
    await withTempDir(async (dir) => {
      const duplicateEntry = createValidEntries().find((entry) => entry.name === "package/dist/index.js");
      const tarball = await writeTarball(dir, `sourceline-${cliVersion}.tgz`, [...createValidEntries(), duplicateEntry]);

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Duplicate tarball entry: package/dist/index.js");
    });
  });

  it("rejects tarballs with unsafe entry names", async () => {
    await withTempDir(async (dir) => {
      const tarball = await writeTarball(dir, `sourceline-${cliVersion}.tgz`, [
        ...createValidEntries(),
        { name: "package/dist/../escape.js", content: "export {};\n" },
        { name: "package\\dist\\slash.js", content: "export {};\n" },
        { name: "/package/dist/absolute.js", content: "export {};\n" },
        { name: "package/dist/bad\nname.js", content: "export {};\n" }
      ]);

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unsafe tarball entry name: "package/dist/../escape.js"');
      expect(result.stderr).toContain('Unsafe tarball entry name: "package\\\\dist\\\\slash.js"');
      expect(result.stderr).toContain('Unsafe tarball entry name: "/package/dist/absolute.js"');
      expect(result.stderr).toContain('Unsafe tarball entry name: "package/dist/bad name.js"');
    });
  });

  it("normalizes noisy unsafe tarball entry names onto safe lines", async () => {
    await withTempDir(async (dir) => {
      const tarball = await writeTarball(dir, `sourceline-${cliVersion}.tgz`, [
        ...createValidEntries(),
        { name: `package/dist/bad\n\u001b[31mred\u001b[0m-${"x".repeat(2_200)}.js`, content: "export {};\n" }
      ]);

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unsafe tarball entry name:");
      expect(result.stderr).not.toContain("\u001b");
      expect(result.stderr).not.toContain("\\u001b");
      expect(result.stderr).not.toContain("\nred");
      for (const line of result.stderr.trim().split("\n").slice(1)) {
        expect(line).toMatch(/^- [^\n\r]*$/);
      }
    });
  });

  it("rejects non-regular file entries even when their names are allowed", async () => {
    await withTempDir(async (dir) => {
      const entries = createValidEntries().map((entry) =>
        entry.name === "package/dist/commands/check.js"
          ? {
              ...entry,
              content: "",
              typeflag: "2"
            }
          : entry.name === "package/dist/commands/cache.js"
            ? {
                ...entry,
                content: "",
                typeflag: "1"
              }
            : entry
      );
      const tarball = await writeTarball(dir, `sourceline-${cliVersion}.tgz`, entries);

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Tarball entry must be a regular file: package/dist/commands/check.js");
      expect(result.stderr).toContain("Tarball entry must be a regular file: package/dist/commands/cache.js");
    });
  });

  it("rejects tarballs with invalid entry checksums", async () => {
    await withTempDir(async (dir) => {
      const tarball = await writeTarball(dir, `sourceline-${cliVersion}.tgz`, [
        {
          ...createValidEntries()[0],
          checksumHeader: "000000\0 "
        },
        ...createValidEntries().slice(1)
      ]);

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid tar entry checksum for package/package.json");
    });
  });

  it("rejects tarballs without the standard end-of-archive marker", async () => {
    await withTempDir(async (dir) => {
      const missingMarker = await writeTarball(dir, `sourceline-${cliVersion}.tgz`, createValidEntries(), { endBlocks: 0 });
      const oneBlockMarker = await writeTarball(dir, "sourceline-999.999.999.tgz", createValidEntries(), { endBlocks: 1 });

      const missingResult = await runVerifier(missingMarker);
      const oneBlockResult = await runVerifier(oneBlockMarker);

      expect(missingResult.exitCode).toBe(1);
      expect(missingResult.stderr).toContain("Tarball is missing the end-of-archive marker.");
      expect(oneBlockResult.exitCode).toBe(1);
      expect(oneBlockResult.stderr).toContain("Tarball is missing the second end-of-archive block.");
    });
  });

  it("rejects tarballs with non-zero data after the end-of-archive marker", async () => {
    await withTempDir(async (dir) => {
      const tarball = await writeTarball(dir, `sourceline-${cliVersion}.tgz`, createValidEntries(), { trailingData: "extra-data" });

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Tarball contains non-zero data after the end-of-archive marker.");
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

  it("rejects tarballs that are too large before reading them into memory", async () => {
    await withTempDir(async (dir) => {
      const tarball = join(dir, `sourceline-${cliVersion}.tgz`);
      await writeFile(tarball, "");
      await truncate(tarball, 20_000_001);

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Tarball is larger than 20000000 bytes.");
    });
  });

  it("rejects tarballs that expand beyond the uncompressed tar limit", async () => {
    await withTempDir(async (dir) => {
      const tarball = join(dir, `sourceline-${cliVersion}.tgz`);
      await writeFile(tarball, gzipSync(Buffer.alloc(50_000_001)));

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Tarball expands to more than 50000000 bytes.");
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

  it("rejects bare CommonJS requires that are missing from runtime dependencies", async () => {
    await withTempDir(async (dir) => {
      const entries = createValidEntries().map((entry) =>
        entry.name === "package/dist/commands/check.js"
          ? {
              ...entry,
              content:
                "const path = require('node:path');\nconst local = require('./cache.js');\nconst missingRuntime = require('missing-runtime');\nexport { missingRuntime, path, local };\n"
            }
          : entry
      );
      const tarball = await writeTarball(dir, `sourceline-${cliVersion}.tgz`, entries);

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "package/dist/commands/check.js imports missing-runtime, but package/package.json dependencies.missing-runtime is missing."
      );
      expect(result.stderr).not.toContain("dependencies.node:path");
      expect(result.stderr).not.toContain("dependencies..");
    });
  });

  it("rejects packed manifests that are not JSON objects", async () => {
    await withTempDir(async (dir) => {
      const entries = createValidEntries().map((entry) =>
        entry.name === "package/package.json"
          ? {
              ...entry,
              content: "null\n"
            }
          : entry
      );
      const tarball = await writeTarball(dir, `sourceline-${cliVersion}.tgz`, entries);

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("package/package.json must be a JSON object.");
    });
  });

  it("rejects packed manifest dependency sections that are not objects", async () => {
    await withTempDir(async (dir) => {
      const tarball = await writeTarball(
        dir,
        `sourceline-${cliVersion}.tgz`,
        createValidEntries({ dependencies: "not-an-object" })
      );

      const result = await runVerifier(tarball);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("package/package.json must define dependencies for the CLI runtime.");
      expect(result.stderr).toContain("package/package.json dependencies must be an object.");
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

  it("rejects invalid verifier-side CLI package manifests before locating tarballs", async () => {
    await withTempDir(async (dir) => {
      const tempScriptPath = await copyVerifierToTempRepo(dir);
      const packageJsonPath = join(dir, "packages", "cli", "package.json");

      await writeFile(packageJsonPath, "null\n", "utf8");
      let result = await runVerifier(".", { scriptPath: tempScriptPath, cwd: dir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("packages/cli/package.json must be a JSON object.");

      await writeFile(packageJsonPath, "{}\n", "utf8");
      result = await runVerifier(".", { scriptPath: tempScriptPath, cwd: dir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("packages/cli/package.json must define a version.");
    });
  });

  it("rejects oversized verifier-side CLI package manifests before parsing JSON", async () => {
    await withTempDir(async (dir) => {
      const tempScriptPath = await copyVerifierToTempRepo(dir);
      const packageJsonPath = join(dir, "packages", "cli", "package.json");
      await truncate(packageJsonPath, 1_000_001);

      const result = await runVerifier(".", { scriptPath: tempScriptPath, cwd: dir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("packages/cli/package.json is larger than 1000000 bytes.");
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

async function runVerifier(target, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [options.scriptPath ?? scriptPath, target], { cwd: options.cwd ?? repoRoot });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? ""
    };
  }
}

async function copyVerifierToTempRepo(dir) {
  const tempScriptDir = join(dir, "scripts");
  const tempPackageDir = join(dir, "packages", "cli");
  await mkdir(tempScriptDir, { recursive: true });
  await mkdir(tempPackageDir, { recursive: true });
  const tempScriptPath = join(tempScriptDir, "verify-cli-tarball.mjs");
  await writeFile(tempScriptPath, await readFile(scriptPath, "utf8"), "utf8");
  await writeFile(join(tempPackageDir, "package.json"), `${JSON.stringify({ version: cliVersion })}\n`, "utf8");
  return tempScriptPath;
}

async function writeTarball(dir, name, entries, options = {}) {
  const tarballPath = join(dir, name);
  await writeFile(tarballPath, gzipSync(createTar(entries, options)));
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

function createTar(entries, options = {}) {
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
    header.fill(0x20, 148, 156);
    header[156] = (entry.typeflag ?? "0").charCodeAt(0);
    const checksum = tarHeaderChecksum(header);
    writeTarString(header, entry.checksumHeader ?? `${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);

    chunks.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }

  const endBlocks = options.endBlocks ?? 2;
  if (endBlocks > 0) {
    chunks.push(Buffer.alloc(endBlocks * 512));
  }
  if (options.trailingData) {
    chunks.push(Buffer.from(options.trailingData, "utf8"));
  }
  return Buffer.concat(chunks);
}

function writeTarString(buffer, value, offset, length) {
  Buffer.from(value, "utf8").copy(buffer, offset, 0, length);
}

function tarHeaderChecksum(header) {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}
