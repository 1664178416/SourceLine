import { describe, expect, it } from "vitest";
import { createTavilySearchProvider } from "./tavily.js";

describe("createTavilySearchProvider", () => {
  it("maps Tavily search results to SearchResult objects", async () => {
    const provider = createTavilySearchProvider({
      apiKey: "tvly-test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "SourceLine",
                url: "https://example.com/sourceline",
                content: "SourceLine turns claims into evidence reports.",
                score: 0.9,
                raw_content: null
              }
            ]
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
    expect(results[0]?.id).toBe("tavily-claim-1-1");
    expect(results[0]?.provider).toBe("tavily");
    expect(results[0]?.url).toBe("https://example.com/sourceline");
    expect(results[0]?.snippet).toContain("evidence reports");
    expect(results[0]?.retrieval?.score).toBe(0.9);
  });

  it("normalizes claim ids used in Tavily result ids", async () => {
    const provider = createTavilySearchProvider({
      apiKey: "tvly-test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "SourceLine",
                url: "https://example.com/sourceline",
                content: "SourceLine turns claims into evidence reports."
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    });

    const results = await provider.search({
      claimId: " claim\n\u001b[31mone\u001b[0m ",
      query: "SourceLine evidence reports",
      maxResults: 3
    });

    expect(results[0]?.id).toBe("tavily-claim-one-1");
    expect(results[0]?.id).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it("normalizes Tavily search requests and skips empty requests", async () => {
    const requestBodies: unknown[] = [];
    const provider = createTavilySearchProvider({
      apiKey: "tvly-test",
      fetchImpl: async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "SourceLine",
                url: "https://example.com/sourceline",
                content: "SourceLine turns claims into evidence reports."
              }
            ]
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
      maxResults: 2
    });

    expect(requestBodies).toEqual([
      expect.objectContaining({
        query: "SourceLine evidence reports",
        max_results: 2
      })
    ]);
    expect(results[0]?.query).toBe("SourceLine evidence reports");
  });

  it("passes validated Tavily request options", async () => {
    const requestBodies: unknown[] = [];
    const provider = createTavilySearchProvider({
      apiKey: "tvly-test",
      searchDepth: "advanced",
      includeRawContent: "markdown",
      fetchImpl: async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    await provider.search({
      claimId: "claim-1",
      query: "SourceLine evidence reports",
      maxResults: 3
    });

    expect(requestBodies).toEqual([
      expect.objectContaining({
        search_depth: "advanced",
        include_raw_content: "markdown"
      })
    ]);
  });

  it("rejects unsafe Tavily request options before requests are sent", () => {
    expect(() =>
      createTavilySearchProvider({
        apiKey: "tvly-test",
        searchDepth: "slow" as never
      })
    ).toThrow("Tavily searchDepth must be one of: basic, advanced, fast, ultra-fast.");
    expect(() =>
      createTavilySearchProvider({
        apiKey: "tvly-test",
        includeRawContent: "html" as never
      })
    ).toThrow("Tavily includeRawContent must be a boolean, markdown, or text.");
  });

  it("caps long Tavily search queries before sending requests", async () => {
    const requestBodies: unknown[] = [];
    const provider = createTavilySearchProvider({
      apiKey: "tvly-test",
      fetchImpl: async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    await provider.search({
      claimId: "claim-1",
      query: "x".repeat(700),
      maxResults: 3
    });

    expect(requestBodies).toEqual([
      expect.objectContaining({
        query: "x".repeat(500)
      })
    ]);
  });

  it("caps direct Tavily result counts before requesting and returning results", async () => {
    const requestBodies: unknown[] = [];
    const provider = createTavilySearchProvider({
      apiKey: "tvly-test",
      fetchImpl: async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            results: Array.from({ length: 25 }, (_, index) => ({
              title: `Source ${index}`,
              url: `https://example.com/source-${index}`,
              content: `SourceLine evidence ${index}.`
            }))
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    const results = await provider.search({
      claimId: "claim-1",
      query: "SourceLine evidence reports",
      maxResults: 25
    });

    expect(requestBodies).toEqual([expect.objectContaining({ max_results: 20 })]);
    expect(results).toHaveLength(20);
    expect(results[0]?.id).toBe("tavily-claim-1-1");
    expect(results.at(-1)?.id).toBe("tavily-claim-1-20");
  });

  it("filters unusable result URLs and normalizes result fields", async () => {
    const provider = createTavilySearchProvider({
      apiKey: "tvly-test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "No URL",
                content: "Missing URL.",
                score: 0.9
              },
              {
                title: "Unsafe URL",
                url: "javascript:alert(1)",
                content: "Unsafe URL.",
                score: 0.8
              },
              {
                title: "Credential URL",
                url: "https://user:secret@example.com/private",
                content: "Credential URL.",
                score: 0.75
              },
              {
                title: "Control URL",
                url: "https://example.com/bad\npath",
                content: "Control character URL.",
                score: 0.7
              },
              {
                title: "Spaced URL",
                url: "https://example.com/safe path",
                content: "Whitespace URL.",
                score: 0.65
              },
              {
                title: "Angle URL",
                url: "https://example.com/<unsafe>",
                content: "Angle bracket URL.",
                score: 0.62
              },
              {
                title: "Empty evidence",
                url: "https://example.com/empty",
                content: "   ",
                raw_content: "\n\t",
                score: 0.6
              },
              {
                title: "  Valid \u001b[31mSource\u001b[0m\nTitle  ",
                url: " https://example.com/valid#section ",
                content: "  SourceLine\n\u001b[32mchecks\u001b[0m claims.  ",
                raw_content: "  Raw\n\u001b[33mcontent\u001b[0m stays multiline.  ",
                score: Number.POSITIVE_INFINITY
              }
            ]
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
    expect(results[0]?.url).toBe("https://example.com/valid#section");
    expect(results[0]?.snippet).toBe("SourceLine checks claims.");
    expect(results[0]?.text).toBe("Raw\ncontent stays multiline.");
    expect(results[0]?.retrieval).toBeUndefined();
  });

  it("caps long Tavily result fields before returning search results", async () => {
    const provider = createTavilySearchProvider({
      apiKey: "tvly-test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "t".repeat(2_100),
                url: "https://example.com/long",
                content: "s".repeat(2_100),
                raw_content: "r".repeat(20_100),
                score: 0.8
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    });

    const results = await provider.search({
      claimId: "claim-1",
      query: "SourceLine evidence reports",
      maxResults: 3
    });

    expect(results[0]?.title).toHaveLength(2_000);
    expect(results[0]?.title).toMatch(/\.\.\. \[truncated\]$/);
    expect(results[0]?.snippet).toHaveLength(2_000);
    expect(results[0]?.snippet).toMatch(/\.\.\. \[truncated\]$/);
    expect(results[0]?.text).toHaveLength(20_000);
    expect(results[0]?.text).toMatch(/\.\.\. \[truncated\]$/);
  });

  it("wraps network failures and redacts Tavily secrets", async () => {
    const provider = createTavilySearchProvider({
      apiKey: "tvly-test",
      fetchImpl: async () => {
        throw new Error("socket disconnected for Bearer custom.secret-token and tvly-secret-token");
      }
    });

    await expect(
      provider.search({
        claimId: "claim-1",
        query: "SourceLine evidence reports",
        maxResults: 3
      })
    ).rejects.toThrow("Tavily search request failed: socket disconnected for Bearer *** and tvly-***");
  });

  it("redacts and truncates Tavily error response bodies", async () => {
    const provider = createTavilySearchProvider({
      apiKey: "tvly-test",
      fetchImpl: async () => new Response(`prefix tvly-secret-token ${"x".repeat(4096)} hidden-tail`, { status: 429 })
    });

    await expect(
      provider.search({
        claimId: "claim-1",
        query: "SourceLine evidence reports",
        maxResults: 3
      })
    ).rejects.toThrow("Tavily search returned 429: prefix tvly-***");

    await expect(
      provider.search({
        claimId: "claim-1",
        query: "SourceLine evidence reports",
        maxResults: 3
      })
    ).rejects.toThrow("[truncated after 4096 bytes]");
  });

  it("rejects invalid Tavily base URLs", () => {
    expect(() =>
      createTavilySearchProvider({
        apiKey: "tvly-test",
        baseUrl: "notaurl"
      })
    ).toThrow("Tavily baseUrl must be a valid http(s) URL.");
  });

  it("rejects oversized Tavily provider timeouts", () => {
    expect(() =>
      createTavilySearchProvider({
        apiKey: "tvly-test",
        timeoutMs: 300_001
      })
    ).toThrow("timeoutMs must be at most 300000.");
  });

  it("wraps Tavily response shape errors", async () => {
    const provider = createTavilySearchProvider({
      apiKey: "tvly-test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ results: "not-an-array" }), {
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
    ).rejects.toThrow("Tavily search returned an unexpected response shape: results: Invalid input: expected array, received string");
  });

  it("rejects blank Tavily API keys", () => {
    expect(() =>
      createTavilySearchProvider({
        apiKey: "   "
      })
    ).toThrow("TAVILY_API_KEY is required for --search tavily.");
  });
});
