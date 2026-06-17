import { loadInput } from "./input.js";
import { dedupeClaims, dedupeSearchResults } from "./normalize.js";
import { segmentDocument } from "./segment.js";
import { summarizeChecks } from "./summary.js";
import type {
  CheckOptions,
  Claim,
  ClaimCheck,
  EvidenceItem,
  EvidenceRelation,
  RiskFlag,
  SearchResult,
  SourceLineReport,
  VerificationStatus
} from "./types.js";

const DEFAULT_MAX_CLAIMS = 30;
const DEFAULT_MAX_RESULTS_PER_CLAIM = 5;
const DEFAULT_MIN_CONFIDENCE = 0.65;
const MAX_CLAIMS = 100;
const MAX_RESULTS_PER_CLAIM = 20;
const MAX_SEARCH_QUERIES_PER_CLAIM = 5;
const MAX_SEARCH_QUERY_CHARS = 500;
const MAX_INLINE_TEXT_CHARS = 2_000;
const MAX_IDENTIFIER_CHARS = 200;
const MAX_EXPLANATION_CHARS = 4_000;
const MAX_EVIDENCE_SNIPPET_CHARS = 2_000;
const MAX_EVIDENCE_TEXT_CHARS = 20_000;
const TRUNCATION_MARKER = "... [truncated]";
const VALID_CLAIM_TYPES = new Set<Claim["claimType"]>([
  "statistical",
  "historical",
  "scientific",
  "legal_or_policy",
  "biographical",
  "technical",
  "general_factual"
]);
const VALID_IMPORTANCE = new Set<Claim["importance"]>(["high", "medium", "low"]);
const VALID_STATUSES = new Set<VerificationStatus>([
  "supported",
  "partially_supported",
  "unsupported",
  "contradicted",
  "not_enough_evidence"
]);
const VALID_EVIDENCE_RELATIONS = new Set<EvidenceRelation>([
  "supports",
  "partially_supports",
  "contradicts",
  "related",
  "irrelevant"
]);
const VALID_RISK_FLAGS = new Set<RiskFlag>([
  "no_source_found",
  "weak_source",
  "stale_source",
  "source_paywalled",
  "ambiguous_claim",
  "overgeneralized_claim",
  "requires_expert_review"
]);

export async function runCheck(options: CheckOptions): Promise<SourceLineReport> {
  const maxClaims = resolvePositiveIntegerOption(options.maxClaims, DEFAULT_MAX_CLAIMS, "maxClaims", MAX_CLAIMS);
  const maxResultsPerClaim = resolvePositiveIntegerOption(
    options.maxResultsPerClaim,
    DEFAULT_MAX_RESULTS_PER_CLAIM,
    "maxResultsPerClaim",
    MAX_RESULTS_PER_CLAIM
  );
  const minConfidence = resolveConfidenceOption(options.minConfidence, DEFAULT_MIN_CONFIDENCE);
  const now = options.now ?? (() => new Date());

  const input = await loadInput(options.input);
  const segments = segmentDocument(input.text);
  const extracted = await options.llmProvider.extractClaims({
    text: input.text,
    segments,
    maxClaims
  });
  const claims = dedupeClaims(normalizeExtractedClaims((extracted as { claims?: unknown } | undefined)?.claims))
    .slice(0, maxClaims)
    .map((claim, index) => normalizeClaim(claim, `claim-${index + 1}`));
  const checks: ClaimCheck[] = [];
  const searchCache = new Map<string, Promise<SearchResult[]>>();

  for (const claim of claims) {
    const evidence = options.searchProvider
      ? await retrieveEvidence({
          claimId: claim.id,
          queries: prepareSearchQueries(claim.searchQueries, claim.text),
          searchProvider: options.searchProvider,
          maxResultsPerClaim,
          searchCache
        })
      : [];

    const check = await options.llmProvider.verifyClaim({
      claim,
      evidence,
      minConfidence
    });

    checks.push(normalizeCheck(check, claim));
  }

  return {
    schemaVersion: "1.0",
    input: {
      kind: input.kind,
      name: input.name,
      hash: input.hash
    },
    generatedAt: now().toISOString(),
    summary: summarizeChecks(checks),
    checks
  };
}

function resolvePositiveIntegerOption(value: number | undefined, fallback: number, label: string, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  if (value > max) {
    throw new Error(`${label} must be at most ${max}.`);
  }

  return value;
}

