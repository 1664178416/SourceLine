import { describe, expect, it } from "vitest";
import { createBraveSearchProvider } from "./brave.js";

describe("createBraveSearchProvider", () => {
  it("maps Brave web search results to SearchResult objects", async () => {
    const provider = createBraveSearchProvider({
      apiKey: "brave-test-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "SourceLine",
                  url: "https://example.com/sourceline",
                  description: "SourceLine checks claims.",
                  extra_snippets: ["It produces evidence reports."]
                }
              ]
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    const results = await provider.search({
      claimId: "claim-1",
      query: "SourceLine evidence reports",
      maxResults: 3
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.provider).toBe("brave");
    expect(results[0]?.snippet).toContain("evidence reports");
  });

  it("normalizes Brave search requests and skips empty requests", async () => {
    const requestUrls: string[] = [];
    const provider = createBraveSearchProvider({
      apiKey: "brave-test-token",
      fetchImpl: async (input) => {
        requestUrls.push(String(input));
        return new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "SourceLine",
                  url: "https://example.com/sourceline",
                  description: "SourceLine checks claims."
                }
              ]
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    await expect(
      provider.search({
        claimId: "claim-1",
        query: " \n\t ",
        maxResults: 3
      })
    ).resolves.toEqual([]);
    await expect(
      provider.search({
        claimId: "claim-1",
        query: "SourceLine evidence",
        maxResults: 0
      })
    ).resolves.toEqual([]);

    const results = await provider.search({
      claimId: "claim-1",
      query: " \u001b[31mSourceLine\u001b[0m   evidence\nreports ",
      maxResults: 25
    });
    const requestUrl = new URL(requestUrls[0]!);

    expect(requestUrls).toHaveLength(1);
    expect(requestUrl.searchParams.get("q")).toBe("SourceLine evidence reports");
    expect(requestUrl.searchParams.get("count")).toBe("20");
    expect(results[0]?.query).toBe("SourceLine evidence reports");
  });

  it("filters unusable result URLs and normalizes result fields", async () => {
    const provider = createBraveSearchProvider({
      apiKey: "brave-test-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "No URL",
                  description: "Missing URL."
                },
                {
                  title: "Unsafe URL",
                  url: "javascript:alert(1)",
                  description: "Unsafe URL."
                },
                {
                  title: "Control URL",
                  url: "https://example.com/bad\npath",
                  description: "Control character URL."
                },
                {
                  title: "Empty evidence",
                  url: "https://example.com/empty",
                  description: "   ",
                  extra_snippets: ["\n\t", null]
                },
                {
                  title: "  Valid \u001b[31mSource\u001b[0m\nTitle  ",
                  url: " https://example.com/valid?x=1 ",
                  description: "  SourceLine\n\u001b[32mchecks\u001b[0m claims.  ",
                  extra_snippets: ["  It\t\u001b[33mproduces\u001b[0m evidence.  ", ""],
                  age: "  \u001b[34m2026-06-07\u001b[0m  "
                }
              ]
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      now: () => new Date("2026-06-07T08:00:00.000Z")
    });

    const results = await provider.search({
      claimId: "claim-1",
      query: "SourceLine evidence reports",
      maxResults: 4
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Valid Source Title");
    expect(results[0]?.url).toBe("https://example.com/valid?x=1");
    expect(results[0]?.snippet).toBe("SourceLine checks claims. It produces evidence.");
    expect(results[0]?.text).toBe("SourceLine checks claims. It produces evidence.");
    expect(results[0]?.publishedAt).toBe("2026-06-07");
  });

  it("wraps network failures and redacts Brave secrets", async () => {
    const provider = createBraveSearchProvider({
      apiKey: "brave-test-token",
      fetchImpl: async () => {
        throw new Error("socket disconnected for abcdefghijklmnopqrstuvwxyz");
      }
    });

    await expect(
      provider.search({
        claimId: "claim-1",
        query: "SourceLine evidence reports",
        maxResults: 3
      })
    ).rejects.toThrow("Brave search request failed: socket disconnected for ***");
  });

  it("redacts and truncates Brave error response bodies", async () => {
    const provider = createBraveSearchProvider({
      apiKey: "brave-test-token",
      fetchImpl: async () => new Response(`prefix abcdefghijklmnopqrstuvwxyz ${"x".repeat(4096)} hidden-tail`, { status: 403 })
    });

    await expect(
      provider.search({
        claimId: "claim-1",
        query: "SourceLine evidence reports",
        maxResults: 3
      })
    ).rejects.toThrow("Brave search returned 403: prefix ***");

    await expect(
      provider.search({
        claimId: "claim-1",
        query: "SourceLine evidence reports",
        maxResults: 3
      })
    ).rejects.toThrow("[truncated after 4096 bytes]");
  });

  it("rejects invalid Brave base URLs", () => {
    expect(() =>
      createBraveSearchProvider({
        apiKey: "brave-test-token",
        baseUrl: "https://example.com/bad\npath"
      })
    ).toThrow("Brave baseUrl must be a valid http(s) URL.");
  });

  it("wraps Brave response shape errors", async () => {
    const provider = createBraveSearchProvider({
      apiKey: "brave-test-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ web: { results: "not-an-array" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    });

    await expect(
      provider.search({
        claimId: "claim-1",
        query: "SourceLine evidence reports",
        maxResults: 3
      })
    ).rejects.toThrow("Brave search returned an unexpected response shape: web.results: Invalid input: expected array, received string");
  });

  it("rejects blank Brave API keys", () => {
    expect(() =>
      createBraveSearchProvider({
        apiKey: "   "
      })
    ).toThrow("BRAVE_SEARCH_API_KEY is required for --search brave.");
  });
});
