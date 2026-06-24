import { describe, expect, it } from "vitest";
import type { LocalIndexCacheClearResult, LocalIndexCacheInfo } from "@sourceline/providers";
import { formatCacheClearResult, formatCacheInfo, requireSources } from "./cache.js";

function cacheInfo(overrides: Partial<LocalIndexCacheInfo> = {}): LocalIndexCacheInfo {
  return {
    rootDir: "C:\\sources",
    cachePath: "C:\\sources\\.sourceline\\cache\\local-index.json",
    currentSchemaVersion: 5,
    cacheSchemaVersion: 5,
    exists: true,
    valid: true,
    cacheBytes: 1024,
    sourceFiles: 1,
    sourceBytes: 128,
    skippedSourceFiles: 0,
    skippedOversizedSourceFiles: 0,
    skippedOverBudgetSourceFiles: 0,
    entries: 1,
    currentEntries: 1,
    staleEntries: 0,
    missingEntries: 0,
    uncachedSourceFiles: 0,
    chunks: 1,
    ...overrides
  };
}

describe("cache command formatting", () => {
  it("normalizes required source folder paths", () => {
    expect(requireSources({ sources: " examples/sources " })).toBe("examples/sources");
    expect(() => requireSources({})).toThrow("--sources is required.");
    expect(() => requireSources({ sources: "   " })).toThrow("--sources is required.");
    expect(() => requireSources({ sources: "examples\nsources" })).toThrow("--sources must not contain control characters.");
    expect(() => requireSources({ sources: "s".repeat(2_001) })).toThrow("--sources must be at most 2000 characters.");
  });

  it("formats valid cache info for people", () => {
    const output = formatCacheInfo(cacheInfo({
      cacheBytes: 4096,
      sourceFiles: 3,
      sourceBytes: 12_288,
      skippedSourceFiles: 1,
      skippedOversizedSourceFiles: 1,
      entries: 3,
      currentEntries: 2,
      staleEntries: 1,
      chunks: 8
    }));

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
    expect(output).toContain(
      "Hint: Re-run your local check command with `--search local --sources 'C:\\sources'` to refresh stale, missing, or uncached source entries."
    );
  });

  it("formats invalid cache reasons", () => {
    const output = formatCacheInfo(cacheInfo({
      cacheSchemaVersion: 2,
      valid: false,
      invalidReason: "Could not read local index cache. It may be corrupt.",
      cacheBytes: 12,
      entries: 0,
      currentEntries: 0,
      uncachedSourceFiles: 1,
      chunks: 0
    }));

    expect(output).toContain("Schema: 2 (current 5)");
    expect(output).toContain("invalid");
    expect(output).toContain("Could not read local index cache");
    expect(output).toContain(
      "Hint: Run `sourceline cache clear --sources 'C:\\sources'` and then re-run local search to rebuild the cache."
    );
  });

  it("formats missing and ready cache hints", () => {
    const missing = formatCacheInfo(cacheInfo({
      cacheSchemaVersion: undefined,
      exists: false,
      valid: false,
      cacheBytes: 0,
      entries: 0,
      currentEntries: 0,
      uncachedSourceFiles: 1,
      chunks: 0
    }));
    const ready = formatCacheInfo(cacheInfo());

    expect(missing).toContain("missing");
    expect(missing).toContain(
      "Hint: Re-run your local check command with `--search local --sources 'C:\\sources'` to build the local retrieval cache."
    );
    expect(ready).toContain("ready");
    expect(ready).not.toContain("Hint:");
  });

  it("quotes cache hint source paths only when needed", () => {
    const plainPath = formatCacheInfo(cacheInfo({
      rootDir: "examples/sources",
      cachePath: "examples/sources/.sourceline/cache/local-index.json",
      cacheSchemaVersion: undefined,
      exists: false,
      valid: false,
      cacheBytes: 0,
      sourceFiles: 0,
      sourceBytes: 0,
      entries: 0,
      currentEntries: 0,
      uncachedSourceFiles: 0,
      chunks: 0
    }));
    const trickyPath = formatCacheInfo(cacheInfo({
      rootDir: "C:\\Source Line\\owner's draft",
      cachePath: "C:\\Source Line\\.sourceline\\cache\\local-index.json",
      cacheSchemaVersion: undefined,
      exists: false,
      valid: false,
      cacheBytes: 0,
      sourceFiles: 0,
      sourceBytes: 0,
      entries: 0,
      currentEntries: 0,
      uncachedSourceFiles: 0,
      chunks: 0
    }));

    expect(plainPath).toContain("--sources examples/sources");
    expect(trickyPath).toContain("--sources 'C:\\Source Line\\owner''s draft'");
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