function resolveConfidenceOption(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("minConfidence must be a number between 0 and 1.");
  }

  return value;
}
function normalizeCheck(check: ClaimCheck, canonicalClaim: Claim): ClaimCheck {
  return {
    ...check,
    claim: canonicalClaim,
    status: normalizeStatus(check.status),
    confidence: normalizeConfidence(check.confidence),
    riskFlags: normalizeRiskFlags(check.riskFlags),
    evidence: normalizeEvidenceItems(check.evidence),
    explanation: truncateText(sanitizeInlineText(typeof check.explanation === "string" ? check.explanation : ""), MAX_EXPLANATION_CHARS)
  };
}

function normalizeEvidenceItems(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(normalizeEvidenceItem).filter((item): item is EvidenceItem => item !== undefined);
}

function normalizeEvidenceItem(value: unknown): EvidenceItem | undefined {
  if (!isRecord(value) || !isRecord(value.source)) {
    return undefined;
  }

  const quotedSupport =
    typeof value.quotedSupport === "string" ? truncateText(sanitizeInlineText(value.quotedSupport), MAX_EXPLANATION_CHARS) : "";

  return {
    source: sanitizeEvidenceSource(value.source as EvidenceItem["source"]),
    relation: normalizeEvidenceRelation(value.relation as EvidenceRelation),
    confidence: normalizeConfidence(value.confidence),
    quotedSupport: quotedSupport.length > 0 ? quotedSupport : undefined,
    explanation: truncateText(sanitizeInlineText(typeof value.explanation === "string" ? value.explanation : ""), MAX_EXPLANATION_CHARS)
  };
}

function normalizeExtractedClaims(value: unknown): Claim[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(normalizeExtractedClaim).filter((claim): claim is Claim => claim !== undefined);
}

function normalizeExtractedClaim(value: unknown, index: number): Claim | undefined {
  if (!isRecord(value) || typeof value.text !== "string") {
    return undefined;
  }

  const text = truncateText(sanitizeInlineText(value.text), MAX_INLINE_TEXT_CHARS);
  if (text.length === 0) {
    return undefined;
  }

  const searchQueries = Array.isArray(value.searchQueries)
    ? value.searchQueries.filter((query): query is string => typeof query === "string")
    : [];

  return {
    id: typeof value.id === "string" ? value.id : `claim-${index + 1}`,
    text,
    sourceSpan: isRecord(value.sourceSpan) ? (value.sourceSpan as Claim["sourceSpan"]) : undefined,
    claimType: value.claimType as Claim["claimType"],
    importance: value.importance as Claim["importance"],
    searchQueries
  };
}

function normalizeClaim(claim: Claim, fallbackId = "claim"): Claim {
  const text = truncateText(sanitizeInlineText(claim.text), MAX_INLINE_TEXT_CHARS) || "Untitled claim.";
  return {
    ...claim,
    id: normalizeClaimId(claim.id, fallbackId),
    text,
    sourceSpan: normalizeSourceSpan(claim.sourceSpan),
    claimType: normalizeClaimType(claim.claimType),
    importance: normalizeImportance(claim.importance),
    searchQueries: prepareSearchQueries(claim.searchQueries, text)
  };
}

