import { describe, expect, it } from "vitest";
import { createMockLlmProvider } from "./mock.js";

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
