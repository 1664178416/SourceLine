import { describe, expect, it } from "vitest";
import { runCheck } from "./pipeline.js";
import type { LlmProvider, SearchProvider } from "./types.js";

describe("runCheck", () => {
  it("creates a claim-level report with mocked providers", async () => {
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims(input) {
        return {
          claims: [
            {
              id: "claim-1",
              text: input.segments[0]?.text ?? "SourceLine creates reports.",
              sourceSpan: { startLine: 1, endLine: 1 },
              claimType: "technical",
              importance: "medium",
              searchQueries: ["SourceLine evidence reports"]
            }
          ]
        };
      },
      async verifyClaim(input) {
        return {
          claim: input.claim,
          status: "supported",
          confidence: 0.82,
          evidence: input.evidence.map((source) => ({
            source,
            relation: "supports",
            confidence: 0.82,
            explanation: "The mocked source mentions the claim."
          })),
          explanation: "The available mocked source supports the claim.",
          riskFlags: []
        };
      }
    };

    const searchProvider: SearchProvider = {
      name: "test-search",
      async search(query) {
        return [
          {
            id: "source-1",
            title: "Mock source",
            url: "https://example.com/source",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 1,
            query: query.query
          }
        ];
      }
    };

    const report = await runCheck({
      input: {
        kind: "text",
        name: "sample",
        text: "SourceLine creates claim-by-claim evidence reports."
      },
      llmProvider,
      searchProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(report.summary).toEqual({
      totalClaims: 1,
      supported: 1,
      partiallySupported: 0,
      unsupported: 0,
      contradicted: 0,
      notEnoughEvidence: 0
    });
    expect(report.checks[0]?.evidence[0]?.source.url).toBe("https://example.com/source");
  });

  it("reuses identical search queries within one check run", async () => {
    let searchCalls = 0;
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            {
              id: "claim-1",
              text: "SourceLine creates evidence reports.",
              claimType: "technical",
              importance: "medium",
              searchQueries: ["SourceLine evidence reports"]
            },
            {
              id: "claim-2",
              text: "SourceLine exports verification summaries.",
              claimType: "technical",
              importance: "medium",
              searchQueries: [" SourceLine   evidence reports "]
            }
          ]
        };
      },
      async verifyClaim(input) {
        return {
          claim: input.claim,
          status: "supported",
          confidence: 0.81,
          evidence: input.evidence.map((source) => ({
            source,
            relation: "supports",
            confidence: 0.81,
            explanation: "The mocked source mentions the claim."
          })),
          explanation: "The source supports the claim.",
          riskFlags: []
        };
      }
    };

    const searchProvider: SearchProvider = {
      name: "test-search",
      async search(query) {
        searchCalls += 1;
        return [
          {
            id: "source-1",
            title: "Shared source",
            url: "https://example.com/shared",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 1,
            query: query.query
          }
        ];
      }
    };

    const report = await runCheck({
      input: {
        kind: "text",
        name: "sample",
        text: "SourceLine creates evidence reports. SourceLine exports verification summaries."
      },
      llmProvider,
      searchProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(searchCalls).toBe(1);
    expect(report.checks).toHaveLength(2);
    expect(report.checks[1]?.evidence[0]?.source.url).toBe("https://example.com/shared");
  });
  it("normalizes, deduplicates, and falls back search queries before retrieval", async () => {
    const searchQueries: string[] = [];
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            {
              id: "claim-1",
              text: "SourceLine creates evidence reports.",
              claimType: "technical",
              importance: "medium",
              searchQueries: ["", " SourceLine   \u001b[31mevidence\u001b[0m reports ", "sourceline evidence reports", "   "]
            },
            {
              id: "claim-2",
              text: "\u001b[32mSourceLine falls back to claim text.\u001b[0m",
              claimType: "technical",
              importance: "medium",
              searchQueries: ["", "   "]
            }
          ]
        };
      },
      async verifyClaim(input) {
        return {
          claim: input.claim,
          status: "supported",
          confidence: 0.81,
          evidence: input.evidence.map((source) => ({
            source,
            relation: "supports",
            confidence: 0.81,
            explanation: "The mocked source mentions the claim."
          })),
          explanation: "The source supports the claim.",
          riskFlags: []
        };
      }
    };

    const searchProvider: SearchProvider = {
      name: "test-search",
      async search(query) {
        searchQueries.push(query.query);
        return [
          {
            id: `source-${searchQueries.length}`,
            title: "Mock source",
            url: `https://example.com/${searchQueries.length}`,
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 1,
            query: query.query
          }
        ];
      }
    };

    await runCheck({
      input: {
        kind: "text",
        name: "sample",
        text: "SourceLine creates evidence reports. SourceLine falls back to claim text."
      },
      llmProvider,
      searchProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(searchQueries).toEqual(["SourceLine evidence reports", "SourceLine falls back to claim text."]);
  });
  it("deduplicates equivalent URL and path evidence before verification", async () => {
    const evidenceCounts: number[] = [];
    const evidenceLocations: Array<Array<string | undefined>> = [];
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            {
              id: "claim-1",
              text: "SourceLine deduplicates evidence sources.",
              claimType: "technical",
              importance: "medium",
              searchQueries: ["dedupe evidence"]
            }
          ]
        };
      },
      async verifyClaim(input) {
        evidenceCounts.push(input.evidence.length);
        evidenceLocations.push(input.evidence.map((source) => source.url ?? source.path));
        return {
          claim: input.claim,
          status: "supported",
          confidence: 0.81,
          evidence: input.evidence.map((source) => ({
            source,
            relation: "supports",
            confidence: 0.81,
            explanation: "The mocked source mentions the claim."
          })),
          explanation: "The source supports the claim.",
          riskFlags: []
        };
      }
    };

    const searchProvider: SearchProvider = {
      name: "test-search",
      async search(query) {
        return [
          {
            id: "source-url-1",
            title: "URL source",
            url: "https://Example.com:443/source/#section",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 1,
            query: query.query
          },
          {
            id: "source-url-2",
            title: "URL source duplicate",
            url: "https://example.com/source",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 2,
            query: query.query
          },
          {
            id: "source-query-1",
            title: "Query source",
            url: "https://example.com/search?q=%2F",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 3,
            query: query.query
          },
          {
            id: "source-query-2",
            title: "Distinct query source",
            url: "https://example.com/search?q=%2F%2F",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 4,
            query: query.query
          },
          {
            id: "source-path-1",
            title: "Path source",
            path: ".\\Docs\\Evidence.md",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 5,
            query: query.query
          },
          {
            id: "source-path-2",
            title: "Path source duplicate",
            path: "docs/evidence.md/",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 6,
            query: query.query
          }
        ];
      }
    };

    await runCheck({
      input: {
        kind: "text",
        name: "sample",
        text: "SourceLine deduplicates evidence sources."
      },
      llmProvider,
      searchProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(evidenceCounts).toEqual([4]);
    expect(evidenceLocations).toEqual([["https://Example.com:443/source/#section", "https://example.com/search?q=%2F", "https://example.com/search?q=%2F%2F", ".\\Docs\\Evidence.md"]]);
  });

  it("filters search results without readable evidence before verification", async () => {
    const evidenceLocations: Array<Array<string | undefined>> = [];
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            {
              id: "claim-1",
              text: "SourceLine verifies claims against readable evidence.",
              claimType: "technical",
              importance: "medium",
              searchQueries: ["readable evidence"]
            }
          ]
        };
      },
      async verifyClaim(input) {
        evidenceLocations.push(input.evidence.map((source) => source.url ?? source.path));
        return {
          claim: input.claim,
          status: "supported",
          confidence: 0.81,
          evidence: input.evidence.map((source) => ({
            source,
            relation: "supports",
            confidence: 0.81,
            explanation: "The mocked source mentions the claim."
          })),
          explanation: "The source supports the claim.",
          riskFlags: []
        };
      }
    };

    const searchProvider: SearchProvider = {
      name: "test-search",
      async search(query) {
        return [
          {
            id: "source-empty-first",
            title: "Empty first result",
            url: "https://example.com/readable",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            provider: "test-search",
            rank: 1,
            query: query.query
          },
          {
            id: "source-blank",
            title: "Blank source",
            url: "https://example.com/blank",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: " \n\t ",
            text: "   ",
            provider: "test-search",
            rank: 2,
            query: query.query
          },
          {
            id: "source-readable",
            title: "Readable source",
            url: "https://example.com/readable",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: "SourceLine checks claims against readable snippets.",
            provider: "test-search",
            rank: 3,
            query: query.query
          },
          {
            id: "source-text",
            title: "Text-only source",
            url: "https://example.com/text",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            text: "Readable text bodies are also evidence.",
            provider: "test-search",
            rank: 4,
            query: query.query
          }
        ];
      }
    };

    await runCheck({
      input: {
        kind: "text",
        name: "sample",
        text: "SourceLine verifies claims against readable evidence."
      },
      llmProvider,
      searchProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(evidenceLocations).toEqual([["https://example.com/readable", "https://example.com/text"]]);
  });
  it("clamps non-finite and out-of-range confidence values", async () => {
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            {
              id: "claim-1",
              text: "SourceLine normalizes confidence values.",
              claimType: "technical",
              importance: "medium",
              searchQueries: ["confidence values"]
            }
          ]
        };
      },
      async verifyClaim(input) {
        return {
          claim: input.claim,
          status: "supported",
          confidence: 1.234,
          evidence: [
            {
              source: input.evidence[0]!,
              relation: "supports",
              confidence: -0.2,
              explanation: "Negative confidence should be clamped."
            },
            {
              source: input.evidence[1]!,
              relation: "supports",
              confidence: Number.POSITIVE_INFINITY,
              explanation: "Non-finite confidence should become zero."
            }
          ],
          explanation: "Confidence values are normalized.",
          riskFlags: ["weak_source", "requires_expert_review", "weak_source"]
        };
      }
    };

    const searchProvider: SearchProvider = {
      name: "test-search",
      async search(query) {
        return [
          {
            id: "source-1",
            title: "Mock source 1",
            url: "https://example.com/one",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 1,
            query: query.query
          },
          {
            id: "source-2",
            title: "Mock source 2",
            url: "https://example.com/two",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 2,
            query: query.query
          }
        ];
      }
    };

    const report = await runCheck({
      input: {
        kind: "text",
        name: "sample",
        text: "SourceLine normalizes confidence values."
      },
      llmProvider,
      searchProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(report.checks[0]?.confidence).toBe(1);
    expect(report.checks[0]?.evidence.map((item) => item.confidence)).toEqual([0, 0]);
    expect(report.checks[0]?.riskFlags).toEqual(["weak_source", "requires_expert_review"]);
  });

  it("normalizes invalid runtime enum values from providers", async () => {
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            {
              id: "claim-1",
              text: "SourceLine guards report enum values.",
              claimType: "technical",
              importance: "medium",
              searchQueries: ["runtime enum values"]
            }
          ]
        };
      },
      async verifyClaim(input) {
        return {
          claim: input.claim,
          status: "unknown_status" as never,
          confidence: 0.42,
          evidence: [
            {
              source: input.evidence[0]!,
              relation: "unknown_relation" as never,
              confidence: 0.42,
              explanation: "Invalid relation should fall back."
            }
          ],
          explanation: "Invalid status should fall back.",
          riskFlags: ["weak_source", "unknown_flag" as never, "weak_source"]
        };
      }
    };

    const searchProvider: SearchProvider = {
      name: "test-search",
      async search(query) {
        return [
          {
            id: "source-1",
            title: "Mock source",
            url: "https://example.com/runtime-enums",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 1,
            query: query.query
          }
        ];
      }
    };

    const report = await runCheck({
      input: {
        kind: "text",
        name: "sample",
        text: "SourceLine guards report enum values."
      },
      llmProvider,
      searchProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(report.summary).toEqual({
      totalClaims: 1,
      supported: 0,
      partiallySupported: 0,
      unsupported: 0,
      contradicted: 0,
      notEnoughEvidence: 1
    });
    expect(report.checks[0]?.status).toBe("not_enough_evidence");
    expect(report.checks[0]?.evidence[0]?.relation).toBe("related");
    expect(report.checks[0]?.riskFlags).toEqual(["weak_source"]);
  });

  it("rejects invalid run options before executing providers", async () => {
    let extractCalls = 0;
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        extractCalls += 1;
        return { claims: [] };
      },
      async verifyClaim() {
        throw new Error("verifyClaim should not be called");
      }
    };

    const baseOptions = {
      input: {
        kind: "text" as const,
        name: "sample",
        text: "SourceLine validates direct run options."
      },
      llmProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    };

    await expect(runCheck({ ...baseOptions, maxClaims: 0 })).rejects.toThrow("maxClaims must be a positive integer.");
    await expect(runCheck({ ...baseOptions, maxResultsPerClaim: 1.5 })).rejects.toThrow(
      "maxResultsPerClaim must be a positive integer."
    );
    await expect(runCheck({ ...baseOptions, minConfidence: Number.NaN })).rejects.toThrow(
      "minConfidence must be a number between 0 and 1."
    );
    await expect(runCheck({ ...baseOptions, minConfidence: 1.2 })).rejects.toThrow(
      "minConfidence must be a number between 0 and 1."
    );
    expect(extractCalls).toBe(0);
  });});
