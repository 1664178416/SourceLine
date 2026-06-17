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

  it("caps search queries per claim and query length before retrieval and verification", async () => {
    const longQuery = "x".repeat(700);
    const searchQueries: string[] = [];
    const verifierQueries: string[][] = [];
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            {
              id: "claim-1",
              text: "SourceLine limits generated search queries.",
              claimType: "technical",
              importance: "medium",
              searchQueries: [longQuery, "query 1", "query 2", "query 3", "query 4", "query 5", "query 6"]
            }
          ]
        };
      },
      async verifyClaim(input) {
        verifierQueries.push(input.claim.searchQueries);
        return {
          claim: input.claim,
          status: "supported",
          confidence: 0.8,
          evidence: input.evidence.map((source) => ({
            source,
            relation: "supports",
            confidence: 0.8,
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

    const report = await runCheck({
      input: {
        kind: "text",
        name: "sample",
        text: "SourceLine limits generated search queries."
      },
      llmProvider,
      searchProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(searchQueries).toEqual(["x".repeat(500), "query 1", "query 2", "query 3", "query 4"]);
    expect(verifierQueries).toEqual([searchQueries]);
    expect(report.checks[0]?.claim.searchQueries).toEqual(searchQueries);
    expect(report.checks[0]?.evidence).toHaveLength(5);
  });

  it("does not let verifiers replace the canonical claim in report output", async () => {
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            {
              id: "original-claim",
              text: "SourceLine keeps canonical extracted claims.",
              claimType: "technical",
              importance: "medium",
              searchQueries: ["canonical extracted claims"]
            }
          ]
        };
      },
      async verifyClaim() {
        return {
          claim: {
            id: "mutated-claim",
            text: "Verifier attempted to replace the claim.",
            claimType: "general_factual",
            importance: "low",
            searchQueries: ["mutated claim"]
          },
          status: "supported",
          confidence: 0.8,
          evidence: [],
          explanation: "Mock explanation.",
          riskFlags: []
        };
      }
    };

    const report = await runCheck({
      input: {
        kind: "text",
        name: "sample",
        text: "SourceLine keeps canonical extracted claims."
      },
      llmProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(report.checks[0]?.claim).toEqual({
      id: "original-claim",
      text: "SourceLine keeps canonical extracted claims.",
      claimType: "technical",
      importance: "medium",
      searchQueries: ["canonical extracted claims"]
    });
  });

  it("treats non-array extracted claims as no claims", async () => {
    let verifyCalls = 0;
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return { claims: "not-an-array" as never };
      },
      async verifyClaim(input) {
        verifyCalls += 1;
        return {
          claim: input.claim,
          status: "supported",
          confidence: 0.8,
          evidence: [],
          explanation: "Should not be called.",
          riskFlags: []
        };
      }
    };

    const report = await runCheck({
      input: {
        kind: "text",
        name: "sample",
        text: "SourceLine tolerates malformed extraction roots."
      },
      llmProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(verifyCalls).toBe(0);
    expect(report.checks).toEqual([]);
    expect(report.summary.totalClaims).toBe(0);
  });

  it("filters malformed extracted claim entries before deduplication", async () => {
    const seenClaims: unknown[] = [];
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            undefined,
            { id: "blank", text: " \n\t ", claimType: "technical", importance: "medium", searchQueries: ["blank"] },
            {
              id: " Claim/One?<script>\u001b[31m \u001b[0m ",
              text: "SourceLine tolerates malformed extraction output.",
              claimType: "not-a-claim-type",
              importance: "urgent",
              sourceSpan: "not-a-source-span",
              searchQueries: [" Evidence ", 123, "evidence"]
            },
            {
              id: "duplicate",
              text: "sourceline tolerates malformed extraction output",
              claimType: "technical",
              importance: "medium",
              searchQueries: ["duplicate"]
            }
          ] as never
        };
      },
      async verifyClaim(input) {
        seenClaims.push(input.claim);
        return {
          claim: input.claim,
          status: "supported",
          confidence: 0.8,
          evidence: [],
          explanation: "Malformed extracted claims were normalized.",
          riskFlags: []
        };
      }
    };

    const report = await runCheck({
      input: {
        kind: "text",
        name: "sample",
        text: "SourceLine tolerates malformed extraction output."
      },
      llmProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(seenClaims).toHaveLength(1);
    expect(report.checks[0]?.claim).toEqual({
      id: "claim-one-script",
      text: "SourceLine tolerates malformed extraction output.",
      claimType: "general_factual",
      importance: "medium",
      searchQueries: ["Evidence"]
    });
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

  it("sanitizes unsafe evidence source locations before verification and report output", async () => {
    const evidenceLocations: Array<Array<string | undefined>> = [];
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            {
              id: "claim-1",
              text: "SourceLine protects evidence URL credentials.",
              claimType: "technical",
              importance: "medium",
              searchQueries: ["evidence url credentials"]
            }
          ]
        };
      },
      async verifyClaim(input) {
        evidenceLocations.push(input.evidence.map((source) => source.url ?? source.path));
        return {
          claim: input.claim,
          status: "supported",
          confidence: 0.8,
          evidence: [
            ...input.evidence.map((source) => ({
              source,
              relation: "supports" as const,
              confidence: 0.8,
              explanation: "The sanitized source is still usable."
            })),
            {
              source: {
                id: "llm-source",
                url: "javascript:alert(1)",
                path: " llm\n\u001b[31mpath.md\u001b[0m ",
                retrievedAt: "2026-06-07T00:00:00.000Z",
                snippet: "LLM-supplied evidence should be sanitized too."
              },
              relation: "related",
              confidence: 0.2,
              explanation: "Credentialed LLM-supplied URLs should not reach the report."
            },
            {
              source: {
                title: " Verifier\n\u001b[31msource\u001b[0m ",
                url: "https://user:secret@example.com/verifier",
                snippet: "Verifier-supplied evidence can omit runtime-required metadata."
              } as never,
              relation: "related",
              confidence: 0.2,
              explanation: "Missing source metadata should be normalized."
            }
          ],
          explanation: "Mock explanation.",
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
            title: "Credentialed source",
            url: "https://user:secret@example.com/private",
            path: "notes/source-1.md",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 1,
            query: query.query
          },
          {
            id: "source-2",
            title: " Unsafe\n\u001b[31msource\u001b[0m ",
            url: "javascript:alert(1)",
            path: " notes/\u001b[31msource\u001b[0m\n2.md ",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 2,
            query: query.query
          },
          {
            id: "source-3",
            title: "Trimmed source",
            url: " https://example.com/safe ",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            provider: "test-search",
            rank: 3,
            query: query.query
          }
        ];
      }
    };

    const report = await runCheck({
      input: {
        kind: "text",
        name: "sample",
        text: "SourceLine protects evidence URL credentials."
      },
      llmProvider,
      searchProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(evidenceLocations).toEqual([["notes/source-1.md", "notes/source 2.md", "https://example.com/safe"]]);
    expect(report.checks[0]?.evidence[0]?.source.url).toBeUndefined();
    expect(report.checks[0]?.evidence[0]?.source.path).toBe("notes/source-1.md");
    expect(report.checks[0]?.evidence[1]?.source.url).toBeUndefined();
    expect(report.checks[0]?.evidence[1]?.source.path).toBe("notes/source 2.md");
    expect(report.checks[0]?.evidence[1]?.source.title).toBe("Unsafe source");
    expect(report.checks[0]?.evidence[2]?.source.url).toBe("https://example.com/safe");
    expect(report.checks[0]?.evidence[3]?.source.url).toBeUndefined();
    expect(report.checks[0]?.evidence[3]?.source.path).toBe("llm path.md");
    expect(report.checks[0]?.evidence[4]?.source).toMatchObject({
      id: "source",
      title: "Verifier source",
      retrievedAt: "unknown",
      snippet: "Verifier-supplied evidence can omit runtime-required metadata."
    });
    expect(report.checks[0]?.evidence[4]?.source.url).toBeUndefined();
  });

  it("caps evidence snippets and text before verification and report output", async () => {
    const seenEvidence: Array<{ snippet?: string; text?: string }> = [];
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            {
              id: "claim-1",
              text: "SourceLine caps long evidence text.",
              claimType: "technical",
              importance: "medium",
              searchQueries: ["long evidence text"]
            }
          ]
        };
      },
      async verifyClaim(input) {
        seenEvidence.push(...input.evidence.map((source) => ({ snippet: source.snippet, text: source.text })));
        return {
          claim: input.claim,
          status: "supported",
          confidence: 0.8,
          evidence: [
            ...input.evidence.map((source) => ({
              source,
              relation: "supports" as const,
              confidence: 0.8,
              explanation: "Search evidence was capped."
            })),
            {
              source: {
                id: "llm-long-source",
                url: "https://example.com/llm-long",
                retrievedAt: "2026-06-07T00:00:00.000Z",
                snippet: "l".repeat(2_100),
                text: "m".repeat(20_100)
              },
              relation: "related",
              confidence: 0.2,
              explanation: "LLM supplied long evidence too."
            }
          ],
          explanation: "Mock explanation.",
          riskFlags: []
        };
      }
    };

    const searchProvider: SearchProvider = {
      name: "test-search",
      async search(query) {
        return [
          {
            id: "long-source",
            title: "Long source",
            url: "https://example.com/long",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: "s".repeat(2_100),
            text: "t".repeat(20_100),
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
        text: "SourceLine caps long evidence text."
      },
      llmProvider,
      searchProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(seenEvidence[0]?.snippet).toHaveLength(2_000);
    expect(seenEvidence[0]?.snippet).toMatch(/\.\.\. \[truncated\]$/);
    expect(seenEvidence[0]?.text).toHaveLength(20_000);
    expect(seenEvidence[0]?.text).toMatch(/\.\.\. \[truncated\]$/);
    expect(report.checks[0]?.evidence[0]?.source.snippet).toHaveLength(2_000);
    expect(report.checks[0]?.evidence[0]?.source.text).toHaveLength(20_000);
    expect(report.checks[0]?.evidence[1]?.source.snippet).toHaveLength(2_000);
    expect(report.checks[0]?.evidence[1]?.source.text).toHaveLength(20_000);
  });

  it("caps long claim and source metadata before verification and report output", async () => {
    const seen: Array<{
      claimText?: string;
      quote?: string;
      title?: string;
      retrievalExplanation?: string;
    }> = [];
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            {
              id: "claim-1",
              text: "c".repeat(2_100),
              sourceSpan: {
                startLine: 1,
                endLine: 1,
                quote: "q".repeat(2_100)
              },
              claimType: "technical",
              importance: "medium",
              searchQueries: ["long metadata"]
            }
          ]
        };
      },
      async verifyClaim(input) {
        seen.push({
          claimText: input.claim.text,
          quote: input.claim.sourceSpan?.quote,
          title: input.evidence[0]?.title,
          retrievalExplanation: input.evidence[0]?.retrieval?.explanation
        });

        return {
          claim: input.claim,
          status: "supported",
          confidence: 0.8,
          evidence: input.evidence.map((source) => ({
            source,
            relation: "supports",
            confidence: 0.8,
            quotedSupport: "u".repeat(4_100),
            explanation: "e".repeat(4_100)
          })),
          explanation: "x".repeat(4_100),
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
            title: "t".repeat(2_100),
            url: "https://example.com/metadata",
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: query.query,
            retrieval: {
              matchedTerms: ["m".repeat(700)],
              explanation: "r".repeat(4_100)
            },
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
        text: "SourceLine caps long metadata."
      },
      llmProvider,
      searchProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(seen[0]?.claimText).toHaveLength(2_000);
    expect(seen[0]?.claimText).toMatch(/\.\.\. \[truncated\]$/);
    expect(seen[0]?.quote).toHaveLength(2_000);
    expect(seen[0]?.title).toHaveLength(2_000);
    expect(seen[0]?.retrievalExplanation).toHaveLength(4_000);
    expect(report.checks[0]?.explanation).toHaveLength(4_000);
    expect(report.checks[0]?.evidence[0]?.explanation).toHaveLength(4_000);
    expect(report.checks[0]?.evidence[0]?.quotedSupport).toHaveLength(4_000);
    expect(report.checks[0]?.evidence[0]?.source.retrieval?.matchedTerms?.[0]).toHaveLength(500);
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
    const claimIds: string[] = [];
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            {
              id: " claim\n\u001b[31mone\u001b[0m ",
              text: "SourceLine guards report enum values.",
              claimType: "unknown_claim_type" as never,
              importance: "urgent" as never,
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
        claimIds.push(query.claimId);
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
    expect(claimIds).toEqual(["claim-one"]);
    expect(report.checks[0]?.claim.id).toBe("claim-one");
    expect(report.checks[0]?.claim.claimType).toBe("general_factual");
    expect(report.checks[0]?.claim.importance).toBe("medium");
    expect(report.checks[0]?.evidence[0]?.relation).toBe("related");
    expect(report.checks[0]?.riskFlags).toEqual(["weak_source"]);
  });

  it("drops malformed verifier evidence and non-array risk flags", async () => {
    const llmProvider: LlmProvider = {
      name: "test-llm",
      async extractClaims() {
        return {
          claims: [
            {
              id: "claim-1",
              text: "SourceLine tolerates malformed verifier output.",
              claimType: "technical",
              importance: "medium",
              searchQueries: ["malformed verifier output"]
            }
          ]
        };
      },
      async verifyClaim(input) {
        return {
          claim: input.claim,
          status: "supported",
          confidence: "high" as never,
          evidence: [
            undefined,
            { source: undefined, relation: "supports", confidence: 0.9, explanation: "missing source" },
            {
              source: {
                id: "source-1",
                title: "Verifier source",
                retrievedAt: "2026-06-07T00:00:00.000Z",
                snippet: "Readable verifier evidence.",
                retrieval: null
              },
              relation: "supports",
              confidence: 0.9,
              explanation: 123
            },
            {
              source: {
                snippet: "Evidence with missing source metadata.",
                retrieval: "not-an-object"
              } as never,
              relation: "contradicts",
              confidence: 0.7,
              quotedSupport: "\u001b[31mQuoted support\u001b[0m",
              explanation: "Runtime metadata was normalized."
            }
          ] as never,
          explanation: 42 as never,
          riskFlags: "weak_source" as never
        };
      }
    };

    const report = await runCheck({
      input: {
        kind: "text",
        name: "sample",
        text: "SourceLine tolerates malformed verifier output."
      },
      llmProvider,
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    expect(report.checks[0]?.confidence).toBe(0);
    expect(report.checks[0]?.riskFlags).toEqual([]);
    expect(report.checks[0]?.explanation).toBe("");
    expect(report.checks[0]?.evidence).toHaveLength(2);
    expect(report.checks[0]?.evidence[0]).toMatchObject({
      relation: "supports",
      confidence: 0.9,
      explanation: "",
      source: {
        id: "source-1",
        title: "Verifier source",
        retrievedAt: "2026-06-07T00:00:00.000Z",
        snippet: "Readable verifier evidence."
      }
    });
    expect(report.checks[0]?.evidence[0]?.source.retrieval).toBeUndefined();
    expect(report.checks[0]?.evidence[1]).toMatchObject({
      relation: "contradicts",
      confidence: 0.7,
      quotedSupport: "Quoted support",
      explanation: "Runtime metadata was normalized.",
      source: {
        id: "source",
        retrievedAt: "unknown",
        snippet: "Evidence with missing source metadata."
      }
    });
    expect(report.checks[0]?.evidence[1]?.source.retrieval).toBeUndefined();
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
    await expect(runCheck({ ...baseOptions, maxClaims: 101 })).rejects.toThrow("maxClaims must be at most 100.");
    await expect(runCheck({ ...baseOptions, maxResultsPerClaim: 21 })).rejects.toThrow(
      "maxResultsPerClaim must be at most 20."
    );
    await expect(runCheck({ ...baseOptions, minConfidence: Number.NaN })).rejects.toThrow(
      "minConfidence must be a number between 0 and 1."
    );
    await expect(runCheck({ ...baseOptions, minConfidence: 1.2 })).rejects.toThrow(
      "minConfidence must be a number between 0 and 1."
    );
    expect(extractCalls).toBe(0);
  });});
