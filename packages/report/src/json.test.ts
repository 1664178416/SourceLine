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
            id: "claim-1",
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
            claimType: "technical",
            importance: "medium",
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
    expect(parsed.checks[0]?.evidence[0]?.relation).toBe("related");
    expect(parsed.checks[0]?.riskFlags).toEqual(["weak_source"]);
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
