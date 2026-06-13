import { clearLocalIndexCache, getLocalIndexCacheInfo, type LocalIndexCacheClearResult, type LocalIndexCacheInfo } from "@sourceline/providers";
import type { Command } from "commander";
import pc from "picocolors";

type CacheCommandOptions = {
  sources?: string;
  json?: boolean;
};

export function registerCacheCommand(program: Command): void {
  const cache = program.command("cache").description("Inspect and clear local SourceLine caches");

  cache
    .command("info")
    .description("Show local retrieval cache status for a source folder")
    .requiredOption("--sources <dir>", "Local Markdown/txt/HTML source folder")
    .option("--json", "Print cache status as JSON")
    .action(async (options: CacheCommandOptions) => {
      const info = await getLocalIndexCacheInfo({ rootDir: requireSources(options) });
      process.stdout.write(options.json ? `${JSON.stringify(info, null, 2)}\n` : formatCacheInfo(info));
    });

  cache
    .command("clear")
    .description("Delete the local retrieval cache for a source folder")
    .requiredOption("--sources <dir>", "Local Markdown/txt/HTML source folder")
    .option("--json", "Print the result as JSON")
    .action(async (options: CacheCommandOptions) => {
      const result = await clearLocalIndexCache({ rootDir: requireSources(options) });
      process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatCacheClearResult(result));
    });
}

export function requireSources(options: CacheCommandOptions): string {
  const sources = options.sources?.trim();
  if (!sources) {
    throw new Error("--sources is required.");
  }
  return sources;
}

export function formatCacheInfo(info: LocalIndexCacheInfo): string {
  const status = formatCacheStatus(info);
  const lines = [
    "SourceLine local cache",
    `Sources: ${info.rootDir}`,
    `Cache: ${info.cachePath}`,
    `Schema: ${formatCacheSchema(info)}`,
    `Status: ${status}`,
    `Source files: ${info.sourceFiles} (${formatBytes(info.sourceBytes)})`,
    `Cache entries: ${info.entries}`,
    `Current: ${info.currentEntries}`,
    `Stale: ${info.staleEntries}`,
    `Missing source: ${info.missingEntries}`,
    `Uncached source files: ${info.uncachedSourceFiles}`,
    `Chunks: ${info.chunks}`,
    `Cache size: ${formatBytes(info.cacheBytes)}`
  ];

  if (info.invalidReason) {
    lines.push(`Reason: ${info.invalidReason}`);
  }

  return `${lines.join("\n")}\n`;
}

export function formatCacheClearResult(result: LocalIndexCacheClearResult): string {
  if (result.removed) {
    return `${pc.green("Removed local cache:")} ${result.cachePath}\n`;
  }

  return `${pc.yellow("No local cache found:")} ${result.cachePath}\n`;
}

function formatCacheSchema(info: LocalIndexCacheInfo): string {
  return info.cacheSchemaVersion === undefined
    ? `current ${info.currentSchemaVersion}`
    : `${info.cacheSchemaVersion} (current ${info.currentSchemaVersion})`;
}

function formatCacheStatus(info: LocalIndexCacheInfo): string {
  if (!info.exists) {
    return pc.yellow("missing");
  }
  if (!info.valid) {
    return pc.red("invalid");
  }
  if (info.staleEntries > 0 || info.missingEntries > 0 || info.uncachedSourceFiles > 0) {
    return pc.yellow("needs refresh");
  }
  return pc.green("ready");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${roundSize(value)} ${units[unitIndex] ?? "KB"}`;
}

function roundSize(value: number): string {
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}