function normalizeSourceSpan(sourceSpan: Claim["sourceSpan"]): Claim["sourceSpan"] {
  if (!sourceSpan) {
    return undefined;
  }

  const normalized: NonNullable<Claim["sourceSpan"]> = {};
  const startLine = normalizePositiveInteger(sourceSpan.startLine);
  const endLine = normalizePositiveInteger(sourceSpan.endLine);
  const hasValidRange = startLine === undefined || endLine === undefined || endLine >= startLine;

  if (hasValidRange && startLine !== undefined) {
    normalized.startLine = startLine;
  }
  if (hasValidRange && endLine !== undefined) {
    normalized.endLine = endLine;
  }
  if (sourceSpan.quote !== undefined) {
    const quote = truncateText(sanitizeInlineText(sourceSpan.quote), MAX_INLINE_TEXT_CHARS);
    if (quote.length > 0) {
      normalized.quote = quote;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return undefined;
  }

  return Math.trunc(value);
}

function normalizeClaimId(id: string, fallback: string): string {
  const normalized = normalizeIdentifierText(id);
  const slug = slugifyIdentifier(normalized);
  const fallbackSlug = slugifyIdentifier(normalizeIdentifierText(fallback)) || "id";
  const bounded = truncateIdentifier(slug);

  if (bounded.length > 0) {
    return bounded;
  }

  return normalized.length > 0 ? truncateIdentifier(`${fallbackSlug}-${stableHash(normalized)}`) : fallbackSlug;
}

function normalizeIdentifierText(value: string): string {
  return stripAnsi(value)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .trim()
    .toLowerCase();
}

function slugifyIdentifier(value: string): string {
  return value.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function truncateIdentifier(value: string): string {
  return value.length > MAX_IDENTIFIER_CHARS ? value.slice(0, MAX_IDENTIFIER_CHARS).replace(/-+$/g, "") : value;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36);
}

function normalizeClaimType(claimType: Claim["claimType"]): Claim["claimType"] {
  return VALID_CLAIM_TYPES.has(claimType) ? claimType : "general_factual";
}

function normalizeImportance(importance: Claim["importance"]): Claim["importance"] {
  return VALID_IMPORTANCE.has(importance) ? importance : "medium";
}

function normalizeStatus(status: VerificationStatus): VerificationStatus {
  return VALID_STATUSES.has(status) ? status : "not_enough_evidence";
}

function normalizeEvidenceRelation(relation: EvidenceRelation): EvidenceRelation {
  return VALID_EVIDENCE_RELATIONS.has(relation) ? relation : "related";
}

function normalizeRiskFlags(riskFlags: unknown): RiskFlag[] {
  if (!Array.isArray(riskFlags)) {
    return [];
  }

  const seen = new Set<RiskFlag>();
  const normalized: RiskFlag[] = [];

  for (const flag of riskFlags) {
    if (!VALID_RISK_FLAGS.has(flag as RiskFlag) || seen.has(flag as RiskFlag)) {
      continue;
    }
    seen.add(flag as RiskFlag);
    normalized.push(flag as RiskFlag);
  }

  return normalized;
}

function prepareSearchQueries(searchQueries: string[], fallbackQuery: string): string[] {
  const prepared = dedupeQueries(searchQueries);
  const queries = prepared.length > 0 ? prepared : dedupeQueries([fallbackQuery]);
  return queries.slice(0, MAX_SEARCH_QUERIES_PER_CLAIM);
}

function dedupeQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const query of queries) {
    const normalized = normalizeSearchQuery(query);
    if (normalized.length === 0) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped;
}

function normalizeSearchQuery(query: string): string {
  const normalized = stripAnsi(query)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > MAX_SEARCH_QUERY_CHARS ? normalized.slice(0, MAX_SEARCH_QUERY_CHARS).trim() : normalized;
}

async function retrieveEvidence(options: {
  claimId: string;
  queries: string[];
  searchProvider: NonNullable<CheckOptions["searchProvider"]>;
  maxResultsPerClaim: number;
  searchCache: Map<string, Promise<SearchResult[]>>;
}): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  for (const query of options.queries) {
    const cacheKey = searchCacheKey(options.searchProvider.name, query, options.maxResultsPerClaim);
    let nextResultsPromise = options.searchCache.get(cacheKey);
    if (!nextResultsPromise) {
      nextResultsPromise = options.searchProvider.search({
        claimId: options.claimId,
        query,
        maxResults: options.maxResultsPerClaim
      });
      options.searchCache.set(cacheKey, nextResultsPromise);
    }
    const nextResults = await nextResultsPromise;
    results.push(...nextResults.map(sanitizeEvidenceSource));
  }

  return dedupeSearchResults(results.filter(hasReadableEvidenceText)).slice(0, options.maxResultsPerClaim);
}

