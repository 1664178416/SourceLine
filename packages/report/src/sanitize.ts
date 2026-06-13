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

export function sanitizeReport(report: SourceLineReport): SourceLineReport {
  const checks = report.checks.map(sanitizeClaimCheck);
  const input = sanitizeReportInput(report.input);

  return {
    ...report,
    input,
    generatedAt: sanitizeInlineText(report.generatedAt),
    summary: summarizeChecks(checks),
    checks
  };
}

function sanitizeReportInput(input: SourceLineReport["input"]): SourceLineReport["input"] {
  const sanitized: SourceLineReport["input"] = {
    ...input,
    hash: sanitizeInlineText(input.hash)
  };
  if (input.name !== undefined) {
    const name = sanitizeInlineText(input.name);
    if (name.length > 0) {
      sanitized.name = name;
    } else {
      delete sanitized.name;
    }
  }

  return sanitized;
}

function sanitizeClaimCheck(check: ClaimCheck): ClaimCheck {
  return {
    ...check,
    claim: sanitizeClaim(check.claim),
    status: sanitizeStatus(check.status),
    confidence: sanitizeConfidence(check.confidence),
    evidence: check.evidence.map(sanitizeEvidence),
    explanation: sanitizeInlineText(check.explanation),
    riskFlags: sanitizeRiskFlags(check.riskFlags)
  };
}

function sanitizeClaim(claim: Claim): Claim {
  const sanitized: Claim = { ...claim };
  const text = sanitizeInlineText(claim.text);
  sanitized.text = text;
  const searchQueries = claim.searchQueries.map(sanitizeInlineText).filter((query) => query.length > 0);
  sanitized.searchQueries = searchQueries;
  const sourceSpan = sanitizeSourceSpan(claim.sourceSpan);
  if (sourceSpan) {
    sanitized.sourceSpan = sourceSpan;
  } else {
    delete sanitized.sourceSpan;
  }

  return sanitized;
}

function sanitizeSourceSpan(sourceSpan: Claim["sourceSpan"]): Claim["sourceSpan"] {
  if (!sourceSpan) {
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

function sanitizeEvidence(evidence: EvidenceItem): EvidenceItem {
  const quotedSupport = evidence.quotedSupport !== undefined ? sanitizeInlineText(evidence.quotedSupport) : undefined;
  return {
    ...evidence,
    relation: sanitizeEvidenceRelation(evidence.relation),
    confidence: sanitizeConfidence(evidence.confidence),
    explanation: sanitizeInlineText(evidence.explanation),
    quotedSupport: quotedSupport && quotedSupport.length > 0 ? quotedSupport : undefined,
    source: sanitizeSource(evidence.source)
  };
}

function sanitizeSource(source: SourceDocument): SourceDocument {
  const sanitized: SourceDocument = {
    ...source,
    id: sanitizeInlineText(source.id) || "source",
    retrievedAt: sanitizeInlineText(source.retrievedAt)
  };
  if (source.publishedAt !== undefined) {
    const publishedAt = sanitizeInlineText(source.publishedAt);
    if (publishedAt.length > 0) {
      sanitized.publishedAt = publishedAt;
    } else {
      delete sanitized.publishedAt;
    }
  }
  if (source.title !== undefined) {
    const title = sanitizeInlineText(source.title);
    if (title.length > 0) {
      sanitized.title = title;
    } else {
      delete sanitized.title;
    }
  }
  if (source.publisher !== undefined) {
    const publisher = sanitizeInlineText(source.publisher);
    if (publisher.length > 0) {
      sanitized.publisher = publisher;
    } else {
      delete sanitized.publisher;
    }
  }
  if (source.snippet !== undefined) {
    const snippet = sanitizeInlineText(source.snippet);
    if (snippet.length > 0) {
      sanitized.snippet = snippet;
    } else {
      delete sanitized.snippet;
    }
  }
  if (source.text !== undefined) {
    const text = sanitizeBlockText(source.text);
    if (text.length > 0) {
      sanitized.text = text;
    } else {
      delete sanitized.text;
    }
  }
  const retrieval = sanitizeRetrieval(source.retrieval);
  if (retrieval) {
    sanitized.retrieval = retrieval;
  } else {
    delete sanitized.retrieval;
  }

  return sanitized;
}

function sanitizeRetrieval(retrieval: SourceDocument["retrieval"]): SourceDocument["retrieval"] {
  if (!retrieval) {
    return undefined;
  }

  const sanitized: NonNullable<SourceDocument["retrieval"]> = {};
  if (retrieval.score !== undefined && Number.isFinite(retrieval.score)) {
    sanitized.score = retrieval.score;
  }
  if (retrieval.matchedTerms !== undefined) {
    const matchedTerms = retrieval.matchedTerms.map(sanitizeInlineText).filter((term) => term.length > 0);
    if (matchedTerms.length > 0) {
      sanitized.matchedTerms = matchedTerms;
    }
  }
  if (retrieval.explanation !== undefined) {
    const explanation = sanitizeInlineText(retrieval.explanation);
    if (explanation.length > 0) {
      sanitized.explanation = explanation;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return undefined;
  }

  return Math.trunc(value);
}

function sanitizeConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function sanitizeStatus(status: VerificationStatus): VerificationStatus {
  return VALID_STATUSES.has(status) ? status : "not_enough_evidence";
}

function sanitizeEvidenceRelation(relation: EvidenceRelation): EvidenceRelation {
  return VALID_EVIDENCE_RELATIONS.has(relation) ? relation : "related";
}

function sanitizeRiskFlags(riskFlags: RiskFlag[]): RiskFlag[] {
  const seen = new Set<RiskFlag>();
  const sanitized: RiskFlag[] = [];

  for (const flag of riskFlags) {
    if (!VALID_RISK_FLAGS.has(flag) || seen.has(flag)) {
      continue;
    }
    seen.add(flag);
    sanitized.push(flag);
  }

  return sanitized;
}

function sanitizeInlineText(value: string): string {
  return stripAnsi(value)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeBlockText(value: string): string {
  return stripAnsi(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .trim();
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
