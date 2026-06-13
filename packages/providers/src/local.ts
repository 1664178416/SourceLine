import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { SearchProvider, SearchResult } from "@sourceline/core";

const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".html", ".htm"]);
const LOCAL_INDEX_CACHE_VERSION = 3;
const LOCAL_INDEX_CACHE_PATH = join(".sourceline", "cache", "local-index.json");

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
};

type CachedLocalIndex = {
  schemaVersion: typeof LOCAL_INDEX_CACHE_VERSION;
  entries: CachedSourceEntry[];
};

type CachedSourceEntry = {
  relativePath: string;
  mtimeMs: number;
  size: number;
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
      indexPromise ??= buildIndex(rootDir);
      const index = await indexPromise;
      const queryTokens = tokenize(query.query);
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
        .slice(0, query.maxResults)
        .map((item, index): SearchResult => {
          const rank = index + 1;
          const path = relative(process.cwd(), item.document.path).replace(/\\/g, "/");
          const snippet = buildSnippet(item.chunk.text, item.score.matchedTerms);

          return {
            id: `${item.document.id}#${item.chunk.id}`,
            title: `${item.document.title} lines ${item.chunk.startLine}-${item.chunk.endLine}`,
            path,
            retrievedAt: now().toISOString(),
            snippet,
            text: item.chunk.text,
            retrieval: {
              score: roundScore(item.score.value),
              matchedTerms: item.score.matchedTerms,
              explanation: item.score.explanation
            },
            provider: "local",
            rank,
            query: query.query
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
  const sourceFilesByPath = new Map(sourceFiles.map((file) => [file.relativePath, file]));
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
      entries: 0,
      currentEntries: 0,
      staleEntries: 0,
      missingEntries: 0,
      uncachedSourceFiles: sourceFiles.length,
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
      entries: 0,
      currentEntries: 0,
      staleEntries: 0,
      missingEntries: 0,
      uncachedSourceFiles: sourceFiles.length,
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
    entries: cacheFile.cache.entries.length,
    currentEntries,
    staleEntries,
    missingEntries,
    uncachedSourceFiles: sourceFiles.filter((sourceFile) => !cachedSourcePaths.has(sourceFile.relativePath)).length,
    chunks: cacheFile.cache.entries.reduce((total, entry) => total + entry.document.chunks.length, 0)
  };
}

export async function clearLocalIndexCache(options: { rootDir: string }): Promise<LocalIndexCacheClearResult> {
  const rootDir = normalizeRootDir(options.rootDir);
  const cachePath = getLocalIndexCachePath(rootDir);
  const removed = await fileExists(cachePath);

  await rm(cachePath, { force: true });

  return {
    cachePath,
    removed
  };
}

function normalizeRootDir(rootDir: string): string {
  const trimmed = rootDir.trim();
  if (trimmed.length === 0) {
    throw new Error("Local sources rootDir must not be empty.");
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

  for (const sourceFile of sourceFiles) {
    const cachedEntry = cachedEntries.get(sourceFile.relativePath);
    const document =
      cachedEntry && isCacheEntryCurrent(cachedEntry, sourceFile)
        ? hydrateCachedDocument(rootDir, cachedEntry)
        : await readIndexedDocument(rootDir, sourceFile.path);

    documents.push(document);
    nextCacheEntries.push(serializeCacheEntry(sourceFile, document));
  }

  await writeLocalIndexCache(rootDir, nextCacheEntries);
  return buildSearchIndex(documents);
}

async function readSourceFileMetadata(rootDir: string, files: string[]): Promise<SourceFileMetadata[]> {
  const metadata: SourceFileMetadata[] = [];

  for (const file of files) {
    const fileStat = await stat(file);
    metadata.push({
      path: file,
      relativePath: normalizeRelativePath(rootDir, file),
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size
    });
  }

  return metadata;
}

async function readIndexedDocument(rootDir: string, file: string): Promise<IndexedDocument> {
  const rawText = await readFile(file, "utf8");
  const source = parseSourceText(file, rawText);
  const title = source.title ?? basename(file);

  return {
    id: stableId(normalizeRelativePath(rootDir, file)),
    path: file,
    title,
    text: source.text,
    titleTokens: new Set(tokenize(title)),
    normalizedTitle: normalizeForPhrase(title),
    chunks: chunkText(source.text)
  };
}

function parseSourceText(file: string, rawText: string): { text: string; title?: string } {
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
  return entry.relativePath === sourceFile.relativePath && entry.mtimeMs === sourceFile.mtimeMs && entry.size === sourceFile.size;
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
  let tempPath: string | undefined;

  try {
    const cachePath = getLocalIndexCachePath(rootDir);
    tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    const cache: CachedLocalIndex = {
      schemaVersion: LOCAL_INDEX_CACHE_VERSION,
      entries
    };

    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    await rename(tempPath, cachePath);
  } catch {
    if (tempPath) {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
    // Local search should keep working even when the source folder is read-only.
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
  if (!isRecord(value) || !isFiniteNumber(value.mtimeMs) || !isFiniteNumber(value.size) || typeof value.relativePath !== "string") {
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
    document
  };
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

  return {
    id: value.id,
    title: value.title,
    text: value.text,
    chunks
  };
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
  await walk(rootDir, rootDir, files, ignoreRules);
  return files.sort((a, b) => normalizeRelativePath(rootDir, a).localeCompare(normalizeRelativePath(rootDir, b)));
}

async function walk(rootDir: string, dir: string, files: string[], ignoreRules: IgnoreRule[]): Promise<void> {
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
      await walk(rootDir, path, files, ignoreRules);
      continue;
    }

    if (!ignored && entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
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
    const raw = await readFile(candidate, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }
      const negated = trimmed.startsWith("!");
      const pattern = negated ? trimmed.slice(1).trim() : trimmed;
      if (pattern.length === 0) {
        continue;
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
  const rawTitle =
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (!rawTitle) {
    return undefined;
  }

  return htmlToText(rawTitle).replace(/\s+/g, " ").trim() || undefined;
}

function firstMeaningfulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function htmlToText(html: string): string {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;

  return body
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(p|div|section|article|header|footer|main|aside|nav|li|h[1-6]|blockquote|tr)\b[^>]*>/gi, "\n\n")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|li|h[1-6]|blockquote|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, codePoint: string) => decodeHtmlCodePoint(codePoint, 10, match))
    .replace(/&#x([0-9a-f]+);/gi, (match, codePoint: string) => decodeHtmlCodePoint(codePoint, 16, match))
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlCodePoint(value: string, radix: number, fallback: string): string {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return fallback;
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
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
