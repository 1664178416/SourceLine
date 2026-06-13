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
