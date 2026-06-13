import { describe, expect, it } from "vitest";
import { renderMarkdownReport } from "./markdown.js";
import type { SourceLineReport } from "@sourceline/core";

describe("renderMarkdownReport", () => {
  it("renders summary and claim evidence", () => {
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
            text: "SourceLine exports Markdown reports.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["SourceLine Markdown reports"]
          },
          status: "supported",
          confidence: 0.8,
          evidence: [
            {
              source: {
                id: "source-1",
                title: "Mock source",
                url: "https://example.com",
                retrievedAt: "2026-06-07T00:00:00.000Z",
                retrieval: {
                  score: 1.234,
                  matchedTerms: ["sourceline", "markdown"],
                  explanation: "2/3 query terms matched."
                }
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

    expect(renderMarkdownReport(report)).toContain("SourceLine exports Markdown reports.");
    expect(renderMarkdownReport(report)).toContain("[Mock source](https://example.com)");
    expect(renderMarkdownReport(report)).toContain("score 1.234");
    expect(renderMarkdownReport(report)).toContain("matched sourceline, markdown");
    expect(renderMarkdownReport(report)).toContain("2/3 query terms matched.");
  });

  it("wraps complex local evidence paths in safe Markdown link destinations", () => {
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
            text: "Local evidence paths can contain spaces.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["local evidence paths"]
          },
          status: "supported",
          confidence: 0.8,
          evidence: [
            {
              source: {
                id: "source-1",
                title: "Folder [draft] notes",
                path: "examples/sources/Folder (draft)/local note.md",
                retrievedAt: "2026-06-07T00:00:00.000Z"
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

    expect(renderMarkdownReport(report)).toContain(
      "[Folder \\[draft\\] notes](<examples/sources/Folder (draft)/local note.md>)"
    );
  });


  it("keeps structural Markdown fields on one escaped line", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "sample [draft]\nsecond line",
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
            text: "Claim [draft]\n- injected list item",
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
                title: "Mock source",
                url: "https://example.com/source",
                retrievedAt: "2026-06-07T00:00:00.000Z",
                snippet: "First line\n- injected evidence item"
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

    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("Input: sample \\[draft\\] second line");
    expect(markdown).toContain("### 1. Claim \\[draft\\] - injected list item");
    expect(markdown).toContain(" - First line - injected evidence item");
  });

  it("keeps explanations and metadata structurally safe", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "sample",
        hash: "abc`123\n# injected"
      },
      generatedAt: "2026-06-07T08:00:00.000Z\n## injected",
      summary: {
        totalClaims: 1,
        supported: 0,
        partiallySupported: 1,
        unsupported: 0,
        contradicted: 0,
        notEnoughEvidence: 0
      },
      checks: [
        {
          claim: {
            id: "claim-1",
            text: "Markdown explanations should stay safe.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["safe markdown explanations"]
          },
          status: "partially_supported",
          confidence: 0.6,
          evidence: [
            {
              source: {
                id: "source-1",
                title: "Evidence [draft]\n- injected title",
                url: "https://example.com/source",
                retrievedAt: "2026-06-07T00:00:00.000Z",
                retrieval: {
                  matchedTerms: ["safe\nterm", "[linked]"],
                  explanation: "First line\n- injected retrieval"
                }
              },
              relation: "partially_supports",
              confidence: 0.6,
              explanation: "Mock support."
            }
          ],
          explanation: "First line\n- injected list item\n\u001b[31mred\u001b[0m `tick`",
          riskFlags: ["requires_expert_review"]
        }
      ]
    };

    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("Generated: 2026-06-07T08:00:00.000Z ## injected");
    expect(markdown).toContain("Input hash: ``abc`123 # injected``");
    expect(markdown).toContain(
      "[Evidence \\[draft\\] - injected title](https://example.com/source)"
    );
    expect(markdown).toContain("matched safe term, \\[linked\\]");
    expect(markdown).toContain("First line - injected retrieval");
    expect(markdown).toContain("First line - injected list item red `tick`");
    expect(markdown).toContain("- `requires_expert_review`");
    expect(markdown).not.toContain("\n- injected list item");
    expect(markdown).not.toContain("\u001b[31m");
  });


  it("does not link unsafe evidence URL schemes", () => {
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
            text: "Evidence links should be safe.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["safe evidence links"]
          },
          status: "supported",
          confidence: 0.8,
          evidence: [
            {
              source: {
                id: "source-1",
                title: "Unsafe [source]",
                url: "javascript:alert(1)",
                retrievedAt: "2026-06-07T00:00:00.000Z"
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

    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("Unsafe \\[source\\] (supports, 0.80)");
    expect(markdown).not.toContain("[Unsafe \\[source\\]](javascript:alert(1))");
  });

  it("does not turn protocol-relative evidence locations into external Markdown links", () => {
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
            text: "Protocol-relative evidence locations should not be linked.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["protocol relative evidence"]
          },
          status: "supported",
          confidence: 0.8,
          evidence: [
            {
              source: {
                id: "source-1",
                title: "Protocol-relative source",
                url: "//example.com/source",
                retrievedAt: "2026-06-07T00:00:00.000Z"
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

    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("Protocol-relative source (supports, 0.80)");
    expect(markdown).not.toContain("[Protocol-relative source](//example.com/source)");
  });

  it("does not link evidence locations containing control characters", () => {
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
            text: "Evidence locations should stay structurally safe.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["safe evidence locations"]
          },
          status: "supported",
          confidence: 0.8,
          evidence: [
            {
              source: {
                id: "source-1",
                title: "Control character source",
                url: "https://example.com/safe\nnext-line",
                retrievedAt: "2026-06-07T00:00:00.000Z"
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

    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("Control character source (supports, 0.80)");
    expect(markdown).not.toContain("https://example.com/safe\nnext-line");
  });

  it("does not link remote evidence URLs containing spaces", () => {
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
            text: "Remote evidence URLs should be structurally safe.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["safe evidence urls"]
          },
          status: "supported",
          confidence: 0.8,
          evidence: [
            {
              source: {
                id: "source-1",
                title: "Spaced URL source",
                url: "https://example.com/safe path",
                retrievedAt: "2026-06-07T00:00:00.000Z"
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

    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("Spaced URL source (supports, 0.80)");
    expect(markdown).not.toContain("[Spaced URL source](<https://example.com/safe path>)");
  });

  it("clamps confidence values and skips non-finite retrieval scores", () => {
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
            text: "Renderer confidence values should stay finite.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["finite renderer confidence"]
          },
          status: "supported",
          confidence: 1.234,
          evidence: [
            {
              source: {
                id: "source-1",
                title: "Numeric source",
                url: "https://example.com/numeric",
                retrievedAt: "2026-06-07T00:00:00.000Z",
                retrieval: {
                  score: Number.POSITIVE_INFINITY
                }
              },
              relation: "supports",
              confidence: -0.2,
              explanation: "Mock support."
            }
          ],
          explanation: "Mock explanation.",
          riskFlags: []
        }
      ]
    };

    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("Confidence: 1.00");
    expect(markdown).toContain("(supports, 0.00)");
    expect(markdown).not.toContain("Infinity");
    expect(markdown).not.toContain("NaN");
    expect(markdown).not.toContain("score Infinity");
  });

  it("renders summary counts derived from checks", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "sample",
        hash: "abc123"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {
        totalClaims: 99,
        supported: 99,
        partiallySupported: 99,
        unsupported: 99,
        contradicted: 99,
        notEnoughEvidence: 99
      },
      checks: [
        {
          claim: {
            id: "claim-1",
            text: "One claim is supported.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["supported claim"]
          },
          status: "supported",
          confidence: 0.9,
          evidence: [],
          explanation: "Mock explanation.",
          riskFlags: []
        },
        {
          claim: {
            id: "claim-2",
            text: "One claim is unsupported.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["unsupported claim"]
          },
          status: "unsupported",
          confidence: 0.2,
          evidence: [],
          explanation: "Mock explanation.",
          riskFlags: []
        }
      ]
    };

    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("- Claims found: 2");
    expect(markdown).toContain("- Supported: 1");
    expect(markdown).toContain("- Unsupported: 1");
    expect(markdown).toContain("- Partially supported: 0");
    expect(markdown).not.toContain("99");
  });
});
