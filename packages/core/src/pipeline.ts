import { loadInput } from "./input.js";
import { dedupeClaims, dedupeSearchResults } from "./normalize.js";
import { segmentDocument } from "./segment.js";
import { summarizeChecks } from "./summary.js";
import type { CheckOptions, ClaimCheck, EvidenceRelation, RiskFlag, SearchResult, SourceLineReport, VerificationStatus } from "./types.js";

const DEFAULT_MAX_CLAIMS = 30;
const DEFAULT_MAX_RESULTS_PER_CLAIM = 5;
const DEFAULT_MIN_CONFIDENCE = 0.65;
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
  const maxClaims = resolvePositiveIntegerOption(options.maxClaims, DEFAULT_MAX_CLAIMS, "maxClaims");
  const maxResultsPerClaim = resolvePositiveIntegerOption(
    options.maxResultsPerClaim,
    DEFAULT_MAX_RESULTS_PER_CLAIM,
    "maxResultsPerClaim"
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
  const claims = dedupeClaims(extracted.claims).slice(0, maxClaims);
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

    checks.push(normalizeCheck(check));
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

function resolvePositiveIntegerOption(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
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
function normalizeCheck(check: ClaimCheck): ClaimCheck {
  return {
    ...check,
    status: normalizeStatus(check.status),
    confidence: normalizeConfidence(check.confidence),
    riskFlags: normalizeRiskFlags(check.riskFlags),
    evidence: check.evidence.map((evidence) => ({
      ...evidence,
      relation: normalizeEvidenceRelation(evidence.relation),
      confidence: normalizeConfidence(evidence.confidence)
    }))
  };
}

function normalizeStatus(status: VerificationStatus): VerificationStatus {
  return VALID_STATUSES.has(status) ? status : "not_enough_evidence";
}

function normalizeEvidenceRelation(relation: EvidenceRelation): EvidenceRelation {
  return VALID_EVIDENCE_RELATIONS.has(relation) ? relation : "related";
}

function normalizeRiskFlags(riskFlags: RiskFlag[]): RiskFlag[] {
  const seen = new Set<RiskFlag>();
  const normalized: RiskFlag[] = [];

  for (const flag of riskFlags) {
    if (!VALID_RISK_FLAGS.has(flag) || seen.has(flag)) {
      continue;
    }
    seen.add(flag);
    normalized.push(flag);
  }

  return normalized;
}

function prepareSearchQueries(searchQueries: string[], fallbackQuery: string): string[] {
  const prepared = dedupeQueries(searchQueries);
  return prepared.length > 0 ? prepared : dedupeQueries([fallbackQuery]);
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
  return stripAnsi(query)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
    results.push(...nextResults);
  }

  return dedupeSearchResults(results.filter(hasReadableEvidenceText)).slice(0, options.maxResultsPerClaim);
}

function searchCacheKey(providerName: string, query: string, maxResults: number): string {
  return `${providerName}\0${maxResults}\0${query.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

function hasReadableEvidenceText(result: SearchResult): boolean {
  return [result.snippet, result.text].some((value) => typeof value === "string" && value.trim().length > 0);
}

function normalizeConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) {
    return 0;
  }

  return Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
