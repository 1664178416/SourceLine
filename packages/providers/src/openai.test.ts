import { describe, expect, it } from "vitest";
import { createOpenAiProvider } from "./openai.js";

describe("createOpenAiProvider", () => {
  it("extracts claims from an OpenAI-compatible JSON response", async () => {
    let requestBody: unknown;
    const provider = createOpenAiProvider({
      apiKey: " test-key ",
      baseUrl: "https://example.test/v1",
      model: " test-model ",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    claims: [
                      {
                        text: "SourceLine exports Markdown reports.",
                        sourceStartLine: 1,
                        sourceEndLine: 1,
                        claimType: "technical",
                        importance: "medium",
                        searchQueries: ["SourceLine Markdown reports"]
                      }
                    ]
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    const result = await provider.extractClaims({
      text: "SourceLine exports Markdown reports.",
      maxClaims: 5,
      segments: [
        {
          id: "segment-1",
          text: "SourceLine exports Markdown reports.",
          startLine: 1,
          endLine: 1
        }
      ]
    });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.text).toBe("SourceLine exports Markdown reports.");
    expect(result.claims[0]?.searchQueries).toEqual(["SourceLine Markdown reports"]);
    expect(requestBody).toMatchObject({ model: "test-model" });
  });

  it("retries once when the first JSON response does not match the schema", async () => {
    let calls = 0;
    const provider = createOpenAiProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      fetchImpl: async () => {
        calls += 1;
        const content =
          calls === 1
            ? JSON.stringify({ claims: [{ text: "   ", searchQueries: ["   "] }] })
            : JSON.stringify({
                claims: [
                  {
                    text: "SourceLine checks claims.",
                    claimType: "technical",
                    importance: "medium",
                    searchQueries: ["SourceLine checks claims"]
                  }
                ]
              });

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    const result = await provider.extractClaims({
      text: "SourceLine checks claims.",
      maxClaims: 5,
      segments: [
        {
          id: "segment-1",
          text: "SourceLine checks claims.",
          startLine: 1,
          endLine: 1
        }
      ]
    });

    expect(calls).toBe(2);
    expect(result.claims[0]?.text).toBe("SourceLine checks claims.");
  });

  it("normalizes extracted claim text and search queries", async () => {
    const provider = createOpenAiProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    claims: [
                      {
                        text: " \u001b[31mSourceLine\u001b[0m   checks\u0007   claims. ",
                        claimType: "technical",
                        importance: "medium",
                        searchQueries: [" \u001b[32mSourceLine\u001b[0m   checks ", " \n\t ", " claims "]
                      },
                      {
                        text: " \u001b[33mSourceLine falls back to claim text.\u001b[0m ",
                        claimType: "technical",
                        importance: "medium",
                        searchQueries: ["   "]
                      }
                    ]
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    });

    const result = await provider.extractClaims({
      text: "SourceLine checks claims. SourceLine falls back to claim text.",
      maxClaims: 5,
      segments: [
        {
          id: "segment-1",
          text: "SourceLine checks claims. SourceLine falls back to claim text.",
          startLine: 1,
          endLine: 1
        }
      ]
    });

    expect(result.claims[0]?.text).toBe("SourceLine checks claims.");
    expect(result.claims[0]?.searchQueries).toEqual(["SourceLine checks", "claims"]);
    expect(result.claims[1]?.text).toBe("SourceLine falls back to claim text.");
    expect(result.claims[1]?.searchQueries).toEqual(["SourceLine falls back to claim text."]);
  });

  it("parses the first JSON object that matches the requested schema", async () => {
    const provider = createOpenAiProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    'Example only: {"example":true}\nActual JSON:\n{"claims":[{"text":"SourceLine keeps braces like {demo} in claim text.","claimType":"technical","importance":"medium","searchQueries":["SourceLine braces"]}]}'
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    });

    const result = await provider.extractClaims({
      text: "SourceLine keeps braces like {demo} in claim text.",
      maxClaims: 5,
      segments: [
        {
          id: "segment-1",
          text: "SourceLine keeps braces like {demo} in claim text.",
          startLine: 1,
          endLine: 1
        }
      ]
    });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.text).toBe("SourceLine keeps braces like {demo} in claim text.");
  });

  it("normalizes and deduplicates OpenAI-compatible evidence decisions", async () => {
    let requestBody: { messages?: Array<{ role: string; content: string }> } | undefined;
    const provider = createOpenAiProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> };
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    status: "supported",
                    confidence: 0.876,
                    evidence: [
                      {
                        sourceId: " source-1 ",
                        relation: "supports",
                        confidence: 0.876,
                        quotedSupport: " \u001b[31mSourceLine\u001b[0m supported. ",
                        explanation: " \u001b[32mSourceLine\u001b[0m   is supported. "
                      },
                      {
                        sourceId: "source-1",
                        relation: "related",
                        confidence: 0.1,
                        explanation: "Duplicate source should be ignored."
                      },
                      {
                        sourceId: "missing-source",
                        relation: "supports",
                        confidence: 0.8,
                        explanation: "Unknown source should be ignored."
                      }
                    ],
                    explanation: " \u001b[34mOverall   support.\u001b[0m ",
                    riskFlags: []
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    const claim = {
      id: "claim-1",
      text: " \u001b[31mSourceLine\u001b[0m verifies\n evidence decisions. ",
      claimType: "technical" as const,
      importance: "medium" as const,
      searchQueries: ["SourceLine evidence"]
    };
    const result = await provider.verifyClaim({
      claim,
      minConfidence: 0.65,
      evidence: [
        {
          id: "source-1",
          title: "Source\n\u001b[31mone\u001b[0m\u001b]0;hidden-title\u0007",
          url: "https://example.test/source-1",
          retrievedAt: "2026-06-07T00:00:00.000Z",
          snippet: "SourceLine\u0007 verifies\n\u001b[32mevidence\u001b[0m decisions.",
          provider: "test-search",
          rank: 1,
          query: "SourceLine evidence"
        }
      ]
    });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.source.id).toBe("source-1");
    expect(result.evidence[0]?.relation).toBe("supports");
    expect(result.evidence[0]?.confidence).toBe(0.88);
    expect(result.evidence[0]?.quotedSupport).toBe("SourceLine supported.");
    expect(result.evidence[0]?.explanation).toBe("SourceLine is supported.");
    expect(result.explanation).toBe("Overall support.");
    const userMessage = requestBody?.messages?.find((message) => message.role === "user")?.content ?? "";
    expect(userMessage).toContain("Claim:\nSourceLine verifies evidence decisions.");
    expect(userMessage).toContain("Title: Source one");
    expect(userMessage).toContain("Snippet: SourceLine verifies evidence decisions.");
    expect(userMessage).not.toContain("\u001b");
    expect(userMessage).not.toContain("\u0007");
    expect(userMessage).not.toContain("hidden-title");
  });

  it("wraps network failures and redacts OpenAI-compatible secrets", async () => {
    const provider = createOpenAiProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      fetchImpl: async () => {
        throw new Error("socket disconnected for sk-secret-token");
      }
    });

    await expect(
      provider.extractClaims({
        text: "SourceLine checks claims.",
        maxClaims: 5,
        segments: [
          {
            id: "segment-1",
            text: "SourceLine checks claims.",
            startLine: 1,
            endLine: 1
          }
        ]
      })
    ).rejects.toThrow("OpenAI-compatible provider request failed: socket disconnected for sk-***");
  });

  it("redacts and truncates OpenAI-compatible error response bodies", async () => {
    const provider = createOpenAiProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      fetchImpl: async () => new Response(`prefix sk-secret-token ${"x".repeat(4096)} hidden-tail`, { status: 401 })
    });

    await expect(
      provider.extractClaims({
        text: "SourceLine checks claims.",
        maxClaims: 5,
        segments: [
          {
            id: "segment-1",
            text: "SourceLine checks claims.",
            startLine: 1,
            endLine: 1
          }
        ]
      })
    ).rejects.toThrow("OpenAI-compatible provider returned 401: prefix sk-***");

    await expect(
      provider.extractClaims({
        text: "SourceLine checks claims.",
        maxClaims: 5,
        segments: [
          {
            id: "segment-1",
            text: "SourceLine checks claims.",
            startLine: 1,
            endLine: 1
          }
        ]
      })
    ).rejects.toThrow("[truncated after 4096 bytes]");
  });

  it("rejects invalid OpenAI-compatible base URLs", () => {
    expect(() =>
      createOpenAiProvider({
        apiKey: "test-key",
        baseUrl: "file:///tmp/openai",
        model: "test-model"
      })
    ).toThrow("OpenAI baseUrl must be a valid http(s) URL.");
  });

  it("wraps invalid OpenAI-compatible JSON response bodies", async () => {
    const provider = createOpenAiProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      fetchImpl: async () => new Response("not-json", { status: 200 })
    });

    await expect(
      provider.extractClaims({
        text: "SourceLine checks claims.",
        maxClaims: 5,
        segments: [
          {
            id: "segment-1",
            text: "SourceLine checks claims.",
            startLine: 1,
            endLine: 1
          }
        ]
      })
    ).rejects.toThrow("OpenAI-compatible provider returned invalid JSON:");
  });

  it("rejects blank OpenAI-compatible API keys and models", () => {
    expect(() =>
      createOpenAiProvider({
        apiKey: "   ",
        baseUrl: "https://example.test/v1",
        model: "test-model"
      })
    ).toThrow("OPENAI_API_KEY is required for --provider openai.");

    expect(() =>
      createOpenAiProvider({
        apiKey: "test-key",
        baseUrl: "https://example.test/v1",
        model: "   "
      })
    ).toThrow("OpenAI model must not be empty.");
  });
});
