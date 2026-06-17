import { describe, expect, it } from "vitest";
import type { LocalIndexCacheClearResult, LocalIndexCacheInfo } from "@sourceline/providers";
import { formatCacheClearResult, formatCacheInfo, requireSources } from "./cache.js";

describe("cache command formatting", () => {
  it("normalizes required source folder paths", () => {
    expect(requireSources({ sources: " examples/sources " })).toBe("examples/sources");
    expect(() => requireSources({})).toThrow("--sources is required.");
    expect(() => requireSources({ sources: "   " })).toThrow("--sources is required.");
    expect(() => requireSources({ sources: "examples\nsources" })).toThrow("--sources must not contain control characters.");
    expect(() => requireSources({ sources: "s".repeat(2_001) })).toThrow("--sources must be at most 2000 characters.");
  });

  it("formats valid cache info for people", () => {
    const output = formatCacheInfo({
      rootDir: "C:\\sources",
      cachePath: "C:\\sources\\.sourceline\\cache\\local-index.json",
      currentSchemaVersion: 5,
      cacheSchemaVersion: 5,
      exists: true,
      valid: true,
      cacheBytes: 4096,
      sourceFiles: 3,
      sourceBytes: 12_288,
      skippedSourceFiles: 1,
      skippedOversizedSourceFiles: 1,
      skippedOverBudgetSourceFiles: 0,
      entries: 3,
      currentEntries: 2,
      staleEntries: 1,
      missingEntries: 0,
      uncachedSourceFiles: 0,
      chunks: 8
    } satisfies LocalIndexCacheInfo);

    expect(output).toContain("SourceLine local cache");
    expect(output).toContain("Schema: 5 (current 5)");
    expect(output).toContain("Status:");
    expect(output).toContain("needs refresh");
    expect(output).toContain("Source files: 3");
    expect(output).toContain("Skipped source files: 1");
    expect(output).toContain("Skipped oversized source files: 1");
    expect(output).toContain("Skipped over budget source files: 0");
    expect(output).toContain("Cache entries: 3");
    expect(output).toContain("Chunks: 8");
    expect(output).toContain("4.00 KB");
  });

  it("formats invalid cache reasons", () => {
    const output = formatCacheInfo({
      rootDir: "C:\\sources",
      cachePath: "C:\\sources\\.sourceline\\cache\\local-index.json",
      currentSchemaVersion: 5,
      cacheSchemaVersion: 2,
      exists: true,
      valid: false,
      invalidReason: "Could not read local index cache. It may be corrupt.",
      cacheBytes: 12,
      sourceFiles: 1,
      sourceBytes: 128,
      skippedSourceFiles: 0,
      skippedOversizedSourceFiles: 0,
      skippedOverBudgetSourceFiles: 0,
      entries: 0,
      currentEntries: 0,
      staleEntries: 0,
      missingEntries: 0,
      uncachedSourceFiles: 1,
      chunks: 0
    } satisfies LocalIndexCacheInfo);

    expect(output).toContain("Schema: 2 (current 5)");
    expect(output).toContain("invalid");
    expect(output).toContain("Could not read local index cache");
  });

  it("formats cache clear results", () => {
    const removed = formatCacheClearResult({
      cachePath: "C:\\sources\\.sourceline\\cache\\local-index.json",
      removed: true
    } satisfies LocalIndexCacheClearResult);
    const missing = formatCacheClearResult({
      cachePath: "C:\\sources\\.sourceline\\cache\\local-index.json",
      removed: false
    } satisfies LocalIndexCacheClearResult);

    expect(removed).toContain("Removed local cache");
    expect(missing).toContain("No local cache found");
  });
});
