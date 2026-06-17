import { describe, expect, it } from "vitest";
import type { SourceLineReport } from "@sourceline/core";
import { renderJsonReport } from "./json.js";

describe("renderJsonReport", () => {
  it("derives summary from checks and sanitizes non-finite numbers before serializing", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: " sample\n\u001b[31mred\u001b[0m ",
        hash: " abc123\n\u001b[31m "
      },
      generatedAt: "2026-06-07T08:00:00.000Z\n\u001b]0;hidden-title\u0007",
      summary: {
        totalClaims: Number.POSITIVE_INFINITY,
        supported: 1.9,
        partiallySupported: -1,
        unsupported: Number.NaN,
        contradicted: 0,
        notEnoughEvidence: 0
      },
      checks: [
        {
          claim: {
            id: " \u001b[31mclaim-1\u001b[0m ",
            text: "  \u001b[31mJSON reports\u001b[0m should preserve numeric schema safety.\n",
            claimType: "technical",
            importance: "medium",
            searchQueries: [" json \u001b[32mnumeric\u001b[0m schema ", " \n\t "],
            sourceSpan: {
              startLine: Number.POSITIVE_INFINITY,
              endLine: 4.8,
              quote: "  \u001b[31mQuoted\u001b[0m\nclaim\u0007  "
            }
          },
          status: "supported",
          confidence: 1.234,
          evidence: [
            {
              source: {
                id: " \u001b[31msource-1\u001b[0m ",
                title: "  \u001b[31mNumeric\u001b[0m source  ",
                url: "https://example.com/numeric",
                publisher: "  \u001b[32mNumeric\u001b[0m publisher  ",
                publishedAt: " \u001b[34m2026-06-06\u001b[0m ",
                retrievedAt: "2026-06-07T00:00:00.000Z\n\u001b[31m",
                snippet: "  \u001b[33mSnippet\u001b[0m with\ncontrols  ",
                text: " Line one\r\n\u001b[31mLine two\u001b[0m\u0007 ",
                retrieval: {
                  score: Number.NEGATIVE_INFINITY,
                  matchedTerms: ["json", " \n\t ", "\u001b[31mred\u001b[0m\u0007 term"],
                  explanation: "Line one\r\n\u001b]0;hidden-title\u0007Line two\u0000"
                }
              },
              relation: "supports",
              confidence: Number.NaN,
              quotedSupport: " \u001b[34mMock\u001b[0m support.\n",
              explanation: "Mock \u001b[35msupport\u001b[0m."
            }
          ],
          explanation: "Mock \u001b[36mexplanation\u001b[0m.",
          riskFlags: []
        }
      ]
    };

    const json = renderJsonReport(report);
    const parsed = JSON.parse(json) as SourceLineReport;

    expect(parsed.input).toEqual({
      kind: "text",
      name: "sample red",
      hash: "abc123"
    });
    expect(parsed.generatedAt).toBe("2026-06-07T08:00:00.000Z");
    expect(parsed.summary.totalClaims).toBe(1);
    expect(parsed.summary.supported).toBe(1);
    expect(parsed.summary.partiallySupported).toBe(0);
    expect(parsed.summary.unsupported).toBe(0);
    expect(parsed.summary.contradicted).toBe(0);
    expect(parsed.summary.notEnoughEvidence).toBe(0);
    expect(parsed.checks[0]?.confidence).toBe(1);
    expect(parsed.checks[0]?.claim.id).toBe("claim-1");
    expect(parsed.checks[0]?.claim.text).toBe("JSON reports should preserve numeric schema safety.");
    expect(parsed.checks[0]?.claim.searchQueries).toEqual(["json numeric schema"]);
    expect(parsed.checks[0]?.claim.sourceSpan).toEqual({
      endLine: 4,
      quote: "Quoted claim"
    });
    expect(parsed.checks[0]?.evidence[0]?.confidence).toBe(0);
    expect(parsed.checks[0]?.evidence[0]?.quotedSupport).toBe("Mock support.");
    expect(parsed.checks[0]?.evidence[0]?.explanation).toBe("Mock support.");
    expect(parsed.checks[0]?.evidence[0]?.source.id).toBe("source-1");
    expect(parsed.checks[0]?.evidence[0]?.source.title).toBe("Numeric source");
    expect(parsed.checks[0]?.evidence[0]?.source.publisher).toBe("Numeric publisher");
    expect(parsed.checks[0]?.evidence[0]?.source.publishedAt).toBe("2026-06-06");
    expect(parsed.checks[0]?.evidence[0]?.source.retrievedAt).toBe("2026-06-07T00:00:00.000Z");
    expect(parsed.checks[0]?.evidence[0]?.source.snippet).toBe("Snippet with controls");
    expect(parsed.checks[0]?.evidence[0]?.source.text).toBe("Line one\nLine two");
    expect(parsed.checks[0]?.evidence[0]?.source.retrieval).toEqual({
      matchedTerms: ["json", "red term"],
      explanation: "Line one Line two"
    });
    expect(parsed.checks[0]?.explanation).toBe("Mock explanation.");
    expect(json).not.toContain("Infinity");
    expect(json).not.toContain("NaN");
    expect(json).not.toContain("null");
    expect(json).not.toContain("hidden-title");
  });

  it("normalizes invalid runtime enum values before serializing", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "sample",
        hash: "abc123"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {
        totalClaims: 1,
        supported: 1,
        partiallySupported: 0,
        unsupported: 0,
        contradicted: 0,
        notEnoughEvidence: 0
      },
      checks: [
        {
          claim: {
            id: "claim-1",
            text: "Report rendering should guard enum values.",
            claimType: "unknown_claim_type" as never,
            importance: "urgent" as never,
            searchQueries: ["report enum values"]
          },
          status: "unknown_status" as never,
          confidence: 0.5,
          evidence: [
            {
              source: {
                id: "source-1",
                title: "Enum source",
                url: "https://example.com/enums",
                retrievedAt: "2026-06-07T00:00:00.000Z",
                snippet: "Enum values are sanitized."
              },
              relation: "unknown_relation" as never,
              confidence: 0.5,
              explanation: "Invalid relation should fall back."
            }
          ],
          explanation: "Invalid status should fall back.",
          riskFlags: ["weak_source", "unknown_flag" as never, "weak_source"]
        }
      ]
    };

    const parsed = JSON.parse(renderJsonReport(report)) as SourceLineReport;

    expect(parsed.summary).toEqual({
      totalClaims: 1,
      supported: 0,
      partiallySupported: 0,
      unsupported: 0,
      contradicted: 0,
      notEnoughEvidence: 1
    });
    expect(parsed.checks[0]?.status).toBe("not_enough_evidence");
    expect(parsed.checks[0]?.claim.claimType).toBe("general_factual");
    expect(parsed.checks[0]?.claim.importance).toBe("medium");
    expect(parsed.checks[0]?.evidence[0]?.relation).toBe("related");
    expect(parsed.checks[0]?.riskFlags).toEqual(["weak_source"]);
  });

  it("drops credentialed remote source URLs before serializing", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "sample",
        hash: "abc123"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {
        totalClaims: 1,
        supported: 1,
        partiallySupported: 0,
        unsupported: 0,
        contradicted: 0,
        notEnoughEvidence: 0
      },
      checks: [
        {
          claim: {
            id: "claim-1",
            text: "Credentialed evidence URLs should not be serialized.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["credentialed evidence urls"]
          },
          status: "supported",
          confidence: 0.8,
          evidence: [
            {
              source: {
                id: "source-1",
                url: "https://user:secret@example.com/private",
                retrievedAt: "2026-06-07T00:00:00.000Z",
                snippet: "Evidence text is still available."
              },
              relation: "supports",
              confidence: 0.8,
              explanation: "Mock support."
            }
          ],
          explanation: "Mock explanation.",
          riskFlags: []
        }
      ]
    };

    const json = renderJsonReport(report);
    const parsed = JSON.parse(json) as SourceLineReport;

    expect(parsed.checks[0]?.evidence[0]?.source.url).toBeUndefined();
    expect(parsed.checks[0]?.evidence[0]?.source.snippet).toBe("Evidence text is still available.");
    expect(json).not.toContain("user:secret");
    expect(json).not.toContain("https://user");
  });

  it("sanitizes unsafe source URLs and paths before serializing", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "sample",
        hash: "abc123"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {
        totalClaims: 1,
        supported: 1,
        partiallySupported: 0,
        unsupported: 0,
        contradicted: 0,
        notEnoughEvidence: 0
      },
      checks: [
        {
          claim: {
            id: "claim-1",
            text: "Unsafe evidence source locations should not be serialized.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["unsafe evidence source locations"]
          },
          status: "supported",
          confidence: 0.8,
          evidence: [
            {
              source: {
                id: "source-1",
                url: "javascript:alert(1)",
                path: " notes/\u001b[31munsafe\u001b[0m\npath.md ",
                retrievedAt: "2026-06-07T00:00:00.000Z",
                snippet: "Evidence text is still available."
              },
              relation: "supports",
              confidence: 0.8,
              explanation: "Mock support."
            }
          ],
          explanation: "Mock explanation.",
          riskFlags: []
        }
      ]
    };

    const json = renderJsonReport(report);
    const parsed = JSON.parse(json) as SourceLineReport;

    expect(parsed.checks[0]?.evidence[0]?.source.url).toBeUndefined();
    expect(parsed.checks[0]?.evidence[0]?.source.path).toBe("notes/unsafe path.md");
    expect(json).not.toContain("javascript:alert");
    expect(json).not.toContain("\\n");
    expect(json).not.toContain("\\u001b");
  });

  it("caps long evidence snippets and text before serializing", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "sample",
        hash: "abc123"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {
        totalClaims: 1,
        supported: 1,
        partiallySupported: 0,
        unsupported: 0,
        contradicted: 0,
        notEnoughEvidence: 0
      },
      checks: [
        {
          claim: {
            id: "claim-1",
            text: "Long evidence text should be capped.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["long evidence text"]
          },
          status: "supported",
          confidence: 0.8,
          evidence: [
            {
              source: {
                id: "source-1",
                url: "https://example.com/long",
                retrievedAt: "2026-06-07T00:00:00.000Z",
                snippet: "s".repeat(2_100),
                text: "Line one\n".repeat(3_000)
              },
              relation: "supports",
              confidence: 0.8,
              explanation: "Mock support."
            }
          ],
          explanation: "Mock explanation.",
          riskFlags: []
        }
      ]
    };

    const parsed = JSON.parse(renderJsonReport(report)) as SourceLineReport;
    const source = parsed.checks[0]?.evidence[0]?.source;

    expect(source?.snippet).toHaveLength(2_000);
    expect(source?.snippet).toMatch(/\.\.\. \[truncated\]$/);
    expect(source?.text).toHaveLength(20_000);
    expect(source?.text).toMatch(/\.\.\. \[truncated\]$/);
  });

  it("caps report checks and evidence arrays before serializing", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "sample",
        hash: "abc123"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {
        totalClaims: 105,
        supported: 105,
        partiallySupported: 0,
        unsupported: 0,
        contradicted: 0,
        notEnoughEvidence: 0
      },
      checks: Array.from({ length: 105 }, (_, checkIndex) => ({
        claim: {
          id: `claim-${checkIndex + 1}`,
          text: `Bounded report claim ${checkIndex + 1}.`,
          claimType: "technical" as const,
          importance: "medium" as const,
          searchQueries: ["bounded report arrays"]
        },
        status: "supported" as const,
        confidence: 0.9,
        evidence: Array.from({ length: checkIndex === 0 ? 25 : 0 }, (_, evidenceIndex) => ({
          source: {
            id: `source-${evidenceIndex + 1}`,
            title: `Evidence ${evidenceIndex + 1}`,
            url: `https://example.com/evidence-${evidenceIndex + 1}`,
            retrievedAt: "2026-06-07T00:00:00.000Z",
            snippet: `Evidence snippet ${evidenceIndex + 1}.`
          },
          relation: "supports" as const,
          confidence: 0.9,
          explanation: "Mock support."
        })),
        explanation: "Mock explanation.",
        riskFlags: []
      }))
    };

    const parsed = JSON.parse(renderJsonReport(report)) as SourceLineReport;
    const serialized = JSON.stringify(parsed);

    expect(parsed.checks).toHaveLength(100);
    expect(parsed.summary.totalClaims).toBe(100);
    expect(parsed.summary.supported).toBe(100);
    expect(parsed.checks[0]?.evidence).toHaveLength(20);
    expect(parsed.checks[0]?.evidence[19]?.source.id).toBe("source-20");
    expect(serialized).not.toContain("Bounded report claim 101.");
    expect(serialized).not.toContain("source-21");
  });

  it("caps long claim search query lists before serializing", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "sample",
        hash: "abc123"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {
        totalClaims: 1,
        supported: 1,
        partiallySupported: 0,
        unsupported: 0,
        contradicted: 0,
        notEnoughEvidence: 0
      },
      checks: [
        {
          claim: {
            id: "claim-1",
            text: "Long search query lists should be capped.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["x".repeat(700), "query 1", "query 2", "query 3", "query 4", "query 5"]
          },
          status: "supported",
          confidence: 0.8,
          evidence: [],
          explanation: "Mock explanation.",
          riskFlags: []
        }
      ]
    };

    const parsed = JSON.parse(renderJsonReport(report)) as SourceLineReport;

    expect(parsed.checks[0]?.claim.searchQueries).toHaveLength(5);
    expect(parsed.checks[0]?.claim.searchQueries[0]).toHaveLength(500);
    expect(parsed.checks[0]?.claim.searchQueries[0]).toMatch(/\.\.\. \[truncated\]$/);
    expect(parsed.checks[0]?.claim.searchQueries).not.toContain("query 5");
  });

  it("caps long inline report fields before serializing", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "n".repeat(2_100),
        hash: "abc123"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {
        totalClaims: 1,
        supported: 1,
        partiallySupported: 0,
        unsupported: 0,
        contradicted: 0,
        notEnoughEvidence: 0
      },
      checks: [
        {
          claim: {
            id: "claim-1",
            text: "c".repeat(2_100),
            sourceSpan: {
              startLine: 1,
              endLine: 1,
              quote: "q".repeat(2_100)
            },
            claimType: "technical",
            importance: "medium",
            searchQueries: ["claim"]
          },
          status: "supported",
          confidence: 0.8,
          evidence: [
            {
              source: {
                id: "source-1",
                title: "t".repeat(2_100),
                url: `https://example.com/${"u".repeat(2_100)}`,
                path: "p".repeat(2_100),
                publisher: "p".repeat(2_100),
                retrievedAt: "2026-06-07T00:00:00.000Z",
                snippet: "Evidence text.",
                retrieval: {
                  matchedTerms: Array.from({ length: 60 }, (_, index) => `term-${index}`),
                  explanation: "r".repeat(4_100)
                }
              },
              relation: "supports",
              confidence: 0.8,
              quotedSupport: "u".repeat(4_100),
              explanation: "e".repeat(4_100)
            }
          ],
          explanation: "x".repeat(4_100),
          riskFlags: []
        }
      ]
    };

    const parsed = JSON.parse(renderJsonReport(report)) as SourceLineReport;
    const check = parsed.checks[0];
    const evidence = check?.evidence[0];

    expect(parsed.input.name).toHaveLength(2_000);
    expect(check?.claim.text).toHaveLength(2_000);
    expect(check?.claim.sourceSpan?.quote).toHaveLength(2_000);
    expect(check?.explanation).toHaveLength(4_000);
    expect(evidence?.source.title).toHaveLength(2_000);
    expect(evidence?.source.url).toBeUndefined();
    expect(evidence?.source.path).toHaveLength(2_000);
    expect(evidence?.source.publisher).toHaveLength(2_000);
    expect(evidence?.source.retrieval?.matchedTerms).toHaveLength(50);
    expect(evidence?.source.retrieval?.explanation).toHaveLength(4_000);
    expect(evidence?.quotedSupport).toHaveLength(4_000);
    expect(evidence?.explanation).toHaveLength(4_000);
    expect(check?.claim.text).toMatch(/\.\.\. \[truncated\]$/);
    expect(check?.explanation).toMatch(/\.\.\. \[truncated\]$/);
  });

  it("normalizes report schema metadata before serializing", () => {
    const report: SourceLineReport = {
      schemaVersion: "2.0" as never,
      input: {
        kind: "clipboard" as never,
        name: "sample",
        hash: "\u001b[31m"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {
        totalClaims: 0,
        supported: 0,
        partiallySupported: 0,
        unsupported: 0,
        contradicted: 0,
        notEnoughEvidence: 0
      },
      checks: []
    };

    const parsed = JSON.parse(renderJsonReport(report)) as SourceLineReport;

    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.input.kind).toBe("text");
    expect(parsed.input.hash).toBe("unknown");
  });

  it("normalizes malformed runtime report roots before serializing", () => {
    const parsed = JSON.parse(
      renderJsonReport({
        schemaVersion: "2.0",
        input: "not-an-input",
        generatedAt: 123,
        summary: "not-a-summary",
        checks: "not-an-array"
      } as never)
    ) as SourceLineReport;

    expect(parsed).toEqual({
      schemaVersion: "1.0",
      input: {
        kind: "text",
        hash: "unknown"
      },
      generatedAt: "",
      summary: {
        totalClaims: 0,
        supported: 0,
        partiallySupported: 0,
        unsupported: 0,
        contradicted: 0,
        notEnoughEvidence: 0
      },
      checks: []
    });
  });

  it("drops unknown top-level runtime fields before serializing", () => {
    const parsed = JSON.parse(
      renderJsonReport({
        schemaVersion: "1.0",
        input: {
          kind: "text",
          hash: "abc123"
        },
        generatedAt: "2026-06-07T08:00:00.000Z",
        summary: {
          totalClaims: 0,
          supported: 0,
          partiallySupported: 0,
          unsupported: 0,
          contradicted: 0,
          notEnoughEvidence: 0
        },
        checks: [],
        runtimeOnly: BigInt(1)
      } as never)
    ) as SourceLineReport & { runtimeOnly?: unknown };

    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.input.hash).toBe("abc123");
    expect(parsed.runtimeOnly).toBeUndefined();
  });

  it("drops malformed runtime check and evidence entries before serializing", () => {
    const report = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        hash: "abc123"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {},
      checks: [
        undefined,
        {
          claim: {
            id: 123,
            text: 456,
            claimType: "unknown",
            importance: "urgent",
            searchQueries: "not-an-array",
            sourceSpan: "not-a-source-span"
          },
          status: "supported",
          confidence: "high",
          evidence: "not-an-array",
          explanation: 789,
          riskFlags: "weak_source"
        },
        {
          claim: {
            id: " Claim/Two?<script> ",
            text: "Runtime report evidence is defensive.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["runtime report evidence"]
          },
          status: "unknown",
          confidence: 0.6,
          evidence: [
            "not-evidence",
            { source: undefined, relation: "supports", confidence: 0.8, explanation: "missing source" },
            {
              source: {
                id: " Source/One?<script> ",
                retrievedAt: 456,
                url: 789,
                path: "\u001b[31mpath.md\u001b[0m",
                snippet: "Readable evidence.",
                retrieval: {
                  score: "high",
                  matchedTerms: "not-an-array",
                  explanation: 123
                }
              },
              relation: "unknown",
              confidence: Number.POSITIVE_INFINITY,
              quotedSupport: 123,
              explanation: 456
            }
          ],
          explanation: "Sanitized.",
          riskFlags: ["weak_source", "weak_source", "unknown_flag"]
        }
      ]
    };

    const parsed = JSON.parse(renderJsonReport(report as never)) as SourceLineReport;

    expect(parsed.summary).toEqual({
      totalClaims: 2,
      supported: 1,
      partiallySupported: 0,
      unsupported: 0,
      contradicted: 0,
      notEnoughEvidence: 1
    });
    expect(parsed.checks[0]).toMatchObject({
      claim: {
        id: "claim",
        text: "Untitled claim.",
        claimType: "general_factual",
        importance: "medium",
        searchQueries: []
      },
      status: "supported",
      confidence: 0,
      evidence: [],
      explanation: "",
      riskFlags: []
    });
    expect(parsed.checks[1]?.evidence).toHaveLength(1);
    expect(parsed.checks[1]?.claim.id).toBe("claim-two-script");
    expect(parsed.checks[1]?.status).toBe("not_enough_evidence");
    expect(parsed.checks[1]?.riskFlags).toEqual(["weak_source"]);
    expect(parsed.checks[1]?.evidence[0]).toMatchObject({
      relation: "related",
      confidence: 0,
      explanation: "",
      source: {
        id: "source-one-script",
        retrievedAt: "unknown",
        path: "path.md",
        snippet: "Readable evidence."
      }
    });
    expect(parsed.checks[1]?.evidence[0]?.source.url).toBeUndefined();
    expect(parsed.checks[1]?.evidence[0]?.source.retrieval).toBeUndefined();
  });

  it("drops reversed source span line ranges while preserving quotes", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "sample",
        hash: "abc123"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {
        totalClaims: 1,
        supported: 1,
        partiallySupported: 0,
        unsupported: 0,
        contradicted: 0,
        notEnoughEvidence: 0
      },
      checks: [
        {
          claim: {
            id: "claim-1",
            text: "Source spans should not point backwards.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["source spans"],
            sourceSpan: {
              startLine: 10,
              endLine: 3,
              quote: "Original quote"
            }
          },
          status: "supported",
          confidence: 0.8,
          evidence: [],
          explanation: "Mock explanation.",
          riskFlags: []
        }
      ]
    };

    const parsed = JSON.parse(renderJsonReport(report)) as SourceLineReport;

    expect(parsed.checks[0]?.claim.sourceSpan).toEqual({
      quote: "Original quote"
    });
  });
});
