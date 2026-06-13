import { describe, expect, it } from "vitest";
import { renderTerminalReport } from "./terminal.js";
import type { SourceLineReport } from "@sourceline/core";

describe("renderTerminalReport", () => {
  it("keeps input names and review claims on single plain terminal lines", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "sample\n\u001b[31mred\u001b[0m",
        hash: "abc123"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {
        totalClaims: 1,
        supported: 0,
        partiallySupported: 0,
        unsupported: 1,
        contradicted: 0,
        notEnoughEvidence: 0
      },
      checks: [
        {
          claim: {
            id: "claim-1",
            text: "Claim one\n- injected item \u001b[31mred\u001b[0m text",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["claim"]
          },
          status: "unsupported",
          confidence: 0.3,
          evidence: [],
          explanation: "Mock explanation.",
          riskFlags: ["no_source_found"]
        }
      ]
    };

    const terminal = renderTerminalReport(report);
    const lines = terminal.split("\n");

    expect(terminal).toContain("Input: sample red");
    expect(lines.filter((line) => line.includes("injected item"))).toEqual([
      "- [unsupported] Claim one - injected item red text"
    ]);
    expect(terminal).not.toMatch(/\u001b/);
  });

  it("prints summary counts derived from checks", () => {
    const report: SourceLineReport = {
      schemaVersion: "1.0",
      input: {
        kind: "text",
        name: "sample",
        hash: "abc123"
      },
      generatedAt: "2026-06-07T08:00:00.000Z",
      summary: {
        totalClaims: 12,
        supported: 12,
        partiallySupported: 12,
        unsupported: 12,
        contradicted: 12,
        notEnoughEvidence: 12
      },
      checks: [
        {
          claim: {
            id: "claim-1",
            text: "Supported claim",
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
            text: "Contradicted claim",
            claimType: "technical",
            importance: "medium",
            searchQueries: ["contradicted claim"]
          },
          status: "contradicted",
          confidence: 0.4,
          evidence: [],
          explanation: "Mock explanation.",
          riskFlags: []
        }
      ]
    };

    const terminal = renderTerminalReport(report);

    expect(terminal).toContain("Claims: 2 | Supported: 1 | Partial: 0 | Unsupported: 0 | Review: 1");
    expect(terminal).not.toContain("12");
  });
});
