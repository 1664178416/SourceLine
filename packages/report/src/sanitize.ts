import {
  summarizeChecks,
  type Claim,
  type ClaimCheck,
  type EvidenceItem,
  type EvidenceRelation,
  type RiskFlag,
  type SourceDocument,
  type SourceLineReport,
  type VerificationStatus
} from "@sourceline/core";
import { isSafeSourceUrl } from "./url-safety.js";

const VALID_STATUSES = new Set<VerificationStatus>([
  "supported",
  "partially_supported",
  "unsupported",
  "contradicted",
  "not_enough_evidence"
]);
const VALID_INPUT_KINDS = new Set<SourceLineReport["input"]["kind"]>(["file", "stdin", "url", "text"]);
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
const MAX_SEARCH_QUERIES_PER_CLAIM = 5;
const MAX_SEARCH_QUERY_CHARS = 500;
const MAX_MATCHED_TERMS = 50;
const MAX_REPORT_CHECKS = 100;
const MAX_EVIDENCE_ITEMS_PER_CHECK = 20;
const MAX_IDENTIFIER_CHARS = 200;
const MAX_INLINE_TEXT_CHARS = 2_000;
const MAX_EXPLANATION_CHARS = 4_000;
const MAX_EVIDENCE_SNIPPET_CHARS = 2_000;
const MAX_EVIDENCE_TEXT_CHARS = 20_000;
const TRUNCATION_MARKER = "... [truncated]";

export function sanitizeReport(report: SourceLineReport): SourceLineReport {
  const rawReport: Record<string, unknown> = isRecord(report) ? report : {};
  const checks = Array.isArray(rawReport.checks)
    ? rawReport.checks.slice(0, MAX_REPORT_CHECKS).map(sanitizeClaimCheck).filter((check): check is ClaimCheck => check !== undefined)
    : [];
  const input = sanitizeReportInput(rawReport.input);

  return {
    schemaVersion: "1.0",
    input,
    generatedAt: sanitizeInlineText(rawReport.generatedAt),
    summary: summarizeChecks(checks),
    checks
  } as SourceLineReport;
}

function sanitizeReportInput(input: unknown): SourceLineReport["input"] {
  const rawInput = isRecord(input) ? input : {};
  const sanitized: SourceLineReport["input"] = {
    kind: sanitizeInputKind(rawInput.kind),
    hash: sanitizeInlineText(rawInput.hash) || "unknown"
  };
  if (rawInput.name !== undefined) {
    const name = sanitizeInlineText(rawInput.name);
    if (name.length > 0) {
      sanitized.name = name;
    }
  }

  return sanitized;
}

function sanitizeInputKind(kind: unknown): SourceLineReport["input"]["kind"] {
  return VALID_INPUT_KINDS.has(kind as SourceLineReport["input"]["kind"]) ? (kind as SourceLineReport["input"]["kind"]) : "text";
}

function sanitizeClaimCheck(check: unknown): ClaimCheck | undefined {
  if (!isRecord(check)) {
    return undefined;
  }

  return {
    claim: sanitizeClaim(check.claim),
    status: sanitizeStatus(check.status),
    confidence: sanitizeConfidence(check.confidence),
    evidence: sanitizeEvidenceItems(check.evidence),
    explanation: sanitizeInlineText(check.explanation, MAX_EXPLANATION_CHARS),
    riskFlags: sanitizeRiskFlags(check.riskFlags)
  };
}

function sanitizeClaim(claim: unknown): Claim {
  const rawClaim = isRecord(claim) ? claim : {};
  const text = sanitizeInlineText(rawClaim.text) || "Untitled claim.";
  const searchQueries = (Array.isArray(rawClaim.searchQueries) ? rawClaim.searchQueries : [])
    .map((query) => truncateText(sanitizeInlineText(query), MAX_SEARCH_QUERY_CHARS))
    .filter((query) => query.length > 0)
    .slice(0, MAX_SEARCH_QUERIES_PER_CLAIM);

  const sanitized: Claim = {
    id: sanitizeIdentifier(rawClaim.id, "claim"),
    text,
    claimType: sanitizeClaimType(rawClaim.claimType),
    importance: sanitizeImportance(rawClaim.importance),
    searchQueries
  };
  const sourceSpan = sanitizeSourceSpan(rawClaim.sourceSpan);
  if (sourceSpan) {
    sanitized.sourceSpan = sourceSpan;
  }

  return sanitized;
}

function sanitizeClaimType(claimType: unknown): Claim["claimType"] {
  return VALID_CLAIM_TYPES.has(claimType as Claim["claimType"]) ? (claimType as Claim["claimType"]) : "general_factual";
}

function sanitizeImportance(importance: unknown): Claim["importance"] {
  return VALID_IMPORTANCE.has(importance as Claim["importance"]) ? (importance as Claim["importance"]) : "medium";
}

