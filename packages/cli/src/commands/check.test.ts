import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimFailsGate, resolveInput, writeOutputFile } from "./check.js";
import type { ClaimCheck } from "@sourceline/core";
import type { ResolvedCheckSettings } from "@sourceline/config";

describe("claimFailsGate", () => {
  const statuses: ClaimCheck["status"][] = [
    "supported",
    "partially_supported",
    "unsupported",
    "contradicted",
    "not_enough_evidence"
  ];

  it.each([
    ["never", []],
    ["review", ["partially_supported", "unsupported", "contradicted", "not_enough_evidence"]],
    ["unsupported", ["unsupported", "contradicted"]],
    ["contradicted", ["contradicted"]]
  ] satisfies Array<[ResolvedCheckSettings["failOn"], ClaimCheck["status"][]]>)(
    "fails %s only for expected statuses",
    (failOn, expectedFailures) => {
      for (const status of statuses) {
        expect(claimFailsGate({ status }, failOn)).toBe(expectedFailures.includes(status));
      }
    }
  );
});

describe("resolveInput", () => {
  it("resolves file and URL inputs without reading stdin", async () => {
    await expect(resolveInput("examples/answer.md", { readStdin: async () => "unused" })).resolves.toEqual({
      kind: "file",
      path: "examples/answer.md"
    });

    await expect(resolveInput("https://example.com/article", { readStdin: async () => "unused" })).resolves.toEqual({
      kind: "url",
      url: "https://example.com/article"
    });
  });

  it("trims explicit file, URL, and dash stdin inputs", async () => {
    await expect(resolveInput("  examples/answer.md  ", { readStdin: async () => "unused" })).resolves.toEqual({
      kind: "file",
      path: "examples/answer.md"
    });

    await expect(resolveInput("  https://example.com/article  ", { readStdin: async () => "unused" })).resolves.toEqual({
      kind: "url",
      url: "https://example.com/article"
    });

    await expect(resolveInput(" - ", { stdinIsTTY: false, readStdin: async () => "SourceLine uses trimmed dash stdin." })).resolves.toEqual({
      kind: "stdin",
      name: "stdin",
      text: "SourceLine uses trimmed dash stdin."
    });
  });

  it("rejects explicit input paths and URLs with control characters", async () => {
    await expect(resolveInput("examples\nanswer.md", { readStdin: async () => "unused" })).rejects.toThrow(
      "Input path or URL must not contain control characters."
    );
    await expect(resolveInput("https://example.com/\nchanged", { readStdin: async () => "unused" })).rejects.toThrow(
      "Input path or URL must not contain control characters."
    );
  });

  it("rejects overlong explicit input paths and URLs", async () => {
    await expect(resolveInput("x".repeat(2_001), { readStdin: async () => "unused" })).rejects.toThrow(
      "Input path or URL must be at most 2000 characters."
    );
    await expect(resolveInput(`https://example.com/${"a".repeat(2_000)}`, { readStdin: async () => "unused" })).rejects.toThrow(
      "Input path or URL must be at most 2000 characters."
    );
  });

  it("fails immediately instead of waiting on interactive stdin", async () => {
    await expect(resolveInput(undefined, { stdinIsTTY: true, readStdin: async () => "unused" })).rejects.toThrow(
      "No input provided. Pass a file path, URL, or pipe text into `sourceline check -`."
    );

    await expect(resolveInput("   ", { stdinIsTTY: true, readStdin: async () => "unused" })).rejects.toThrow(
      "No input provided. Pass a file path, URL, or pipe text into `sourceline check -`."
    );
  });

  it("reads piped stdin for missing input or '-' input", async () => {
    await expect(resolveInput(undefined, { stdinIsTTY: false, readStdin: async () => "SourceLine uses stdin." })).resolves.toEqual({
      kind: "stdin",
      name: "stdin",
      text: "SourceLine uses stdin."
    });

    await expect(resolveInput("-", { stdinIsTTY: false, readStdin: async () => "SourceLine uses dash stdin." })).resolves.toEqual({
      kind: "stdin",
      name: "stdin",
      text: "SourceLine uses dash stdin."
    });
  });

  it("rejects oversized piped stdin before creating an input descriptor", async () => {
    await expect(resolveInput("-", { stdinIsTTY: false, readStdin: async () => "x".repeat(2_000_001) })).rejects.toThrow(
      "Stdin input is larger than 2000000 bytes."
    );
  });
});

describe("writeOutputFile", () => {
  it("creates nested output directories and leaves no temporary files", async () => {
    const rootDir = join(tmpdir(), `sourceline-cli-out-${Date.now()}`);
    const outputPath = join(rootDir, "nested", "report.md");

    try {
      const writtenPath = await writeOutputFile(outputPath, "# Report\n");

      const files = await readdir(join(rootDir, "nested"));
      expect(writtenPath).toBe(outputPath);
      expect(await readFile(outputPath, "utf8")).toBe("# Report\n");
      expect(files).toContain("report.md");
      expect(files.filter((file) => file.startsWith("report.md.") && file.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("uses collision-resistant temporary files for concurrent writes to the same output", async () => {
    const rootDir = join(tmpdir(), `sourceline-cli-out-concurrent-${Date.now()}`);
    const outputPath = join(rootDir, "report.md");
    const originalDateNow = Date.now;

    try {
      Date.now = () => 1_781_454_698_000;

      await Promise.all([writeOutputFile(outputPath, "# First\n"), writeOutputFile(outputPath, "# Second\n")]);

      const content = await readFile(outputPath, "utf8");
      const files = await readdir(rootDir);
      expect(["# First\n", "# Second\n"]).toContain(content);
      expect(files).toEqual(["report.md"]);
    } finally {
      Date.now = originalDateNow;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("trims output paths before writing", async () => {
    const rootDir = join(tmpdir(), `sourceline-cli-out-trim-${Date.now()}`);
    const outputPath = join(rootDir, "report.md");

    try {
      const writtenPath = await writeOutputFile(`  ${outputPath}  `, "# Trimmed\n");

      expect(writtenPath).toBe(outputPath);
      expect(await readFile(outputPath, "utf8")).toBe("# Trimmed\n");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects blank output paths", async () => {
    await expect(writeOutputFile("   ", "# Report\n")).rejects.toThrow("--out must not be empty.");
  });

  it("rejects output paths with control characters", async () => {
    await expect(writeOutputFile("report\nnext.md", "# Report\n")).rejects.toThrow("--out must not contain control characters.");
  });

  it("rejects overlong output paths before writing", async () => {
    await expect(writeOutputFile("x".repeat(2_001), "# Report\n")).rejects.toThrow("--out must be at most 2000 characters.");
  });

  it("rejects output paths that point to directories", async () => {
    const rootDir = join(tmpdir(), `sourceline-cli-out-dir-${Date.now()}`);
    const outputDir = join(rootDir, "report-dir");

    try {
      await mkdir(outputDir, { recursive: true });

      await expect(writeOutputFile(outputDir, "# Report\n")).rejects.toThrow("--out must be a file path, not a directory.");
      expect(await readdir(rootDir)).toEqual(["report-dir"]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects output paths with trailing path separators", async () => {
    await expect(writeOutputFile("reports/", "# Report\n")).rejects.toThrow("--out must be a file path, not a directory.");
    await expect(writeOutputFile("reports\\", "# Report\n")).rejects.toThrow("--out must be a file path, not a directory.");
  });
});
