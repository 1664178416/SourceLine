import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { SearchProvider, SearchResult } from "@sourceline/core";
import { normalizeOptionalText, normalizeSearchRequest } from "./search-utils.js";

const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".html", ".htm"]);
const LOCAL_INDEX_CACHE_VERSION = 5;
const LOCAL_INDEX_CACHE_PATH = join(".sourceline", "cache", "local-index.json");
const MAX_LOCAL_SOURCE_BYTES = 2_000_000;
const MAX_LOCAL_SOURCE_FILES = 5_000;
const MAX_LOCAL_SOURCE_TOTAL_BYTES = 20_000_000;
const MAX_LOCAL_CACHE_BYTES = 50_000_000;
const MAX_IGNORE_FILE_BYTES = 1_000_000;
const MAX_IGNORE_PATTERN_CHARS = 1_000;
const MAX_IGNORE_RULES = 1_000;
const MAX_LOCAL_SEARCH_QUERY_CHARS = 500;
const MAX_LOCAL_ROOT_DIR_CHARS = 2_000;
const MAX_LOCAL_DIRECTORY_DEPTH = 64;
const MAX_LOCAL_RESULT_TITLE_CHARS = 2_000;
const MAX_LOCAL_RESULT_PATH_CHARS = 2_000;
const MAX_LOCAL_RESULT_SNIPPET_CHARS = 2_000;
const MAX_LOCAL_RESULT_TEXT_CHARS = 20_000;
const MAX_LOCAL_RETRIEVAL_EXPLANATION_CHARS = 4_000;
const MAX_LOCAL_MATCHED_TERMS = 50;
const LOCAL_SOURCE_READ_CHUNK_BYTES = 64_000;
const HIDDEN_HTML_ELEMENT_PATTERN = new RegExp(
  String.raw`<([a-z][\w:-]*)\b(?=[^>]*(?:${[
    String.raw`\saria-hidden\s*=\s*(?:"true"|'true'|true)(?=\s|>|\/)`,
    String.raw`\shidden(?:\s|=|>|\/)`,
    String.raw`\sstyle\s*=\s*(?:"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"|'[^']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^']*')`
  ].join("|")}))[^>]*>[\s\S]*?<\/\1>`,
  "gi"
);
const HTML_ENTITY_PATTERN = /&(?:#(\d+)|#x([0-9a-f]+)|(nbsp|amp|lt|gt|quot|apos));/gi;
const HTML_NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'"
};
const cacheWriteLocks = new Map<string, Promise<void>>();

export type LocalSearchProviderOptions = {
  rootDir: string;
  now?: () => Date;
};

export type LocalIndexCacheInfo = {
  rootDir: string;
  cachePath: string;
  currentSchemaVersion: number;
  cacheSchemaVersion?: number;
  exists: boolean;
  valid: boolean;
  invalidReason?: string;
  cacheBytes: number;
  sourceFiles: number;
  sourceBytes: number;
  skippedSourceFiles: number;
  skippedOversizedSourceFiles: number;
  skippedOverBudgetSourceFiles: number;
  entries: number;
  currentEntries: number;
  staleEntries: number;
  missingEntries: number;
  uncachedSourceFiles: number;
  chunks: number;
};

export type LocalIndexCacheClearResult = {
  cachePath: string;
  removed: boolean;
};

type IndexedDocument = {
  id: string;
  path: string;
  title: string;
  text: string;
  titleTokens: Set<string>;
  normalizedTitle: string;
  chunks: LocalChunk[];
};

type LocalChunk = {
  id: string;
  text: string;
  startLine: number;
  endLine: number;
  tokens: Set<string>;
  termFrequencies: Map<string, number>;
  tokenCount: number;
  normalizedText: string;
};

type LocalSearchIndex = {
  documents: IndexedDocument[];
  postingLists: Map<string, IndexedChunk[]>;
  totalChunks: number;
  averageChunkLength: number;
  documentFrequencies: Map<string, number>;
};

type SourceFileMetadata = {
  path: string;
  relativePath: string;
  mtimeMs: number;
  size: number;
  contentHash?: string;
  documentHash?: string;
  source?: ParsedSourceText;
  skipReason?: SourceFileSkipReason;
};

type ParsedSourceText = {
  text: string;
  title?: string;
};

type SourceFileSkipReason = "oversized" | "source_budget";

type CachedLocalIndex = {
  schemaVersion: typeof LOCAL_INDEX_CACHE_VERSION;
  entries: CachedSourceEntry[];
};

type CachedSourceEntry = {
  relativePath: string;
  mtimeMs: number;
  size: number;
  contentHash: string;
  documentHash: string;
  document: CachedIndexedDocument;
};

type CachedIndexedDocument = {
  id: string;
  title: string;
  text: string;
  chunks: CachedLocalChunk[];
};

type CachedLocalChunk = {
  id: string;
  text: string;
  startLine: number;
  endLine: number;
  tokens: string[];
  termFrequencies: Array<[string, number]>;
  tokenCount: number;
  normalizedText: string;
};

type IndexedChunk = {
  key: string;
  document: IndexedDocument;
  chunk: LocalChunk;
};

type ChunkScore = {
  value: number;
  matchedTerms: string[];
  titleMatches: string[];
  phraseMatches: string[];
  explanation: string;
};

type IgnoreRule = {
  raw: string;
  regex: RegExp;
  negated: boolean;
  normalizedPattern: string;
};

