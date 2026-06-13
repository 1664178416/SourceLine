import { describe, expect, it } from "vitest";
import { dedupeClaims, dedupeSearchResults, normalizeClaimText } from "./normalize.js";
import type { Claim } from "./types.js";

const baseClaim: Omit<Claim, "id" | "text"> = {
  claimType: "technical",
  importance: "medium",
  searchQueries: []
};

describe("normalizeClaimText", () => {
  it("normalizes markdown punctuation, smart quotes, and wrapping quotes", () => {
    expect(normalizeClaimText('> \u201cSourceLine\u2014checks *claims*.\u201d')).toBe("SourceLine checks claims.");
    expect(normalizeClaimText('  "SourceLine checks claims."  ')).toBe("SourceLine checks claims.");
    expect(normalizeClaimText('  \u001b[31mSourceLine\u001b[0m\nchecks\u0007 *claims*.  ')).toBe("SourceLine checks claims.");
  });
});

describe("dedupeClaims", () => {
  it("deduplicates claims that only differ by casing, quotes, and terminal punctuation", () => {
    const claims = dedupeClaims([
      {
        ...baseClaim,
        id: "claim-1",
        text: "SourceLine checks claims."
      },
      {
        ...baseClaim,
        id: "claim-2",
        text: "\"sourceline checks claims\""
      },
      {
        ...baseClaim,
        id: "claim-3",
        text: "SourceLine checks reports."
      }
    ]);

    expect(claims.map((claim) => claim.id)).toEqual(["claim-1", "claim-3"]);
    expect(claims.map((claim) => claim.text)).toEqual(["SourceLine checks claims.", "SourceLine checks reports."]);
  });

  it("deduplicates claims that only differ by ANSI styling", () => {
    const claims = dedupeClaims([
      {
        ...baseClaim,
        id: "claim-1",
        text: "SourceLine checks claims."
      },
      {
        ...baseClaim,
        id: "claim-2",
        text: "\u001b[31mSourceLine checks claims.\u001b[0m"
      }
    ]);

    expect(claims.map((claim) => claim.id)).toEqual(["claim-1"]);
    expect(claims[0]?.text).toBe("SourceLine checks claims.");
  });
});

describe("dedupeSearchResults", () => {
  it("deduplicates equivalent URLs and paths while preserving distinct query strings", () => {
    const results = dedupeSearchResults([
      { id: "url-1", url: "https://Example.com:443/path/#fragment" },
      { id: "url-2", url: "https://example.com/path" },
      { id: "url-3", url: "https://example.com/path?q=1" },
      { id: "path-1", path: ".\\Docs\\Evidence.md" },
      { id: "path-2", path: "docs/evidence.md/" }
    ]);

    expect(results.map((result) => result.id)).toEqual(["url-1", "url-3", "path-1"]);
  });

  it("falls back to ids for blank result locations", () => {
    const results = dedupeSearchResults([
      { id: "blank-url-1", url: "   " },
      { id: "blank-url-2", url: "" },
      { id: "blank-path-1", path: "   " },
      { id: "blank-path-2", path: "" },
      { id: "trimmed-url-1", url: " https://example.com/evidence/#section " },
      { id: "trimmed-url-2", url: "https://example.com/evidence" },
      { id: "trimmed-path-1", path: " ./Docs/Evidence.md/ " },
      { id: "trimmed-path-2", path: "docs/evidence.md" }
    ]);

    expect(results.map((result) => result.id)).toEqual([
      "blank-url-1",
      "blank-url-2",
      "blank-path-1",
      "blank-path-2",
      "trimmed-url-1",
      "trimmed-path-1"
    ]);
  });
});
