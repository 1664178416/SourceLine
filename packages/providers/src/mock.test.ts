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
  it.each([
    ["\u5317\u4eac\u4eba\u53e3", "\u4e0a\u6d77\u4eba\u53e3"],
    [`${"shared query ".repeat(10)}first`, `${"shared query ".repeat(10)}second`],
    ["a+b evidence", "a-b evidence"]
  ])("keeps distinct query results separate and deterministic: %s / %s", async (firstQuery, secondQuery) => {
    const provider = createMockSearchProvider({ now: () => new Date("2026-06-07T00:00:00.000Z") });
    const firstRequest = { claimId: "claim-1", query: firstQuery, maxResults: 2 };
    const first = await provider.search(firstRequest);
    const second = await provider.search({ ...firstRequest, query: secondQuery });
    const results = [...first, ...second];

    expect(new Set(results.map((result) => result.id)).size).toBe(4);
    expect(new Set(results.map((result) => result.url)).size).toBe(4);
    await expect(provider.search(firstRequest)).resolves.toEqual(first);
  });

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