export function createLocalSearchProvider(options: LocalSearchProviderOptions): SearchProvider {
  const rootDir = normalizeRootDir(options.rootDir);
  const now = options.now ?? (() => new Date());
  let indexPromise: Promise<LocalSearchIndex> | undefined;

  return {
    name: "local",
    async search(query) {
      const request = normalizeSearchRequest(query.query, query.maxResults);
      if (!request) {
        return [];
      }

      indexPromise ??= buildIndex(rootDir);
      const index = await indexPromise;
      const normalizedQuery = request.query;
      const queryTokens = tokenize(normalizedQuery);
      const uniqueQueryTokens = Array.from(new Set(queryTokens));
      const queryPhrases = buildQueryPhrases(queryTokens);

      if (uniqueQueryTokens.length === 0) {
        return [];
      }

      return collectCandidateChunks(uniqueQueryTokens, index)
        .map((entry) => {
          const score = scoreChunk(uniqueQueryTokens, queryPhrases, entry.chunk, entry.document, index);
          return {
            document: entry.document,
            chunk: entry.chunk,
            score
          };
        })
        .filter((item) => item.score.value > 0)
        .sort(compareScoredChunks)
        .slice(0, request.maxResults)
        .map((item, index): SearchResult => {
          const rank = index + 1;
          const rawPath = relative(process.cwd(), item.document.path).replace(/\\/g, "/");
          const path = normalizeLocalOutputText(rawPath, MAX_LOCAL_RESULT_PATH_CHARS) ?? item.document.id;
          const snippet = normalizeLocalOutputText(
            buildSnippet(item.chunk.text, item.score.matchedTerms),
            MAX_LOCAL_RESULT_SNIPPET_CHARS,
            true
          ) ?? "";
          const text = normalizeLocalOutputText(item.chunk.text, MAX_LOCAL_RESULT_TEXT_CHARS) ?? "";
          const explanation = normalizeLocalOutputText(
            item.score.explanation,
            MAX_LOCAL_RETRIEVAL_EXPLANATION_CHARS,
            true
          );

          return {
            id: `${item.document.id}#${item.chunk.id}`,
            title:
              normalizeLocalOutputText(
                `${item.document.title} lines ${item.chunk.startLine}-${item.chunk.endLine}`,
                MAX_LOCAL_RESULT_TITLE_CHARS,
                true
              ) ?? path,
            path,
            retrievedAt: now().toISOString(),
            snippet,
            text,
            retrieval: {
              score: roundScore(item.score.value),
              matchedTerms: normalizeLocalMatchedTerms(item.score.matchedTerms),
              ...(explanation === undefined ? {} : { explanation })
            },
            provider: "local",
            rank,
            query: normalizedQuery
          };
        });
    }
  };
}

export async function getLocalIndexCacheInfo(options: { rootDir: string }): Promise<LocalIndexCacheInfo> {
  const rootDir = normalizeRootDir(options.rootDir);
  const ignoreRules = await loadIgnoreRules(rootDir);
  const files = await listSourceFiles(rootDir, ignoreRules);
  const sourceFiles = await readSourceFileMetadata(rootDir, files);
  const indexableSourceFiles = sourceFiles.filter(isIndexableSourceFile);
  const skippedSourceFiles = sourceFiles.length - indexableSourceFiles.length;
  const skippedOversizedSourceFiles = sourceFiles.filter((sourceFile) => sourceFile.skipReason === "oversized").length;
  const skippedOverBudgetSourceFiles = sourceFiles.filter((sourceFile) => sourceFile.skipReason === "source_budget").length;
  const sourceFilesByPath = new Map(indexableSourceFiles.map((file) => [file.relativePath, file]));
  const cacheFile = await readLocalIndexCacheFile(rootDir);

  if (!cacheFile.exists) {
    return {
      rootDir,
      cachePath: cacheFile.cachePath,
      currentSchemaVersion: LOCAL_INDEX_CACHE_VERSION,
      exists: false,
      valid: false,
      cacheBytes: 0,
      sourceFiles: sourceFiles.length,
      sourceBytes: sumSourceBytes(sourceFiles),
      skippedSourceFiles,
      skippedOversizedSourceFiles,
      skippedOverBudgetSourceFiles,
      entries: 0,
      currentEntries: 0,
      staleEntries: 0,
      missingEntries: 0,
      uncachedSourceFiles: indexableSourceFiles.length,
      chunks: 0
    };
  }

  if (!cacheFile.cache) {
    return {
      rootDir,
      cachePath: cacheFile.cachePath,
      currentSchemaVersion: LOCAL_INDEX_CACHE_VERSION,
      cacheSchemaVersion: cacheFile.cacheSchemaVersion,
      exists: true,
      valid: false,
      invalidReason: cacheFile.invalidReason ?? "Invalid local index cache.",
      cacheBytes: cacheFile.cacheBytes,
      sourceFiles: sourceFiles.length,
      sourceBytes: sumSourceBytes(sourceFiles),
      skippedSourceFiles,
      skippedOversizedSourceFiles,
      skippedOverBudgetSourceFiles,
      entries: 0,
      currentEntries: 0,
      staleEntries: 0,
      missingEntries: 0,
      uncachedSourceFiles: indexableSourceFiles.length,
      chunks: 0
    };
  }

  let currentEntries = 0;
  let staleEntries = 0;
  let missingEntries = 0;
  const cachedSourcePaths = new Set<string>();

  for (const entry of cacheFile.cache.entries) {
    cachedSourcePaths.add(entry.relativePath);
    const sourceFile = sourceFilesByPath.get(entry.relativePath);
    if (!sourceFile) {
      missingEntries += 1;
    } else if (isCacheEntryCurrent(entry, sourceFile)) {
      currentEntries += 1;
    } else {
      staleEntries += 1;
    }
  }

  return {
    rootDir,
    cachePath: cacheFile.cachePath,
    currentSchemaVersion: LOCAL_INDEX_CACHE_VERSION,
    cacheSchemaVersion: cacheFile.cacheSchemaVersion,
    exists: true,
    valid: true,
    cacheBytes: cacheFile.cacheBytes,
    sourceFiles: sourceFiles.length,
    sourceBytes: sumSourceBytes(sourceFiles),
    skippedSourceFiles,
    skippedOversizedSourceFiles,
    skippedOverBudgetSourceFiles,
    entries: cacheFile.cache.entries.length,
    currentEntries,
    staleEntries,
    missingEntries,
    uncachedSourceFiles: indexableSourceFiles.filter((sourceFile) => !cachedSourcePaths.has(sourceFile.relativePath)).length,
    chunks: cacheFile.cache.entries.reduce((total, entry) => total + entry.document.chunks.length, 0)
  };
}

