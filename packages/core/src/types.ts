export type VerificationStatus =
  | "supported"
  | "partially_supported"
  | "unsupported"
  | "contradicted"
  | "not_enough_evidence";

export type EvidenceRelation =
  | "supports"
  | "partially_supports"
  | "contradicts"
  | "related"
  | "irrelevant";

export type RiskFlag =
  | "no_source_found"
  | "weak_source"
  | "stale_source"
  | "source_paywalled"
  | "ambiguous_claim"
  | "overgeneralized_claim"
  | "requires_expert_review";

export type InputDescriptor =
  | {
      kind: "file";
      path: string;
    }
  | {
      kind: "url";
      url: string;
      name?: string;
      fetchImpl?: typeof fetch;
    }
  | {
      kind: "stdin" | "text";
      text: string;
      name?: string;
    };

export type ParsedInput = {
  kind: "file" | "stdin" | "url" | "text";
  name?: string;
  text: string;
  hash: string;
};

export type DocumentSegment = {
  id: string;
  text: string;
  startLine: number;
  endLine: number;
};

export type SourceDocument = {
  id: string;
  title?: string;
  url?: string;
  path?: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt: string;
  snippet?: string;
  text?: string;
  retrieval?: {
    score?: number;
    matchedTerms?: string[];
    explanation?: string;
  };
};

export type SearchQuery = {
  claimId: string;
  query: string;
  maxResults: number;
};

export type SearchResult = SourceDocument & {
  provider: string;
  rank: number;
  query: string;
};

export type Claim = {
  id: string;
  text: string;
  sourceSpan?: {
    startLine?: number;
    endLine?: number;
    quote?: string;
  };
  claimType:
    | "statistical"
    | "historical"
    | "scientific"
    | "legal_or_policy"
    | "biographical"
    | "technical"
    | "general_factual";
  importance: "high" | "medium" | "low";
  searchQueries: string[];
};

export type EvidenceItem = {
  source: SourceDocument;
  relation: EvidenceRelation;
  confidence: number;
  quotedSupport?: string;
  explanation: string;
};

export type ClaimCheck = {
  claim: Claim;
  status: VerificationStatus;
  confidence: number;
  evidence: EvidenceItem[];
  explanation: string;
  riskFlags: RiskFlag[];
};

export type SourceLineReport = {
  schemaVersion: "1.0";
  input: {
    kind: "file" | "stdin" | "url" | "text";
    name?: string;
    hash: string;
  };
  generatedAt: string;
  summary: {
    totalClaims: number;
    supported: number;
    partiallySupported: number;
    unsupported: number;
    contradicted: number;
    notEnoughEvidence: number;
  };
  checks: ClaimCheck[];
};

export type ExtractClaimsInput = {
  text: string;
  segments: DocumentSegment[];
  maxClaims: number;
};

export type ExtractClaimsResult = {
  claims: Claim[];
};

export type VerifyClaimInput = {
  claim: Claim;
  evidence: SearchResult[];
  minConfidence: number;
};

export type LlmProvider = {
  name: string;
  extractClaims(input: ExtractClaimsInput): Promise<ExtractClaimsResult>;
  verifyClaim(input: VerifyClaimInput): Promise<ClaimCheck>;
};

export type SearchProvider = {
  name: string;
  search(query: SearchQuery): Promise<SearchResult[]>;
};

export type CheckOptions = {
  input: InputDescriptor;
  llmProvider: LlmProvider;
  searchProvider?: SearchProvider;
  maxClaims?: number;
  maxResultsPerClaim?: number;
  minConfidence?: number;
  now?: () => Date;
};
