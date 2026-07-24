import { describe, expect, it } from "vitest";
import { joinSnippetParts, normalizeHttpUrl, normalizeIdentifierPart, normalizeOptionalText, normalizeSearchRequest } from "./search-utils.js";

describe("search-utils", () => {
  it("drops unsafe or overlong HTTP URLs", () => {
    expect(normalizeHttpUrl(" https://example.com/source ")).toBe("https://example.com/source");
    expect(normalizeHttpUrl("https://user:secret@example.com/private")).toBeUndefined();
    expect(normalizeHttpUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeHttpUrl("https://example.com/safe path")).toBeUndefined();
    expect(normalizeHttpUrl("https://example.com/<unsafe>")).toBeUndefined();
    expect(normalizeHttpUrl(`https://example.com/${"a".repeat(2_000)}`)).toBeUndefined();
  });

  it("normalizes and caps optional text fields", () => {
    const normalized = normalizeOptionalText(`  \u001b[31m${"x".repeat(2_100)}\u001b[0m  `, {
      collapseWhitespace: true,
      maxLength: 2_000
    });

    expect(normalized).toHaveLength(2_000);
    expect(normalized).toMatch(/\.\.\. \[truncated\]$/);
    expect(normalized).not.toContain("\u001b");
  });

  it("caps joined snippets after dropping blank parts", () => {
    const snippet = joinSnippetParts([" SourceLine evidence. ", "\n\t", "x".repeat(2_100)]);

    expect(snippet).toHaveLength(2_000);
    expect(snippet).toMatch(/\.\.\. \[truncated\]$/);
    expect(snippet).toContain("SourceLine evidence.");
  });

  it("normalizes direct search requests and caps result counts", () => {
    expect(normalizeSearchRequest(" \u001b[31mSourceLine\u001b[0m\n evidence ", 25)).toEqual({
      query: "SourceLine evidence",
      maxResults: 20
    });
    expect(normalizeSearchRequest(" \n\t ", 5)).toBeUndefined();
    expect(normalizeSearchRequest("SourceLine evidence", 0)).toBeUndefined();
    expect(normalizeSearchRequest("SourceLine evidence", 1.5)).toBeUndefined();
  });

  it("normalizes identifier parts used in provider result ids", () => {
    expect(normalizeIdentifierPart(" Claim\n\u001b[31mOne\u001b[0m ", "claim")).toBe("claim-one");
    expect(normalizeIdentifierPart(" Claim/One?<script> ", "claim")).toBe("claim-one-script");
    expect(normalizeIdentifierPart("\u8bc1\u636e", "claim")).toMatch(/^claim-[a-z0-9]+$/);
    expect(normalizeIdentifierPart(" \n\t ", "claim")).toBe("claim");
    expect(normalizeIdentifierPart(`${"x".repeat(199)} `, "claim")).toBe("x".repeat(199));
    expect(normalizeIdentifierPart(`${"x".repeat(250)} `, "claim")).toBe("x".repeat(200));
    expect(normalizeIdentifierPart(`${"x".repeat(199)}-tail`, "claim")).toBe(`${"x".repeat(199)}`);
  });
});