export async function clearLocalIndexCache(options: { rootDir: string }): Promise<LocalIndexCacheClearResult> {
  const rootDir = normalizeRootDir(options.rootDir);
  const cachePath = getLocalIndexCachePath(rootDir);
  const cacheStat = await stat(cachePath).catch((error: unknown) => {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }

    throw error;
  });

  if (!cacheStat) {
    return {
      cachePath,
      removed: false
    };
  }

  if (!cacheStat.isFile()) {
    throw new Error(`Local index cache must be a file: ${cachePath}`);
  }

  await rm(cachePath, { force: true });

  return {
    cachePath,
    removed: true
  };
}

function normalizeRootDir(rootDir: string): string {
  const trimmed = rootDir.trim();
  if (trimmed.length === 0) {
    throw new Error("Local sources rootDir must not be empty.");
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    throw new Error("Local sources rootDir must not contain control characters.");
  }
  if (trimmed.length > MAX_LOCAL_ROOT_DIR_CHARS) {
    throw new Error(`Local sources rootDir must be at most ${MAX_LOCAL_ROOT_DIR_CHARS} characters.`);
  }

  return resolve(trimmed);
}

async function buildIndex(rootDir: string): Promise<LocalSearchIndex> {
  const ignoreRules = await loadIgnoreRules(rootDir);
  const files = await listSourceFiles(rootDir, ignoreRules);
  const sourceFiles = await readSourceFileMetadata(rootDir, files);
  const cache = await readLocalIndexCache(rootDir);
  const cachedEntries = new Map(cache?.entries.map((entry) => [entry.relativePath, entry]) ?? []);
  const documents: IndexedDocument[] = [];
  const nextCacheEntries: CachedSourceEntry[] = [];

  for (const sourceFile of sourceFiles.filter(isIndexableSourceFile)) {
    const cachedEntry = cachedEntries.get(sourceFile.relativePath);
    const document =
      cachedEntry && isCacheEntryCurrent(cachedEntry, sourceFile)
        ? hydrateCachedDocument(rootDir, cachedEntry)
        : readIndexedDocument(rootDir, sourceFile);

    documents.push(document);
    nextCacheEntries.push(serializeCacheEntry(sourceFile, document));
  }

  await writeLocalIndexCache(rootDir, nextCacheEntries);
  return buildSearchIndex(documents);
}

function isIndexableSourceFile(sourceFile: SourceFileMetadata): boolean {
  return sourceFile.skipReason === undefined && sourceFile.size <= MAX_LOCAL_SOURCE_BYTES;
}

async function readSourceFileMetadata(rootDir: string, files: string[]): Promise<SourceFileMetadata[]> {
  const metadata: SourceFileMetadata[] = [];
  let indexableSourceBytes = 0;

  for (const file of files) {
    const fileStat = await stat(file).catch(() => undefined);
    if (!fileStat?.isFile()) {
      continue;
    }
    const sourceFile: SourceFileMetadata = {
      path: file,
      relativePath: normalizeRelativePath(rootDir, file),
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size
    };
    if (sourceFile.size > MAX_LOCAL_SOURCE_BYTES) {
      metadata.push({
        ...sourceFile,
        skipReason: "oversized"
      });
      continue;
    }
    if (indexableSourceBytes + sourceFile.size > MAX_LOCAL_SOURCE_TOTAL_BYTES) {
      metadata.push({
        ...sourceFile,
        skipReason: "source_budget"
      });
      continue;
    }
    if (isIndexableSourceFile(sourceFile)) {
      const rawBytes = await readLocalSourceBytes(file).catch(() => undefined);
      if (!rawBytes) {
        metadata.push({
          ...sourceFile,
          size: MAX_LOCAL_SOURCE_BYTES + 1,
          skipReason: "oversized"
        });
        continue;
      }
      const rawText = rawBytes.toString("utf8");
      const source = parseSourceText(file, rawText);
      sourceFile.size = rawBytes.byteLength;
      sourceFile.contentHash = hashBytes(rawBytes);
      sourceFile.documentHash = hashDocument(source.title ?? basename(file), source.text);
      sourceFile.source = source;
      indexableSourceBytes += rawBytes.byteLength;
    }
    metadata.push(sourceFile);
  }

  return metadata;
}

function readIndexedDocument(rootDir: string, sourceFile: SourceFileMetadata): IndexedDocument {
  const source = requireParsedSource(sourceFile);
  const title = source.title ?? basename(sourceFile.path);

  return {
    id: stableId(normalizeRelativePath(rootDir, sourceFile.path)),
    path: sourceFile.path,
    title,
    text: source.text,
    titleTokens: new Set(tokenize(title)),
    normalizedTitle: normalizeForPhrase(title),
    chunks: chunkText(source.text)
  };
}

function requireParsedSource(sourceFile: SourceFileMetadata): ParsedSourceText {
  if (!sourceFile.source) {
    throw new Error(`Local source file is missing parsed source text: ${sourceFile.relativePath}`);
  }

  return sourceFile.source;
}

