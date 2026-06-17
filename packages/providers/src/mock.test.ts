import { describe, expect, it } from "vitest";
import { createMockLlmProvider, createMockSearchProvider } from "./mock.js";

describe("createMockLlmProvider", () => {
  it("extracts common demo claims with present-tense verbs", async () => {
    const provider = createMockLlmProvider();
    const result = await provider.extractClaims({
      text: "SourceLine turns AI answers into evidence reports.\n\nAI-generated answers often contain factual claims.",
      segments: [
        {
          id: "segment-1",
          text: "SourceLine turns AI answers into evidence reports.",
          startLine: 1,
          endLine: 1
        },
        {
          id: "segment-2",
          text: "AI-generated answers often contain factual claims.",
          startLine: 3,
          endLine: 3
        }
      ],
      maxClaims: 10
    });

    expect(result.claims.map((claim) => claim.text)).toEqual([
      "SourceLine turns AI answers into evidence reports.",
      "AI-generated answers often contain factual claims."
    ]);
  });
});

describe("createMockSearchProvider", () => {
  it("normalizes, caps, and skips direct mock search queries", async () => {
    const provider = createMockSearchProvider({
      now: () => new Date("2026-06-07T00:00:00.000Z")
    });

    await expect(
      provider.search({
        claimId: "claim-1",
        query: " \n\t ",
        maxResults: 2
      })
    ).resolves.toEqual([]);
    await expect(
      provider.search({
        claimId: "claim-1",
        query: "SourceLine evidence",
        maxResults: 1.5
      })
    ).resolves.toEqual([]);

    const results = await provider.search({
      claimId: "claim-1",
      query: `\u001b[31m${"x".repeat(700)}\u001b[0m`,
      maxResults: 2
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.query).toBe("x".repeat(500));
    expect(results[0]?.snippet).toContain(`"${"x".repeat(500)}"`);
  });
});
