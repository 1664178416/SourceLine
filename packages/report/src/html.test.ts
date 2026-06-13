import { describe, expect, it } from "vitest";
import { renderHtmlReport } from "./html.js";
import type { SourceLineReport } from "@sourceline/core";

describe("renderHtmlReport", () => {
  it("escapes claim text and renders linked evidence", () => {
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
            text: "SourceLine renders <HTML> reports.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["SourceLine HTML reports"]
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
                snippet: "HTML reports are available.",
                retrieval: {
                  score: 0.875,
                  matchedTerms: ["HTML", "reports"],
                  explanation: "2/2 query terms matched."
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

    const html = renderHtmlReport(report);
    expect(html).toContain("SourceLine renders &lt;HTML&gt; reports.");
    expect(html).toContain('<a href="https://example.com">Mock source</a>');
    expect(html).toContain('class="skip-link" href="#claims-heading"');
    expect(html).toContain('<main id="report-content">');
    expect(html).toContain('role="region" aria-label="Claim filters and export tools"');
    expect(html).toContain('@media print');
    expect(html).toContain('a[href^="http"]::after');
    expect(html).toContain('break-inside: avoid');
    expect(html).toContain('data-filter="review"');
    expect(html).toContain('data-filter-shortcut="1"');
    expect(html).toContain('aria-keyshortcuts="1"');
    expect(html).toContain('aria-label="Show All claims, shortcut 1"');
    expect(html).toContain('title="Shortcut 1"');
    expect(html).toContain('data-filter="partially_supported"');
    expect(html).toContain('data-filter="unsupported"');
    expect(html).toContain('data-filter="contradicted"');
    expect(html).toContain('data-filter="not_enough_evidence"');
    expect(html).toContain('id="claim-search"');
    expect(html).toContain('aria-keyshortcuts="/"');
    expect(html).toContain('id="visible-count"');
    expect(html).toContain('id="copy-visible-summary"');
    expect(html).toContain('aria-label="Copy visible claims summary"');
    expect(html).toContain('id="download-json"');
    expect(html).toContain('aria-label="Download report JSON"');
    expect(html).toContain('id="reset-view"');
    expect(html).toContain('aria-label="Reset filters and search"');
    expect(html).toContain('aria-keyshortcuts="Escape"');
    expect(html).toContain('id="sourceline-report-data"');
    expect(html).toContain('"schemaVersion":"1.0"');
    expect(html).toContain("SourceLine renders \\u003cHTML\\u003e reports.");
    expect(html).toContain('id="claim-1"');
    expect(html).toContain('aria-labelledby="claim-1-heading"');
    expect(html).toContain('id="claim-1-heading"');
    expect(html).toContain('id="claim-1-evidence-heading"');
    expect(html).toContain('aria-labelledby="claim-1-evidence-heading"');
    expect(html).toContain('data-claim-status="supported"');
    expect(html).toContain('data-claim-confidence="0.80"');
    expect(html).toContain('data-claim-text="SourceLine renders &lt;HTML&gt; reports."');
    expect(html).toContain('data-claim-search="SourceLine renders &lt;HTML&gt; reports.');
    expect(html).toContain('data-nav-for="claim-1"');
    expect(html).toContain('aria-labelledby="claim-index-heading"');
    expect(html).toContain('id="claim-index-heading"');
    expect(html).toContain('aria-labelledby="summary-heading"');
    expect(html).toContain('id="summary-heading"');
    expect(html).toContain("addEventListener(\"input\", updateClaims)");
    expect(html).toContain("document.addEventListener(\"keydown\"");
    expect(html).toContain('event.key === "/"');
    expect(html).toContain('event.key === "Escape"');
    expect(html).toContain("buildVisibleSummary()");
    expect(html).toContain("downloadJson");
    expect(html).toContain("Showing \" + visible + \" of \" + claims.length + \" claims");
    expect(html).toContain("score 0.875");
    expect(html).toContain("matched HTML, reports");
    expect(html).toContain("2/2 query terms matched.");
  });

  it("does not link unsafe evidence URL schemes", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: " sample\n\u001b[31mred\u001b[0m ",
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
                title: "Unsafe source",
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

    const html = renderHtmlReport(report);

    expect(html).toContain("Unsafe source");
    expect(html).not.toContain('href="javascript:alert(1)"');
  });

  it("does not turn protocol-relative evidence locations into external HTML links", () => {
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

    const html = renderHtmlReport(report);

    expect(html).toContain("Protocol-relative source");
    expect(html).not.toContain('href="//example.com/source"');
  });

  it("normalizes local evidence paths in HTML links", () => {
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
            text: "Local evidence paths should render as usable links.",
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
                title: "Folder source",
                path: "examples\\sources\\Folder (draft)\\local note.md",
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

    const html = renderHtmlReport(report);

    expect(html).toContain('<a href="examples/sources/Folder (draft)/local note.md">Folder source</a>');
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

    const html = renderHtmlReport(report);

    expect(html).toContain("Control character source");
    expect(html).not.toContain('href="https://example.com/safe');
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

    const html = renderHtmlReport(report);

    expect(html).toContain("Spaced URL source");
    expect(html).not.toContain('href="https://example.com/safe path"');
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

    const html = renderHtmlReport(report);

    expect(html).toContain('data-claim-confidence="1.00"');
    expect(html).toContain('class="badge">confidence 1.00</span>');
    expect(html).toContain('class="badge">supports 0.00</span>');

    const embeddedJson = html.match(/<script type="application\/json" id="sourceline-report-data">([\s\S]*?)<\/script>/)?.[1];
    expect(embeddedJson).toBeDefined();
    const parsed = JSON.parse(embeddedJson ?? "{}") as SourceLineReport;
    expect(parsed.checks[0]?.confidence).toBe(1);
    expect(parsed.checks[0]?.evidence[0]?.confidence).toBe(0);
    expect(parsed.checks[0]?.evidence[0]?.source.retrieval).toBeUndefined();
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("score Infinity");
  });

  it("renders summary, filter counts, and embedded JSON from checks", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "sample",
        hash: "abc123"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {
        totalClaims: 42,
        supported: 42,
        partiallySupported: 42,
        unsupported: 42,
        contradicted: 42,
        notEnoughEvidence: 42
      },
      checks: [
        {
          claim: {
            id: "claim-1",
            text: "A supported claim is shown.",
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
            text: "A partially supported claim is shown.",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["partial claim"]
          },
          status: "partially_supported",
          confidence: 0.6,
          evidence: [],
          explanation: "Mock explanation.",
          riskFlags: []
        }
      ]
    };

    const html = renderHtmlReport(report);

    expect(html).toContain("<strong>2</strong><span>Claims</span>");
    expect(html).toContain("<strong>1</strong><span>Supported</span>");
    expect(html).toContain("<strong>1</strong><span>Partial</span>");
    expect(html).toContain("<strong>0</strong><span>Unsupported</span>");
    expect(html).toContain("All (2)");
    expect(html).toContain("Review (1)");
    expect(html).toContain("Supported (1)");
    expect(html).toContain("Partial (1)");
    expect(html).toContain("Unsupported (0)");
    expect(html).toContain("Showing 2 of 2 claims");
    expect(html).not.toContain("All (42)");
    expect(html).not.toContain("Supported (42)");
    expect(html).not.toContain('"totalClaims":42');

    const embeddedJson = html.match(/<script type="application\/json" id="sourceline-report-data">([\s\S]*?)<\/script>/)?.[1];
    expect(embeddedJson).toBeDefined();
    const parsed = JSON.parse(embeddedJson ?? "{}") as SourceLineReport;
    expect(parsed.summary).toEqual({
      totalClaims: 2,
      supported: 1,
      partiallySupported: 1,
      unsupported: 0,
      contradicted: 0,
      notEnoughEvidence: 0
    });
  });

  it("normalizes claim data attributes used for search and copy summaries", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: " sample\n\u001b[31mred\u001b[0m ",
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
            text: "Alpha\n\u001b[31mBeta\u001b[0m\u0007 <claim> \"quoted\"",
            claimType: "technical",
            importance: "high",
            searchQueries: ["query\none", "\u001b[34mquery two\u001b[0m"]
          },
          status: "supported",
          confidence: 0.8,
          evidence: [
            {
              source: {
                id: "source-1",
                title: "Evidence\n\u001b[32mTitle\u001b[0m",
                url: "https://example.com/search",
                publisher: "Publisher",
                retrievedAt: "2026-06-07T00:00:00.000Z",
                snippet: "Snippet\twith\u0007 control\nchars",
                retrieval: {
                  score: 0.75,
                  matchedTerms: ["match\nterm", "\u001b[31mred\u001b[0m"],
                  explanation: "retrieval\r\nexplanation\u001b]0;hidden-title\u0007"
                }
              },
              relation: "supports",
              confidence: 0.8,
              explanation: "Support\u0000 explanation"
            }
          ],
          explanation: "Line one\r\nLine two \u001b]0;hidden-title\u0007done\u0000",
          riskFlags: ["requires_expert_review"]
        }
      ]
    };

    const html = renderHtmlReport(report);
    const claimText = getArticleAttribute(html, "data-claim-text");
    const claimExplanation = getArticleAttribute(html, "data-claim-explanation");
    const claimRisks = getArticleAttribute(html, "data-claim-risks");
    const claimSearch = getArticleAttribute(html, "data-claim-search");

    expect(html).toContain("Input: sample red<br>");
    expect(claimText).toBe("Alpha Beta &lt;claim&gt; &quot;quoted&quot;");
    expect(claimExplanation).toBe("Line one Line two done");
    expect(claimRisks).toBe("requires_expert_review");
    expect(claimSearch).toContain("Alpha Beta &lt;claim&gt; &quot;quoted&quot;");
    expect(claimSearch).toContain("query one query two");
    expect(claimSearch).toContain("Evidence Title");
    expect(claimSearch).toContain("Snippet with control chars");
    expect(claimSearch).toContain("retrieval explanation");
    expect(claimSearch).toContain("match term red");
    expect(claimSearch).toContain("Support explanation");
    expect(claimSearch).not.toContain("hidden-title");
    expect(claimSearch).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);

    const embeddedJson = html.match(/<script type="application\/json" id="sourceline-report-data">([\s\S]*?)<\/script>/)?.[1];
    expect(embeddedJson).toBeDefined();
    const parsed = JSON.parse(embeddedJson ?? "{}") as SourceLineReport;
    expect(parsed.input.name).toBe("sample red");
    expect(parsed.checks[0]?.claim.text).toBe("Alpha Beta <claim> \"quoted\"");
    expect(parsed.checks[0]?.explanation).toBe("Line one Line two done");
  });
});

function getArticleAttribute(html: string, name: string): string {
  const article = html.match(/<article\b[^>]*>/)?.[0] ?? "";
  return article.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";
}