async function readLocalSourceBytes(path: string): Promise<Buffer | undefined> {
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const remaining = MAX_LOCAL_SOURCE_BYTES + 1 - totalBytes;
      const buffer = Buffer.alloc(Math.min(LOCAL_SOURCE_READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);

      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes);
      }

      totalBytes += bytesRead;
      if (totalBytes > MAX_LOCAL_SOURCE_BYTES) {
        return undefined;
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

function parseSourceText(file: string, rawText: string): ParsedSourceText {
  const extension = extname(file).toLowerCase();
  if (extension === ".html" || extension === ".htm") {
    const text = htmlToText(rawText);
    return {
      text,
      title: extractHtmlTitle(rawText) ?? firstMeaningfulLine(text)
    };
  }

  return {
    text: rawText,
    title: extractTitle(rawText)
  };
}

function isCacheEntryCurrent(entry: CachedSourceEntry, sourceFile: SourceFileMetadata): boolean {
  return (
    entry.relativePath === sourceFile.relativePath &&
    entry.mtimeMs === sourceFile.mtimeMs &&
    entry.size === sourceFile.size &&
    entry.contentHash === sourceFile.contentHash &&
    entry.documentHash === sourceFile.documentHash &&
    hashDocument(entry.document.title, entry.document.text) === sourceFile.documentHash
  );
}

function hydrateCachedDocument(rootDir: string, entry: CachedSourceEntry): IndexedDocument {
  return {
    id: stableId(entry.relativePath),
    path: join(rootDir, entry.relativePath),
    title: entry.document.title,
    text: entry.document.text,
    titleTokens: new Set(tokenize(entry.document.title)),
    normalizedTitle: normalizeForPhrase(entry.document.title),
    chunks: entry.document.chunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      tokens: new Set(chunk.tokens),
      termFrequencies: new Map(chunk.termFrequencies),
      tokenCount: chunk.tokenCount,
      normalizedText: chunk.normalizedText
    }))
  };
}

function serializeCacheEntry(sourceFile: SourceFileMetadata, document: IndexedDocument): CachedSourceEntry {
  return {
    relativePath: sourceFile.relativePath,
    mtimeMs: sourceFile.mtimeMs,
    size: sourceFile.size,
    contentHash: requireContentHash(sourceFile),
    documentHash: requireDocumentHash(sourceFile),
    document: {
      id: document.id,
      title: document.title,
      text: document.text,
      chunks: document.chunks.map((chunk) => ({
        id: chunk.id,
        text: chunk.text,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        tokens: Array.from(chunk.tokens),
        termFrequencies: Array.from(chunk.termFrequencies.entries()),
        tokenCount: chunk.tokenCount,
        normalizedText: chunk.normalizedText
      }))
    }
  };
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashDocument(title: string, text: string): string {
  return createHash("sha256").update(title).update("\0").update(text).digest("hex");
}

function requireContentHash(sourceFile: SourceFileMetadata): string {
  if (!sourceFile.contentHash) {
    throw new Error(`Local source file is missing a content hash: ${sourceFile.relativePath}`);
  }

  return sourceFile.contentHash;
}

function requireDocumentHash(sourceFile: SourceFileMetadata): string {
  if (!sourceFile.documentHash) {
    throw new Error(`Local source file is missing a document hash: ${sourceFile.relativePath}`);
  }

  return sourceFile.documentHash;
}

async function readLocalIndexCache(rootDir: string): Promise<CachedLocalIndex | undefined> {
  const cacheFile = await readLocalIndexCacheFile(rootDir);
  return cacheFile.exists ? cacheFile.cache : undefined;
}

async function readLocalIndexCacheFile(rootDir: string): Promise<
  | { cachePath: string; exists: false }
  | { cachePath: string; exists: true; cacheBytes: number; cacheSchemaVersion?: number; cache?: CachedLocalIndex; invalidReason?: string }
> {
  const cachePath = getLocalIndexCachePath(rootDir);

  try {
    const cacheStat = await stat(cachePath);
    if (!cacheStat.isFile()) {
      return {
        cachePath,
        exists: true,
        cacheBytes: cacheStat.size,
        invalidReason: `Local index cache must be a file: ${cachePath}`
      };
    }

    if (cacheStat.size > MAX_LOCAL_CACHE_BYTES) {
      return {
        cachePath,
        exists: true,
        cacheBytes: cacheStat.size,
        invalidReason: `Local index cache is larger than ${MAX_LOCAL_CACHE_BYTES} bytes.`
      };
    }
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const cacheSchemaVersion = readCacheSchemaVersion(parsed);
    const parseResult = parseLocalIndexCache(parsed);

    return parseResult.cache
      ? { cachePath, exists: true, cacheBytes: cacheStat.size, cacheSchemaVersion: parseResult.cache.schemaVersion, cache: parseResult.cache }
      : {
          cachePath,
          exists: true,
          cacheBytes: cacheStat.size,
          cacheSchemaVersion,
          invalidReason: parseResult.invalidReason
        };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { cachePath, exists: false };
    }

    return {
      cachePath,
      exists: true,
      cacheBytes: await readCacheFileSize(cachePath),
      invalidReason: "Could not read local index cache. It may be corrupt."
    };
  }
}

async function readCacheFileSize(cachePath: string): Promise<number> {
  try {
    return (await stat(cachePath)).size;
  } catch {
    return 0;
  }
}