function sanitizeSourceSpan(sourceSpan: unknown): Claim["sourceSpan"] {
  if (!isRecord(sourceSpan)) {
    return undefined;
  }

  const sanitized: NonNullable<Claim["sourceSpan"]> = {};
  const startLine = sanitizePositiveInteger(sourceSpan.startLine);
  const endLine = sanitizePositiveInteger(sourceSpan.endLine);
  const hasValidRange = startLine === undefined || endLine === undefined || endLine >= startLine;

  if (hasValidRange && startLine !== undefined) {
    sanitized.startLine = startLine;
  }
  if (hasValidRange && endLine !== undefined) {
    sanitized.endLine = endLine;
  }
  if (sourceSpan.quote !== undefined) {
    const quote = sanitizeInlineText(sourceSpan.quote);
    if (quote.length > 0) {
      sanitized.quote = quote;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeEvidenceItems(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, MAX_EVIDENCE_ITEMS_PER_CHECK)
    .map(sanitizeEvidence)
    .filter((evidence): evidence is EvidenceItem => evidence !== undefined);
}

function sanitizeEvidence(evidence: unknown): EvidenceItem | undefined {
  if (!isRecord(evidence) || !isRecord(evidence.source)) {
    return undefined;
  }

  const quotedSupport =
    evidence.quotedSupport !== undefined ? sanitizeInlineText(evidence.quotedSupport, MAX_EXPLANATION_CHARS) : undefined;
  return {
    relation: sanitizeEvidenceRelation(evidence.relation),
    confidence: sanitizeConfidence(evidence.confidence),
    explanation: sanitizeInlineText(evidence.explanation, MAX_EXPLANATION_CHARS),
    quotedSupport: quotedSupport && quotedSupport.length > 0 ? quotedSupport : undefined,
    source: sanitizeSource(evidence.source)
  };
}

function sanitizeSource(source: unknown): SourceDocument {
  const rawSource = isRecord(source) ? source : {};
  const sanitized: SourceDocument = {
    id: sanitizeIdentifier(rawSource.id, "source"),
    retrievedAt: sanitizeInlineText(rawSource.retrievedAt) || "unknown"
  };
  if (typeof rawSource.url === "string") {
    const url = rawSource.url.trim();
    if (url.length <= MAX_INLINE_TEXT_CHARS && isSafeSourceUrl(url)) {
      sanitized.url = url;
    }
  }
  if (rawSource.path !== undefined) {
    const path = sanitizeInlineText(rawSource.path);
    if (path.length > 0) {
      sanitized.path = path;
    }
  }
  if (rawSource.publishedAt !== undefined) {
    const publishedAt = sanitizeInlineText(rawSource.publishedAt);
    if (publishedAt.length > 0) {
      sanitized.publishedAt = publishedAt;
    }
  }
  if (rawSource.title !== undefined) {
    const title = sanitizeInlineText(rawSource.title);
    if (title.length > 0) {
      sanitized.title = title;
    }
  }
  if (rawSource.publisher !== undefined) {
    const publisher = sanitizeInlineText(rawSource.publisher);
    if (publisher.length > 0) {
      sanitized.publisher = publisher;
    }
  }
  if (rawSource.snippet !== undefined) {
    const snippet = truncateText(sanitizeInlineText(rawSource.snippet), MAX_EVIDENCE_SNIPPET_CHARS);
    if (snippet.length > 0) {
      sanitized.snippet = snippet;
    }
  }
  if (rawSource.text !== undefined) {
    const text = truncateText(sanitizeBlockText(rawSource.text), MAX_EVIDENCE_TEXT_CHARS);
    if (text.length > 0) {
      sanitized.text = text;
    }
  }
  const retrieval = sanitizeRetrieval(rawSource.retrieval);
  if (retrieval) {
    sanitized.retrieval = retrieval;
  }

  return sanitized;
}

function sanitizeRetrieval(retrieval: unknown): SourceDocument["retrieval"] {
  if (!isRecord(retrieval)) {
    return undefined;
  }

  const sanitized: NonNullable<SourceDocument["retrieval"]> = {};
  if (typeof retrieval.score === "number" && Number.isFinite(retrieval.score)) {
    sanitized.score = retrieval.score;
  }
  if (Array.isArray(retrieval.matchedTerms)) {
    const matchedTerms = retrieval.matchedTerms
      .map((term) => sanitizeInlineText(term, MAX_SEARCH_QUERY_CHARS))
      .filter((term) => term.length > 0)
      .slice(0, MAX_MATCHED_TERMS);
    if (matchedTerms.length > 0) {
      sanitized.matchedTerms = matchedTerms;
    }
  }
  if (retrieval.explanation !== undefined) {
    const explanation = sanitizeInlineText(retrieval.explanation, MAX_EXPLANATION_CHARS);
    if (explanation.length > 0) {
      sanitized.explanation = explanation;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return undefined;
  }

  return Math.trunc(value);
}

function sanitizeConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function sanitizeStatus(status: unknown): VerificationStatus {
  return VALID_STATUSES.has(status as VerificationStatus) ? (status as VerificationStatus) : "not_enough_evidence";
}

function sanitizeEvidenceRelation(relation: unknown): EvidenceRelation {
  return VALID_EVIDENCE_RELATIONS.has(relation as EvidenceRelation) ? (relation as EvidenceRelation) : "related";
}

function sanitizeRiskFlags(riskFlags: unknown): RiskFlag[] {
  if (!Array.isArray(riskFlags)) {
    return [];
  }

  const seen = new Set<RiskFlag>();
  const sanitized: RiskFlag[] = [];

  for (const flag of riskFlags) {
    if (!VALID_RISK_FLAGS.has(flag as RiskFlag) || seen.has(flag as RiskFlag)) {
      continue;
    }
    seen.add(flag as RiskFlag);
    sanitized.push(flag as RiskFlag);
  }

  return sanitized;
}

function sanitizeInlineText(value: unknown, maxLength = MAX_INLINE_TEXT_CHARS): string {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = stripAnsi(value)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return truncateText(normalized, maxLength);
}

function sanitizeIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = normalizeIdentifierText(value);
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

function sanitizeBlockText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

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

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
