import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInitCommand, starterConfig } from "./init.js";

describe("runInitCommand", () => {
  it("creates a starter config without overwriting existing files", async () => {
    const rootDir = join(tmpdir(), `sourceline-init-${Date.now()}`);
    const configPath = join(rootDir, "sourceline.config.json");
    const output: string[] = [];
    await mkdir(rootDir, { recursive: true });

    try {
      await runInitCommand({
        configPath,
        writeOutput: (value) => output.push(value)
      });

      expect(await readFile(configPath, "utf8")).toBe(starterConfig());
      expect(output.join("")).toContain("Created:");

      output.length = 0;
      await writeFile(configPath, "custom config", "utf8");
      await runInitCommand({
        configPath,
        writeOutput: (value) => output.push(value)
      });

      expect(await readFile(configPath, "utf8")).toBe("custom config");
      expect(output.join("")).toContain("Skipped:");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("trims custom config paths before writing", async () => {
    const rootDir = join(tmpdir(), `sourceline-init-trim-${Date.now()}`);
    const configPath = join(rootDir, "sourceline.config.json");
    const output: string[] = [];
    await mkdir(rootDir, { recursive: true });

    try {
      await runInitCommand({
        configPath: `  ${configPath}  `,
        writeOutput: (value) => output.push(value)
      });

      expect(await readFile(configPath, "utf8")).toBe(starterConfig());
      expect(output.join("")).toContain("Created:");
      expect(output.join("")).toContain(configPath);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe custom config paths", async () => {
    await expect(runInitCommand({ configPath: "   " })).rejects.toThrow("SourceLine config path must not be empty.");
    await expect(runInitCommand({ configPath: "source\nline.config.json" })).rejects.toThrow(
      "SourceLine config path must not contain control characters."
    );
    await expect(runInitCommand({ configPath: "x".repeat(2_001) })).rejects.toThrow(
      "SourceLine config path must be at most 2000 characters."
    );
    await expect(runInitCommand({ configPath: "configs/" })).rejects.toThrow(
      "SourceLine config path must be a file path, not a directory."
    );
    await expect(runInitCommand({ configPath: "configs\\" })).rejects.toThrow(
      "SourceLine config path must be a file path, not a directory."
    );
  });

  it("rejects custom config paths that already point to directories", async () => {
    const rootDir = join(tmpdir(), `sourceline-init-dir-${Date.now()}`);
    const configPath = join(rootDir, "sourceline.config.json");
    await mkdir(configPath, { recursive: true });

    try {
      await expect(runInitCommand({ configPath })).rejects.toThrow("SourceLine config must be a file:");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps the starter config valid JSON", () => {
    expect(JSON.parse(starterConfig())).toMatchObject({
      llm: {
        provider: "mock"
      },
      search: {
        provider: "mock"
      }
    });
  });
});