async function writeLocalIndexCache(rootDir: string, entries: CachedSourceEntry[]): Promise<void> {
  const cachePath = getLocalIndexCachePath(rootDir);

  await withCachePathLock(cachePath, async () => {
    let tempPath: string | undefined;

    try {
      tempPath = `${cachePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
      const cache: CachedLocalIndex = {
        schemaVersion: LOCAL_INDEX_CACHE_VERSION,
        entries
      };
      const content = `${JSON.stringify(cache, null, 2)}\n`;

      if (new TextEncoder().encode(content).byteLength > MAX_LOCAL_CACHE_BYTES) {
        return;
      }

      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(tempPath, content, "utf8");
      await rename(tempPath, cachePath);
    } catch {
      if (tempPath) {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
      // Local search should keep working even when the source folder is read-only.
    }
  });
}

async function withCachePathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = cacheWriteLocks.get(path) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const token = previous.catch(() => undefined).then(() => current);

  cacheWriteLocks.set(path, token);
  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (cacheWriteLocks.get(path) === token) {
      cacheWriteLocks.delete(path);
    }
  }
}

function getLocalIndexCachePath(rootDir: string): string {
  return join(rootDir, LOCAL_INDEX_CACHE_PATH);
}

function readCacheSchemaVersion(value: unknown): number | undefined {
  return isRecord(value) && isFiniteNumber(value.schemaVersion) ? value.schemaVersion : undefined;
}

function parseLocalIndexCache(value: unknown): { cache?: CachedLocalIndex; invalidReason: string } {
  if (!isRecord(value) || value.schemaVersion !== LOCAL_INDEX_CACHE_VERSION) {
    return { invalidReason: `Unsupported local index cache schema. Expected version ${LOCAL_INDEX_CACHE_VERSION}.` };
  }
  if (!Array.isArray(value.entries)) {
    return { invalidReason: "Invalid local index cache structure." };
  }

  const entries: CachedSourceEntry[] = [];
  for (const entry of value.entries) {
    const parsed = parseCachedSourceEntry(entry);
    if (!parsed) {
      return { invalidReason: "Invalid local index cache structure." };
    }
    entries.push(parsed);
  }

  return {
    cache: {
      schemaVersion: LOCAL_INDEX_CACHE_VERSION,
      entries
    },
    invalidReason: ""
  };
}

function parseCachedSourceEntry(value: unknown): CachedSourceEntry | undefined {
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.mtimeMs) ||
    !isFiniteNumber(value.size) ||
    typeof value.relativePath !== "string" ||
    typeof value.contentHash !== "string" ||
    !isSafeContentHash(value.contentHash) ||
    typeof value.documentHash !== "string" ||
    !isSafeContentHash(value.documentHash)
  ) {
    return undefined;
  }

  const relativePath = normalizeCacheRelativePath(value.relativePath);
  if (!isSafeCacheRelativePath(relativePath)) {
    return undefined;
  }

  const document = parseCachedIndexedDocument(value.document);
  if (!document) {
    return undefined;
  }

  return {
    relativePath,
    mtimeMs: value.mtimeMs,
    size: value.size,
    contentHash: value.contentHash,
    documentHash: value.documentHash,
    document
  };
}

function isSafeContentHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function parseCachedIndexedDocument(value: unknown): CachedIndexedDocument | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.text !== "string") {
    return undefined;
  }
  if (!Array.isArray(value.chunks)) {
    return undefined;
  }

  const chunks: CachedLocalChunk[] = [];
  for (const chunk of value.chunks) {
    const parsed = parseCachedLocalChunk(chunk);
    if (!parsed) {
      return undefined;
    }
    chunks.push(parsed);
  }
  if (!hasConsistentCachedChunks(value.text, chunks)) {
    return undefined;
  }

  return {
    id: value.id,
    title: value.title,
    text: value.text,
    chunks
  };
}

function hasConsistentCachedChunks(text: string, chunks: CachedLocalChunk[]): boolean {
  const expectedChunks = chunkText(text);
  if (expectedChunks.length !== chunks.length) {
    return false;
  }

  return chunks.every((chunk, index) => {
    const expected = expectedChunks[index];
    return (
      expected !== undefined &&
      chunk.id === expected.id &&
      chunk.text === expected.text &&
      chunk.startLine === expected.startLine &&
      chunk.endLine === expected.endLine &&
      chunk.tokenCount === expected.tokenCount &&
      chunk.normalizedText === expected.normalizedText &&
      arraysEqual(chunk.tokens, Array.from(expected.tokens)) &&
      termFrequenciesEqual(chunk.termFrequencies, expected.termFrequencies)
    );
  });
}

function termFrequenciesEqual(actual: Array<[string, number]>, expected: Map<string, number>): boolean {
  if (actual.length !== expected.size) {
    return false;
  }

  return actual.every(([token, frequency]) => expected.get(token) === frequency);
}

function arraysEqual<T>(actual: T[], expected: T[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function parseCachedLocalChunk(value: unknown): CachedLocalChunk | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.text !== "string" ||
    !isSafeChunkId(value.id) ||
    value.text.trim().length === 0 ||
    !isPositiveInteger(value.startLine) ||
    !isPositiveInteger(value.endLine) ||
    value.endLine < value.startLine ||
    !isNonNegativeInteger(value.tokenCount) ||
    typeof value.normalizedText !== "string" ||
    !isStringArray(value.tokens)
  ) {
    return undefined;
  }

  const termFrequencies = parseTermFrequencies(value.termFrequencies);
  if (!termFrequencies || !hasConsistentTokenMetadata(value.tokens, termFrequencies, value.tokenCount)) {
    return undefined;
  }

  return {
    id: value.id,
    text: value.text,
    startLine: value.startLine,
    endLine: value.endLine,
    tokens: value.tokens,
    termFrequencies,
    tokenCount: value.tokenCount,
    normalizedText: value.normalizedText
  };
}

function isSafeChunkId(value: string): boolean {
  return /^chunk-[1-9]\d*$/.test(value);
}

function parseTermFrequencies(value: unknown): Array<[string, number]> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const frequencies: Array<[string, number]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[0].length === 0 || !isPositiveInteger(entry[1])) {
      return undefined;
    }
    frequencies.push([entry[0], entry[1]]);
  }

  return frequencies;
}

function hasConsistentTokenMetadata(tokens: string[], termFrequencies: Array<[string, number]>, tokenCount: number): boolean {
  const tokenSet = new Set(tokens);
  if (tokenSet.size !== tokens.length || tokenSet.size !== termFrequencies.length) {
    return false;
  }

  let totalFrequency = 0;
  const frequencyTokens = new Set<string>();
  for (const [token, frequency] of termFrequencies) {
    if (!tokenSet.has(token) || frequencyTokens.has(token)) {
      return false;
    }

    frequencyTokens.add(token);
    totalFrequency += frequency;
  }

  return totalFrequency === tokenCount;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function sumSourceBytes(sourceFiles: SourceFileMetadata[]): number {
  return sourceFiles.reduce((total, sourceFile) => total + sourceFile.size, 0);
}

function normalizeRelativePath(rootDir: string, path: string): string {
  return relative(rootDir, path).replace(/\\/g, "/");
}

function normalizeCacheRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isSafeCacheRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || /^[a-z]:/i.test(path)) {
    return false;
  }

  return !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function buildSearchIndex(documents: IndexedDocument[]): LocalSearchIndex {
  const chunkEntries = documents.flatMap((document) =>
    document.chunks.map((chunk): IndexedChunk => ({
      key: `${document.id}\0${chunk.id}`,
      document,
      chunk
    }))
  );
  const postingLists = new Map<string, IndexedChunk[]>();
  const documentFrequencies = new Map<string, number>();
  let totalTokenCount = 0;

  for (const entry of chunkEntries) {
    totalTokenCount += entry.chunk.tokenCount;
    for (const token of entry.chunk.tokens) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
      const postings = postingLists.get(token);
      if (postings) {
        postings.push(entry);
      } else {
        postingLists.set(token, [entry]);
      }
    }
  }

  return {
    documents,
    postingLists,
    totalChunks: chunkEntries.length,
    averageChunkLength: chunkEntries.length > 0 ? totalTokenCount / chunkEntries.length : 0,
    documentFrequencies
  };
}

function collectCandidateChunks(queryTokens: string[], index: LocalSearchIndex): IndexedChunk[] {
  const candidates = new Map<string, IndexedChunk>();

  for (const token of queryTokens) {
    const postings = index.postingLists.get(token);
    if (!postings) {
      continue;
    }
    for (const entry of postings) {
      candidates.set(entry.key, entry);
    }
  }

  return Array.from(candidates.values());
}

function compareScoredChunks(
  a: { document: IndexedDocument; chunk: LocalChunk; score: ChunkScore },
  b: { document: IndexedDocument; chunk: LocalChunk; score: ChunkScore }
): number {
  const scoreDifference = b.score.value - a.score.value;
  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  const pathComparison = a.document.path.localeCompare(b.document.path);
  if (pathComparison !== 0) {
    return pathComparison;
  }

  return a.chunk.startLine - b.chunk.startLine || a.chunk.endLine - b.chunk.endLine || a.chunk.id.localeCompare(b.chunk.id);
}

async function listSourceFiles(rootDir: string, ignoreRules: IgnoreRule[]): Promise<string[]> {
  const rootStat = await stat(rootDir);
  if (!rootStat.isDirectory()) {
    throw new Error(`--sources must point to a directory: ${rootDir}`);
  }

  const files: string[] = [];
  await walk(rootDir, rootDir, files, ignoreRules, 0);
  return files.sort((a, b) => normalizeRelativePath(rootDir, a).localeCompare(normalizeRelativePath(rootDir, b)));
}

async function walk(rootDir: string, dir: string, files: string[], ignoreRules: IgnoreRule[], depth: number): Promise<void> {
  if (depth > MAX_LOCAL_DIRECTORY_DEPTH) {
    throw new Error(`Local source directory nesting must be at most ${MAX_LOCAL_DIRECTORY_DEPTH} levels: ${dir}`);
  }

  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(dir, entry.name);
    const relativePath = relative(rootDir, path).replace(/\\/g, "/");
    const ignored = isIgnored(relativePath, entry.isDirectory(), ignoreRules);

    if (entry.isDirectory()) {
      if (ignored && !mayContainNegatedPath(relativePath, ignoreRules)) {
        continue;
      }
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === ".sourceline") {
        continue;
      }
      await walk(rootDir, path, files, ignoreRules, depth + 1);
      continue;
    }

    if (!ignored && entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      if (files.length >= MAX_LOCAL_SOURCE_FILES) {
        throw new Error(`Local sources must contain at most ${MAX_LOCAL_SOURCE_FILES} supported files: ${rootDir}`);
      }
      files.push(path);
    }
  }
}

async function loadIgnoreRules(rootDir: string): Promise<IgnoreRule[]> {
  const candidateFiles = [resolve(process.cwd(), ".sourcelineignore"), join(rootDir, ".sourcelineignore")];
  const seen = new Set<string>();
  const rules: IgnoreRule[] = [];

  for (const candidate of candidateFiles) {
    if (seen.has(candidate) || !(await fileExists(candidate))) {
      continue;
    }
    seen.add(candidate);
    const ignoreStat = await stat(candidate);
    if (!ignoreStat.isFile()) {
      throw new Error(`Local ignore file must be a file: ${candidate}`);
    }
    if (ignoreStat.size > MAX_IGNORE_FILE_BYTES) {
      throw new Error(`Local ignore file is larger than ${MAX_IGNORE_FILE_BYTES} bytes: ${candidate}`);
    }
    const raw = await readFile(candidate, "utf8");
    for (const [lineIndex, line] of raw.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }
      if (hasControlCharacters(trimmed)) {
        throw new Error(`Local ignore rule must not contain control characters: ${candidate}:${lineIndex + 1}`);
      }
      const negated = trimmed.startsWith("!");
      const pattern = negated ? trimmed.slice(1).trim() : trimmed;
      if (pattern.length === 0) {
        continue;
      }
      if (pattern.length > MAX_IGNORE_PATTERN_CHARS) {
        throw new Error(`Local ignore rule must be at most ${MAX_IGNORE_PATTERN_CHARS} characters: ${candidate}:${lineIndex + 1}`);
      }
      if (rules.length >= MAX_IGNORE_RULES) {
        throw new Error(`Local ignore files must define at most ${MAX_IGNORE_RULES} rules.`);
      }
      rules.push({
        raw: trimmed,
        regex: ignorePatternToRegex(pattern),
        negated,
        normalizedPattern: normalizeIgnorePattern(pattern)
      });
    }
  }

  return rules;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isIgnored(relativePath: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
  const normalized = isDirectory ? `${relativePath}/` : relativePath;
  let ignored = false;

  for (const rule of rules) {
    if (rule.regex.test(normalized)) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

function mayContainNegatedPath(relativePath: string, rules: IgnoreRule[]): boolean {
  const prefix = `${relativePath.replace(/\/+$/, "")}/`;
  return rules.some((rule) => {
    if (!rule.negated) {
      return false;
    }

    const pattern = rule.normalizedPattern;
    return !pattern.includes("/") || pattern.startsWith(prefix) || prefix.startsWith(pattern.replace(/\/+$/, "/"));
  });
}

function ignorePatternToRegex(pattern: string): RegExp {
  const normalized = normalizeIgnorePattern(pattern);
  const directoryPattern = normalized.endsWith("/");
  const body = directoryPattern ? normalized.slice(0, -1) : normalized;
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  const prefix = body.includes("/") ? "^" : "(^|.*/)";
  const suffix = directoryPattern ? "(/.*)?$" : "$";

  return new RegExp(`${prefix}${escaped}${suffix}`);
}

function normalizeIgnorePattern(pattern: string): string {
  return pattern.replace(/\\/g, "/").replace(/^\/+/, "");
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function chunkText(text: string): LocalChunk[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const chunks: LocalChunk[] = [];
  let current: string[] = [];
  let startLine = 1;

  const flush = (endLine: number): void => {
    const chunk = current.join("\n").trim();
    if (chunk.length === 0) {
      current = [];
      return;
    }

    const tokens = tokenize(chunk);
    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      text: chunk,
      startLine,
      endLine,
      tokens: new Set(tokens),
      termFrequencies: buildTermFrequencies(tokens),
      tokenCount: tokens.length,
      normalizedText: normalizeForPhrase(chunk)
    });
    current = [];
  };

  lines.forEach((line, index) => {
    if (line.trim().length === 0) {
      flush(index);
      startLine = index + 2;
      return;
    }

    if (current.length === 0) {
      startLine = index + 1;
    }
    current.push(line);
  });

  flush(lines.length);
  return chunks;
}

function scoreChunk(
  queryTokens: string[],
  queryPhrases: string[],
  chunk: LocalChunk,
  document: IndexedDocument,
  index: LocalSearchIndex
): ChunkScore {
  const uniqueTokens = Array.from(new Set(queryTokens));
  const bodyMatches = uniqueTokens.filter((token) => chunk.tokens.has(token));
  const titleMatches = uniqueTokens.filter((token) => document.titleTokens.has(token));
  const matchedTerms = Array.from(new Set([...bodyMatches, ...titleMatches]));
  const bodyPhraseMatches = queryPhrases.filter((phrase) => chunk.normalizedText.includes(phrase));
  const titlePhraseMatches = queryPhrases.filter((phrase) => document.normalizedTitle.includes(phrase));
  const phraseMatches = Array.from(new Set([...bodyPhraseMatches, ...titlePhraseMatches]));
  let bm25Score = 0;
  let titleScore = 0;

  for (const token of uniqueTokens) {
    bm25Score += bm25(token, chunk, index);
    if (bodyMatches.length > 0 && document.titleTokens.has(token)) {
      titleScore += idf(token, index) * 0.85;
    }
  }

  const phraseScore = bodyPhraseMatches.length * 1.1 + (bodyMatches.length > 0 ? titlePhraseMatches.length * 0.45 : 0);
  const coverage = matchedTerms.length / uniqueTokens.length;
  const value = bm25Score + titleScore + phraseScore + coverage;

  if (value <= 0 || (bodyMatches.length === 0 && bodyPhraseMatches.length === 0)) {
    return {
      value: 0,
      matchedTerms: bodyMatches,
      titleMatches,
      phraseMatches,
      explanation: "No query terms matched this chunk."
    };
  }

  return {
    value,
    matchedTerms,
    titleMatches,
    phraseMatches,
    explanation: formatScoreExplanation({
      matchedTerms,
      titleMatches,
      phraseMatches,
      queryTermCount: uniqueTokens.length,
      bm25Score,
      titleScore,
      phraseScore
    })
  };
}

function bm25(token: string, chunk: LocalChunk, index: LocalSearchIndex): number {
  const frequency = chunk.termFrequencies.get(token) ?? 0;
  if (frequency === 0) {
    return 0;
  }

  const k1 = 1.2;
  const b = 0.75;
  const averageLength = Math.max(index.averageChunkLength, 1);
  const lengthNorm = 1 - b + b * (chunk.tokenCount / averageLength);
  return idf(token, index) * ((frequency * (k1 + 1)) / (frequency + k1 * lengthNorm));
}

function idf(token: string, index: LocalSearchIndex): number {
  const totalChunks = Math.max(index.totalChunks, 1);
  const frequency = index.documentFrequencies.get(token) ?? 0;
  return Math.log(1 + (totalChunks - frequency + 0.5) / (frequency + 0.5));
}

function formatScoreExplanation(options: {
  matchedTerms: string[];
  titleMatches: string[];
  phraseMatches: string[];
  queryTermCount: number;
  bm25Score: number;
  titleScore: number;
  phraseScore: number;
}): string {
  const parts = [
    `${options.matchedTerms.length}/${options.queryTermCount} query terms matched (${options.matchedTerms.join(", ")})`,
    `BM25 ${roundScore(options.bm25Score)}`
  ];

  if (options.titleMatches.length > 0) {
    parts.push(`title boost ${roundScore(options.titleScore)} from ${options.titleMatches.join(", ")}`);
  }
  if (options.phraseMatches.length > 0) {
    parts.push(`phrase boost ${roundScore(options.phraseScore)} from "${options.phraseMatches.join('", "')}"`);
  }

  return `${parts.join("; ")}.`;
}

function buildTermFrequencies(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();

  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  return frequencies;
}

function buildQueryPhrases(tokens: string[]): string[] {
  const phrases: string[] = [];

  for (let index = 0; index < tokens.length - 1; index += 1) {
    phrases.push(`${tokens[index]} ${tokens[index + 1]}`);
  }

  return Array.from(new Set(phrases));
}

function buildSnippet(text: string, matchedTerms: string[]): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 360 || matchedTerms.length === 0) {
    return compact;
  }

  const lower = compact.toLowerCase();
  const firstMatch = matchedTerms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (firstMatch === undefined) {
    return `${compact.slice(0, 357)}...`;
  }

  const start = Math.max(0, firstMatch - 120);
  const end = Math.min(compact.length, firstMatch + 240);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];

  for (const rawToken of text.toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? []) {
    tokens.push(...tokenizeMixedToken(rawToken));
  }

  return tokens;
}

function normalizeLocalOutputText(value: string, maxLength: number, collapseWhitespace = false): string | undefined {
  return normalizeOptionalText(value, { collapseWhitespace, maxLength });
}

function normalizeLocalMatchedTerms(terms: string[]): string[] {
  return terms
    .map((term) => normalizeLocalOutputText(term, MAX_LOCAL_SEARCH_QUERY_CHARS, true))
    .filter((term): term is string => term !== undefined)
    .slice(0, MAX_LOCAL_MATCHED_TERMS);
}

function tokenizeMixedToken(value: string): string[] {
  const tokens: string[] = [];
  const segments = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [];

  for (const segment of segments) {
    if (isCjkRun(segment)) {
      tokens.push(...tokenizeCjkRun(segment));
    } else if (segment.length > 2 && !STOP_WORDS.has(segment)) {
      tokens.push(segment);
    }
  }

  return tokens;
}

function isCjkRun(value: string): boolean {
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(value);
}

function tokenizeCjkRun(value: string): string[] {
  if (value.length === 1) {
    return [value];
  }

  const tokens: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    tokens.push(value.slice(index, index + 2));
  }
  return tokens;
}

function normalizeForPhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(text: string): string | undefined {
  const titleLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("#"));

  return titleLine?.replace(/^#+\s*/, "").trim();
}

function extractHtmlTitle(html: string): string | undefined {
  const visibleHead = visibleHtmlHead(html);
  const visibleBody = visibleHtmlBody(html);
  const rawTitle =
    visibleHead.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
    extractHeadlessHtmlTitle(html) ??
    visibleBody.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (!rawTitle) {
    return undefined;
  }

  return htmlToText(rawTitle).replace(/\s+/g, " ").trim() || undefined;
}

function extractHeadlessHtmlTitle(html: string): string | undefined {
  const titleSource = sanitizeHeadlessHtmlTitleSource(html);
  if (/<head\b/i.test(titleSource) || /<body\b/i.test(titleSource)) {
    return undefined;
  }

  const metadataPrefix = titleSource
    .replace(/<!doctype\b[^>]*>/gi, " ")
    .replace(/^\s*<html\b[^>]*>/i, "")
    .match(/^\s*(?:<(?:meta|link|base)\b[^>]*>\s*)*<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return metadataPrefix?.[1];
}

function sanitizeHeadlessHtmlTitleSource(html: string): string {
  return removeHtmlNonContentElements(removeHtmlComments(html));
}

function firstMeaningfulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function htmlToText(html: string): string {
  return visibleHtmlBody(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(p|div|section|article|header|footer|main|aside|nav|li|h[1-6]|blockquote|tr)\b[^>]*>/gi, "\n\n")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|li|h[1-6]|blockquote|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(HTML_ENTITY_PATTERN, decodeHtmlEntity)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntity(
  match: string,
  decimalCodePoint: string | undefined,
  hexadecimalCodePoint: string | undefined,
  namedEntity: string | undefined
): string {
  if (namedEntity !== undefined) {
    return HTML_NAMED_ENTITIES[namedEntity.toLowerCase()] ?? match;
  }

  return hexadecimalCodePoint === undefined
    ? decodeHtmlCodePoint(decimalCodePoint ?? "", 10, match)
    : decodeHtmlCodePoint(hexadecimalCodePoint, 16, match);
}

function visibleHtmlBody(html: string): string {
  const visibleHtml = removeHtmlNonContentElements(removeHtmlComments(html));
  const body = visibleHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? visibleHtml;
  return removeHiddenHtmlElements(body);
}

function removeHiddenHtmlElements(html: string): string {
  return html.replace(HIDDEN_HTML_ELEMENT_PATTERN, " ");
}

function visibleHtmlHead(html: string): string {
  const visibleHtml = removeHtmlNonContentElements(removeHtmlComments(html));
  return visibleHtml.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
}

function removeHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ");
}

function removeHtmlNonContentElements(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ");
}

function decodeHtmlCodePoint(value: string, radix: number, fallback: string): string {
  const codePoint = Number.parseInt(value, radix);
  if (
    !Number.isSafeInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  ) {
    return fallback;
  }

  return String.fromCodePoint(codePoint);
}

function stableId(value: string): string {
  const normalized = value.toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (slug.length > 0 && !hasNonAscii(value)) {
    return slug;
  }

  const hash = stableHash(normalized);
  const prefix = slug.length > 0 ? slug.slice(0, Math.max(1, 80 - hash.length - 1)) : "source";
  return `${prefix}-${hash}`;
}

function hasNonAscii(value: string): boolean {
  return /[^\u0000-\u007f]/.test(value);
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36);
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "into",
  "from",
  "than",
  "then",
  "before",
  "after",
  "every",
  "most",
  "can",
  "will",
  "would",
  "could",
  "should",
  "also",
  "make",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "its",
  "their",
  "your",
  "our"
]);