function searchCacheKey(providerName: string, query: string, maxResults: number): string {
  return `${providerName}\0${maxResults}\0${query.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

function hasReadableEvidenceText(result: SearchResult): boolean {
  return [result.snippet, result.text].some((value) => typeof value === "string" && value.trim().length > 0);
}

function sanitizeEvidenceSource<
  T extends {
    id?: string;
    title?: string;
    url?: string;
    path?: string;
    publisher?: string;
    publishedAt?: string;
    retrievedAt?: string;
    snippet?: string;
    text?: string;
    retrieval?: {
      score?: number;
      matchedTerms?: string[];
      explanation?: string;
    };
  }
>(source: T): T {
  let sanitized: T | undefined;

  {
    const id = source.id === undefined ? "source" : truncateText(sanitizeInlineText(source.id), MAX_INLINE_TEXT_CHARS) || "source";
    if (id !== source.id) {
      sanitized ??= { ...source };
      sanitized.id = id;
    }
  }
  {
    const retrievedAt =
      source.retrievedAt === undefined ? "unknown" : truncateText(sanitizeInlineText(source.retrievedAt), MAX_INLINE_TEXT_CHARS) || "unknown";
    if (retrievedAt !== source.retrievedAt) {
      sanitized ??= { ...source };
      sanitized.retrievedAt = retrievedAt;
    }
  }
  sanitized = sanitizeOptionalInlineField(source, sanitized, "title", MAX_INLINE_TEXT_CHARS);
  sanitized = sanitizeOptionalInlineField(source, sanitized, "publisher", MAX_INLINE_TEXT_CHARS);
  sanitized = sanitizeOptionalInlineField(source, sanitized, "publishedAt", MAX_INLINE_TEXT_CHARS);

  if (source.url !== undefined) {
    const url = normalizeSafeSourceUrl(source.url);
    if (url === undefined) {
      sanitized ??= { ...source };
      delete sanitized.url;
    } else if (url !== source.url) {
      sanitized ??= { ...source };
      sanitized.url = url;
    }
  }

  if (source.path !== undefined) {
    const path = truncateText(sanitizeLocationText(source.path), MAX_INLINE_TEXT_CHARS);
    if (path.length === 0) {
      sanitized ??= { ...source };
      delete sanitized.path;
    } else if (path !== source.path) {
      sanitized ??= { ...source };
      sanitized.path = path;
    }
  }

  if (source.snippet !== undefined) {
    const snippet = truncateText(sanitizeInlineEvidenceText(source.snippet), MAX_EVIDENCE_SNIPPET_CHARS);
    if (snippet.length === 0) {
      sanitized ??= { ...source };
      delete sanitized.snippet;
    } else if (snippet !== source.snippet) {
      sanitized ??= { ...source };
      sanitized.snippet = snippet;
    }
  }

  if (source.text !== undefined) {
    const text = truncateText(sanitizeBlockEvidenceText(source.text), MAX_EVIDENCE_TEXT_CHARS);
    if (text.length === 0) {
      sanitized ??= { ...source };
      delete sanitized.text;
    } else if (text !== source.text) {
      sanitized ??= { ...source };
      sanitized.text = text;
    }
  }

  if (source.retrieval !== undefined) {
    if (!isRecord(source.retrieval)) {
      sanitized ??= { ...source };
      delete sanitized.retrieval;
    } else {
      const retrieval = sanitizeRetrieval(source.retrieval as NonNullable<SearchResult["retrieval"]>);
      if (retrieval === undefined) {
        sanitized ??= { ...source };
        delete sanitized.retrieval;
      } else if (retrieval !== source.retrieval) {
        sanitized ??= { ...source };
        sanitized.retrieval = retrieval;
      }
    }
  }

  return sanitized ?? source;
}

function sanitizeOptionalInlineField<
  T extends Record<string, unknown>,
  K extends keyof T & string
>(source: T, sanitized: T | undefined, key: K, maxLength: number): T | undefined {
  const value = source[key];
  if (typeof value !== "string") {
    return sanitized;
  }

  const normalized = truncateText(sanitizeInlineText(value), maxLength);
  if (normalized.length === 0) {
    sanitized ??= { ...source };
    delete sanitized[key];
  } else if (normalized !== value) {
    sanitized ??= { ...source };
    sanitized[key] = normalized as T[K];
  }

  return sanitized;
}

function sanitizeRetrieval(retrieval: NonNullable<SearchResult["retrieval"]>): SearchResult["retrieval"] {
  const sanitized: NonNullable<SearchResult["retrieval"]> = {};

  if (retrieval.score !== undefined && Number.isFinite(retrieval.score)) {
    sanitized.score = retrieval.score;
  }
  if (retrieval.matchedTerms !== undefined) {
    const matchedTerms = retrieval.matchedTerms
      .map((term) => truncateText(sanitizeInlineText(term), MAX_SEARCH_QUERY_CHARS))
      .filter((term) => term.length > 0)
      .slice(0, MAX_SEARCH_QUERIES_PER_CLAIM);
    if (matchedTerms.length > 0) {
      sanitized.matchedTerms = matchedTerms;
    }
  }
  if (retrieval.explanation !== undefined) {
    const explanation = truncateText(sanitizeInlineText(retrieval.explanation), MAX_EXPLANATION_CHARS);
    if (explanation.length > 0) {
      sanitized.explanation = explanation;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function normalizeSafeSourceUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INLINE_TEXT_CHARS || /[\u0000-\u001f\u007f-\u009f\s<>]/.test(trimmed)) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username.length === 0 && url.password.length === 0
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeLocationText(value: string): string {
  return sanitizeInlineEvidenceText(value);
}

function sanitizeInlineText(value: string): string {
  return stripAnsi(value)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeInlineEvidenceText(value: string): string {
  return sanitizeInlineText(value);
}

function sanitizeBlockEvidenceText(value: string): string {
  return stripAnsi(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function normalizeConfidence(confidence: unknown): number {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return 0;
  }

  return Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
