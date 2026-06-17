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

  it("bounds validation errors in OpenAI-compatible retry prompts and final errors", async () => {
    let calls = 0;
    let retryMessage = "";
    const invalidClaims = Array.from({ length: 80 }, (_, index) => ({
      text: "   ",
      sourceStartLine: index === 79 ? "hidden-tail" : undefined,
      claimType: "invalid-type",
      importance: "invalid-importance",
      searchQueries: [123]
    }));
    const provider = createOpenAiProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      fetchImpl: async (_input, init) => {
        calls += 1;
        const requestBody = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> };
        if (calls === 2) {
          retryMessage = requestBody.messages?.filter((message) => message.role === "user").at(-1)?.content ?? "";
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ claims: invalidClaims })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    let thrown: unknown;
    try {
      await provider.extractClaims({
        text: "SourceLine bounds OpenAI-compatible validation errors.",
        maxClaims: 5,
        segments: [
          {
            id: "segment-1",
            text: "SourceLine bounds OpenAI-compatible validation errors.",
            startLine: 1,
            endLine: 1
          }
        ]
      });
    } catch (error) {
      thrown = error;
    }

    const finalMessage = thrown instanceof Error ? thrown.message : String(thrown);
    expect(calls).toBe(2);
    expect(retryMessage).toContain("Validation error:");
    expect(retryMessage).toContain("[truncated]");
    expect(retryMessage).not.toContain("claims.79");
    expect(retryMessage).not.toContain("hidden-tail");
    expect(retryMessage.length).toBeLessThanOrEqual(2_200);
    expect(finalMessage).toContain("OpenAI-compatible provider returned invalid JSON for extract claims:");
    expect(finalMessage).toContain("[truncated]");
    expect(finalMessage).not.toContain("claims.79");
    expect(finalMessage).not.toContain("hidden-tail");
    expect(finalMessage.length).toBeLessThanOrEqual(2_200);
  });

  it("bounds fallback JSON object candidates before retrying", async () => {
    let calls = 0;
    const provider = createOpenAiProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      fetchImpl: async () => {
        calls += 1;
        const content =
          calls === 1
            ? `${Array.from({ length: 25 }, () => "{}").join("\n")}\n${JSON.stringify({
                claims: [
                  {
                    text: "This valid object appears after too many invalid candidates.",
                    claimType: "technical",
                    importance: "medium",
                    searchQueries: ["valid object"]
                  }
                ]
              })}`
            : JSON.stringify({
                claims: [
                  {
                    text: "SourceLine retries after noisy JSON candidates.",
                    claimType: "technical",
                    importance: "medium",
                    searchQueries: ["noisy JSON candidates"]
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
      text: "SourceLine retries after noisy JSON candidates.",
      maxClaims: 5,
      segments: [
        {
          id: "segment-1",
          text: "SourceLine retries after noisy JSON candidates.",
          startLine: 1,
          endLine: 1
        }
      ]
    });

    expect(calls).toBe(2);
    expect(result.claims[0]?.text).toBe("SourceLine retries after noisy JSON candidates.");
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

  it("caps extracted search query count and length", async () => {
    const longQuery = "x".repeat(700);
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
                        text: "SourceLine caps search queries.",
                        claimType: "technical",
                        importance: "medium",
                        searchQueries: [longQuery, "query 1", "query 2", "query 3", "query 4", "query 5"]
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
      text: "SourceLine caps search queries.",
      maxClaims: 5,
      segments: [
        {
          id: "segment-1",
          text: "SourceLine caps search queries.",
          startLine: 1,
          endLine: 1
        }
      ]
    });

    expect(result.claims[0]?.searchQueries).toEqual(["x".repeat(500), "query 1", "query 2", "query 3", "query 4"]);
  });

  it("caps extracted claim count and long claim fields before returning results", async () => {
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
                    claims: Array.from({ length: 105 }, (_, index) => ({
                      text: index === 0 ? "x".repeat(2_100) : `Claim ${index + 1}.`,
                      quote: index === 0 ? "q".repeat(4_100) : undefined,
                      claimType: "technical",
                      importance: "medium",
                      searchQueries: ["SourceLine bounded claims"]
                    }))
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    });

    const result = await provider.extractClaims({
      text: "SourceLine bounds OpenAI-compatible claim output.",
      maxClaims: 105,
      segments: [
        {
          id: "segment-1",
          text: "SourceLine bounds OpenAI-compatible claim output.",
          startLine: 1,
          endLine: 1
        }
      ]
    });

    expect(result.claims).toHaveLength(100);
    expect(result.claims[0]?.text).toHaveLength(2_000);
    expect(result.claims[0]?.text).toMatch(/\.\.\. \[truncated\]$/);
    expect(result.claims[0]?.sourceSpan?.quote).toHaveLength(4_000);
    expect(result.claims[0]?.sourceSpan?.quote).toMatch(/\.\.\. \[truncated\]$/);
    expect(result.claims.at(-1)?.text).toBe("Claim 100.");
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

  it("normalizes evidence source ids in OpenAI-compatible verification prompts", async () => {
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
                    confidence: 0.8,
                    evidence: [
                      {
                        sourceId: "source-one-script",
                        relation: "supports",
                        confidence: 0.8,
                        explanation: "Safe source id matched."
                      }
                    ],
                    explanation: "Safe source id was used.",
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

    const result = await provider.verifyClaim({
      claim: {
        id: "claim-1",
        text: "SourceLine normalizes evidence source ids.",
        claimType: "technical",
        importance: "medium",
        searchQueries: ["safe source ids"]
      },
      minConfidence: 0.65,
      evidence: [
        {
          id: " Source/One?<script>\u001b[31m \u001b[0m ",
          title: "Unsafe source id",
          url: "https://example.test/source",
          retrievedAt: "2026-06-07T00:00:00.000Z",
          snippet: "SourceLine normalizes evidence source ids.",
          provider: "test-search",
          rank: 1,
          query: "safe source ids"
        }
      ]
    });

    const userMessage = requestBody?.messages?.find((message) => message.role === "user")?.content ?? "";
    expect(userMessage).toContain("Source ID: source-one-script");
    expect(userMessage).not.toContain("Source/One?<script>");
    expect(result.evidence[0]?.source.id).toBe("source-one-script");
  });

  it("caps OpenAI-compatible verification decisions and long explanation fields", async () => {
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
                    status: "supported",
                    confidence: 0.9,
                    evidence: Array.from({ length: 25 }, (_, index) => ({
                      sourceId: `source-${index + 1}`,
                      relation: "supports",
                      confidence: 0.9,
                      quotedSupport: "q".repeat(4_100),
                      explanation: "e".repeat(4_100)
                    })),
                    explanation: "o".repeat(4_100),
                    riskFlags: Array.from({ length: 25 }, () => "weak_source")
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    });

    const result = await provider.verifyClaim({
      claim: {
        id: "claim-1",
        text: "SourceLine bounds verification output.",
        claimType: "technical",
        importance: "medium",
        searchQueries: ["bounded verification output"]
      },
      minConfidence: 0.65,
      evidence: Array.from({ length: 25 }, (_, index) => ({
        id: `source-${index + 1}`,
        title: `Source ${index + 1}`,
        url: `https://example.test/source-${index + 1}`,
        retrievedAt: "2026-06-07T00:00:00.000Z",
        snippet: `Evidence ${index + 1}.`,
        provider: "test-search",
        rank: index + 1,
        query: "bounded verification output"
      }))
    });

    expect(result.evidence).toHaveLength(20);
    expect(result.evidence[0]?.quotedSupport).toHaveLength(4_000);
    expect(result.evidence[0]?.quotedSupport).toMatch(/\.\.\. \[truncated\]$/);
    expect(result.evidence[0]?.explanation).toHaveLength(4_000);
    expect(result.evidence[0]?.explanation).toMatch(/\.\.\. \[truncated\]$/);
    expect(result.evidence.at(-1)?.source.id).toBe("source-20");
    expect(result.explanation).toHaveLength(4_000);
    expect(result.explanation).toMatch(/\.\.\. \[truncated\]$/);
    expect(result.riskFlags).toHaveLength(20);
  });

  it("does not include credentialed evidence URLs in verification prompts", async () => {
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
                    confidence: 0.8,
                    evidence: [
                      {
                        sourceId: "source-1",
                        relation: "supports",
                        confidence: 0.8,
                        explanation: "Mock support."
                      }
                    ],
                    explanation: "Mock explanation.",
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

    await provider.verifyClaim({
      claim: {
        id: "claim-1",
        text: "SourceLine protects evidence URL credentials.",
        claimType: "technical",
        importance: "medium",
        searchQueries: ["evidence URL credentials"]
      },
      minConfidence: 0.65,
      evidence: [
        {
          id: "source-1",
          title: "Credentialed source",
          url: "https://user:secret@example.test/private",
          path: "notes/source-1.md",
          retrievedAt: "2026-06-07T00:00:00.000Z",
          snippet: "Evidence remains available without the credentialed URL.",
          provider: "test-search",
          rank: 1,
          query: "evidence URL credentials"
        }
      ]
    });

    const userMessage = requestBody?.messages?.find((message) => message.role === "user")?.content ?? "";

    expect(userMessage).toContain("Title: Credentialed source");
    expect(userMessage).toContain("URL: notes/source-1.md");
    expect(userMessage).not.toContain("user:secret");
    expect(userMessage).not.toContain("https://user");
  });

  it("wraps network failures and redacts OpenAI-compatible secrets", async () => {
    const provider = createOpenAiProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      fetchImpl: async () => {
        throw new Error("socket disconnected for Bearer custom.secret-token and sk-secret-token");
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
    ).rejects.toThrow("OpenAI-compatible provider request failed: socket disconnected for Bearer *** and sk-***");
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

  it("rejects oversized OpenAI-compatible provider timeouts", () => {
    expect(() =>
      createOpenAiProvider({
        apiKey: "test-key",
        baseUrl: "https://example.test/v1",
        model: "test-model",
        timeoutMs: 300_001
      })
    ).toThrow("timeoutMs must be at most 300000.");
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
