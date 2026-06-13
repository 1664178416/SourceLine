import type {
  Claim,
  EvidenceItem,
  ExtractClaimsInput,
  LlmProvider,
  RiskFlag,
  SearchProvider,
  SearchResult,
  VerificationStatus
} from "@sourceline/core";

export type MockProviderOptions = {
  now?: () => Date;
};

export function createMockLlmProvider(): LlmProvider {
  return {
    name: "mock",
    async extractClaims(input: ExtractClaimsInput) {
      const claims = extractHeuristicClaims(input);
      return { claims };
    },
    async verifyClaim(input) {
      const status = classifyMockStatus(input.claim, input.evidence);
      const relation = relationForStatus(status);
      const riskFlags = riskFlagsForStatus(status, input.claim);
      const confidence = input.evidence.length === 0 ? 0.34 : status === "supported" ? 0.78 : 0.62;
      const evidence: EvidenceItem[] = input.evidence.slice(0, 3).map((source) => ({
        source,
        relation,
        confidence,
        quotedSupport: source.snippet,
        explanation:
          status === "supported"
            ? "The mock evidence is treated as relevant support for this early offline workflow."
            : "The mock verifier keeps this claim conservative until a live provider is connected."
      }));

      return {
        claim: input.claim,
        status,
        confidence,
        evidence,
        explanation: explanationForStatus(status),
        riskFlags
      };
    }
  };
}

export function createMockSearchProvider(options: MockProviderOptions = {}): SearchProvider {
  const now = options.now ?? (() => new Date());

  return {
    name: "mock",
    async search(query) {
      return Array.from({ length: Math.min(query.maxResults, 2) }, (_, index): SearchResult => {
        const rank = index + 1;
        const slug = slugify(`${rank}-${query.query}`);

        return {
          id: `mock-source-${slug}`,
          title: `Mock source ${rank}: ${query.query.slice(0, 72)}`,
          url: `https://example.com/sourceline/mock/${slug}`,
          retrievedAt: now().toISOString(),
          snippet: `Mock evidence for "${query.query}". Connect Tavily or Brave to replace this with live sources.`,
          provider: "mock",
          rank,
          query: query.query
        };
      });
    }
  };
}

function extractHeuristicClaims(input: ExtractClaimsInput): Claim[] {
  const claims: Claim[] = [];

  for (const segment of input.segments) {
    const sentences = splitSentences(segment.text);
    for (const sentence of sentences) {
      if (claims.length >= input.maxClaims) {
        return claims;
      }

      const text = cleanSentence(sentence);
      if (!looksLikeClaim(text)) {
        continue;
      }

      claims.push({
        id: `claim-${claims.length + 1}`,
        text,
        sourceSpan: {
          startLine: segment.startLine,
          endLine: segment.endLine,
          quote: text
        },
        claimType: inferClaimType(text),
        importance: inferImportance(text),
        searchQueries: [buildSearchQuery(text)]
      });
    }
  }

  return claims;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?。！？])\s+|(?<=[。！？])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function cleanSentence(sentence: string): string {
  return sentence
    .replace(/^#+\s*/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeClaim(text: string): boolean {
  if (text.length < 24 || text.endsWith("?") || text.endsWith("？")) {
    return false;
  }

  return (
    /\d/.test(text) ||
    /\b(is|are|was|were|became|has|have|supports|requires|contain|contains|turn|turns|uses|can|will)\b/i.test(text) ||
    /是|成为|支持|包含|需要|可以|将|已经|具有/.test(text)
  );
}

function inferClaimType(text: string): Claim["claimType"] {
  if (/%|\bpercent\b|\d/.test(text)) {
    return "statistical";
  }
  if (/\b(policy|law|regulation|legal)\b|政策|法律|法规/.test(text)) {
    return "legal_or_policy";
  }
  if (/\b(study|research|clinical|scientific|paper)\b|研究|论文|科学/.test(text)) {
    return "scientific";
  }
  if (/\b(TypeScript|Node|API|GitHub|CLI|JSON|Markdown|LLM)\b/i.test(text)) {
    return "technical";
  }
  return "general_factual";
}

function inferImportance(text: string): Claim["importance"] {
  if (/%|\d|must|required|必须|一定/.test(text)) {
    return "high";
  }
  if (/may|might|could|可能|也许/.test(text)) {
    return "low";
  }
  return "medium";
}

function buildSearchQuery(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function classifyMockStatus(claim: Claim, evidence: SearchResult[]): VerificationStatus {
  const lower = claim.text.toLowerCase();
  if (evidence.length === 0) {
    return "not_enough_evidence";
  }
  if (/\b(no evidence|unsupported|false)\b|没有证据|不可信/.test(lower)) {
    return "unsupported";
  }
  if (/\b(always|never|everyone|all|most)\b|所有|总是|从不|大多数/.test(lower)) {
    return "partially_supported";
  }
  return "supported";
}

function relationForStatus(status: VerificationStatus): EvidenceItem["relation"] {
  if (status === "supported") {
    return "supports";
  }
  if (status === "partially_supported") {
    return "partially_supports";
  }
  if (status === "contradicted") {
    return "contradicts";
  }
  return "related";
}

function riskFlagsForStatus(status: VerificationStatus, claim: Claim): RiskFlag[] {
  const flags: RiskFlag[] = [];

  if (status === "not_enough_evidence") {
    flags.push("no_source_found");
  }
  if (status === "partially_supported") {
    flags.push("overgeneralized_claim");
  }
  if (claim.claimType === "legal_or_policy" || claim.claimType === "scientific") {
    flags.push("requires_expert_review");
  }

  return flags;
}

function explanationForStatus(status: VerificationStatus): string {
  switch (status) {
    case "supported":
      return "The mock verifier found relevant evidence. Replace mock providers with live providers before treating this as a real verification result.";
    case "partially_supported":
      return "The claim appears broader than the available mock evidence. A live verifier should check the exact wording.";
    case "unsupported":
      return "The mock verifier did not find support for this wording.";
    case "contradicted":
      return "The mock verifier found conflicting evidence.";
    case "not_enough_evidence":
      return "No evidence was available for this claim.";
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
