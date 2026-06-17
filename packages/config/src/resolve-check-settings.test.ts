import { describe, expect, it } from "vitest";
import { resolveCheckSettings } from "./resolve-check-settings.js";

describe("resolveCheckSettings", () => {
  it("merges flags over config over env over defaults", () => {
    const settings = resolveCheckSettings({
      flags: {
        provider: "openai",
        maxClaims: "7"
      },
      config: {
        llm: {
          provider: "mock",
          model: "config-model"
        },
        search: {
          provider: "local",
          sources: "config-sources",
          maxResultsPerClaim: 4
        },
        reports: {
          defaultFormat: "markdown"
        },
        checks: {
          failOn: "unsupported"
        }
      },
      env: {
        SOURCELINE_LLM_PROVIDER: "mock",
        SOURCELINE_SEARCH_PROVIDER: "brave",
        SOURCELINE_MAX_CLAIMS: "3",
        SOURCELINE_FAIL_ON: "review",
        SOURCELINE_PROVIDER_TIMEOUT_MS: "1000"
      }
    });

    expect(settings).toMatchObject({
      llmProvider: "openai",
      model: "config-model",
      searchProvider: "local",
      sources: "config-sources",
      reportFormat: "markdown",
      maxClaims: 7,
      maxResultsPerClaim: 4,
      failOn: "unsupported",
      providerTimeoutMs: 1000
    });
  });

  it("defaults to local search when sources are provided", () => {
    const settings = resolveCheckSettings({
      flags: {
        sources: "examples/sources"
      },
      env: {}
    });

    expect(settings.searchProvider).toBe("local");
  });


  it("accepts case-insensitive enum values with surrounding whitespace", () => {
    const settings = resolveCheckSettings({
      flags: {
        provider: " OpenAI ",
        search: " LOCAL ",
        report: " Markdown ",
        failOn: " Review "
      },
      env: {
        SOURCELINE_SOURCES: "examples/sources"
      }
    });

    expect(settings.llmProvider).toBe("openai");
    expect(settings.searchProvider).toBe("local");
    expect(settings.reportFormat).toBe("markdown");
    expect(settings.failOn).toBe("review");
  });

  it("normalizes non-empty string settings and http base URLs", () => {
    const settings = resolveCheckSettings({
      flags: {
        baseUrl: " https://example.test/v1/ ",
        model: " test-model ",
        sources: " examples/sources "
      },
      env: {}
    });

    expect(settings.baseUrl).toBe("https://example.test/v1/");
    expect(settings.model).toBe("test-model");
    expect(settings.sources).toBe("examples/sources");
    expect(settings.searchProvider).toBe("local");
  });

  it("rejects empty string settings and invalid base URLs", () => {
    expect(() =>
      resolveCheckSettings({
        flags: {
          model: "   "
        },
        env: {}
      })
    ).toThrow("model must not be empty.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          sources: "   "
        },
        env: {}
      })
    ).toThrow("sources must not be empty.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          model: "safe\nunsafe"
        },
        env: {}
      })
    ).toThrow("model must not contain control characters.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          sources: "examples\nsources"
        },
        env: {}
      })
    ).toThrow("sources must not contain control characters.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          baseUrl: "notaurl"
        },
        env: {}
      })
    ).toThrow("baseUrl must be a valid http(s) URL.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          baseUrl: "file:///tmp/api"
        },
        env: {}
      })
    ).toThrow("baseUrl must be a valid http(s) URL.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          baseUrl: "https://example.test/bad\npath"
        },
        env: {}
      })
    ).toThrow("baseUrl must be a valid http(s) URL.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          baseUrl: "https://user:secret@example.test/v1"
        },
        env: {}
      })
    ).toThrow("baseUrl must be a valid http(s) URL.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          baseUrl: "https://example.test/v1?debug=true"
        },
        env: {}
      })
    ).toThrow("baseUrl must be a valid http(s) URL.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          baseUrl: "https://example.test/v1#beta"
        },
        env: {}
      })
    ).toThrow("baseUrl must be a valid http(s) URL.");
  });

  it("rejects overlong string settings before runtime use", () => {
    expect(() =>
      resolveCheckSettings({
        flags: {
          model: "m".repeat(2_001)
        },
        env: {}
      })
    ).toThrow("model must be at most 2000 characters.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          sources: "s".repeat(2_001)
        },
        env: {}
      })
    ).toThrow("sources must be at most 2000 characters.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          baseUrl: `https://example.test/${"a".repeat(2_000)}`
        },
        env: {}
      })
    ).toThrow("baseUrl must be at most 2000 characters.");
  });

  it("returns helpful errors for unsupported enum values", () => {
    expect(() =>
      resolveCheckSettings({
        flags: {
          report: "banana"
        },
        env: {}
      })
    ).toThrow('Unsupported report format "banana". Use terminal, markdown, json, or html.');

    expect(() =>
      resolveCheckSettings({
        flags: {
          search: "web"
        },
        env: {}
      })
    ).toThrow('Unsupported search provider "web". Use mock, local, tavily, or brave.');

    expect(() =>
      resolveCheckSettings({
        flags: {
          provider: "anthropic"
        },
        env: {}
      })
    ).toThrow('Unsupported LLM provider "anthropic". Use mock or openai.');

    expect(() =>
      resolveCheckSettings({
        flags: {
          failOn: "partial"
        },
        env: {}
      })
    ).toThrow('Unsupported fail-on level "partial". Use never, review, unsupported, or contradicted.');
  });

  it("rejects partially parsed numeric flags", () => {
    expect(() =>
      resolveCheckSettings({
        flags: {
          maxClaims: "10abc"
        },
        env: {}
      })
    ).toThrow("maxClaims must be a positive integer.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          minConfidence: "0.5x"
        },
        env: {}
      })
    ).toThrow("minConfidence must be a number between 0 and 1.");
  });

  it("rejects numeric settings above bounded runtime limits", () => {
    expect(() =>
      resolveCheckSettings({
        flags: {
          maxClaims: "101"
        },
        env: {}
      })
    ).toThrow("maxClaims must be at most 100.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          maxResults: "21"
        },
        env: {}
      })
    ).toThrow("maxResultsPerClaim must be at most 20.");

    expect(() =>
      resolveCheckSettings({
        flags: {
          providerTimeoutMs: "300001"
        },
        env: {}
      })
    ).toThrow("providerTimeoutMs must be at most 300000.");
  });

  it("resolves fail-on from flags, config, env, and defaults", () => {
    expect(resolveCheckSettings({ flags: {}, env: {} }).failOn).toBe("never");
    expect(resolveCheckSettings({ flags: {}, env: { SOURCELINE_FAIL_ON: "review" } }).failOn).toBe("review");
    expect(
      resolveCheckSettings({
        flags: {},
        config: {
          checks: {
            failOn: "unsupported"
          }
        },
        env: {
          SOURCELINE_FAIL_ON: "review"
        }
      }).failOn
    ).toBe("unsupported");
    expect(
      resolveCheckSettings({
        flags: {
          failOn: "contradicted"
        },
        config: {
          checks: {
            failOn: "unsupported"
          }
        },
        env: {
          SOURCELINE_FAIL_ON: "review"
        }
      }).failOn
    ).toBe("contradicted");
  });

  it("keeps numeric config values above environment values", () => {
    const settings = resolveCheckSettings({
      flags: {},
      config: {
        search: {
          maxResultsPerClaim: 6
        },
        checks: {
          maxClaims: 12,
          minConfidence: 0.8
        }
      },
      env: {
        SOURCELINE_MAX_CLAIMS: "3",
        SOURCELINE_MAX_RESULTS: "2",
        SOURCELINE_MIN_CONFIDENCE: "0.2"
      }
    });

    expect(settings.maxClaims).toBe(12);
    expect(settings.maxResultsPerClaim).toBe(6);
    expect(settings.minConfidence).toBe(0.8);
  });

  it("keeps numeric flags above config and environment values", () => {
    const settings = resolveCheckSettings({
      flags: {
        maxClaims: "9",
        maxResults: "4",
        minConfidence: "0.7"
      },
      config: {
        search: {
          maxResultsPerClaim: 6
        },
        checks: {
          maxClaims: 12,
          minConfidence: 0.8
        }
      },
      env: {
        SOURCELINE_MAX_CLAIMS: "3",
        SOURCELINE_MAX_RESULTS: "2",
        SOURCELINE_MIN_CONFIDENCE: "0.2"
      }
    });

    expect(settings.maxClaims).toBe(9);
    expect(settings.maxResultsPerClaim).toBe(4);
    expect(settings.minConfidence).toBe(0.7);
  });

  it("accepts numeric string settings with surrounding whitespace", () => {
    const settings = resolveCheckSettings({
      flags: {
        maxClaims: " 9 ",
        minConfidence: " 0.7 ",
        providerTimeoutMs: " 6000 "
      },
      env: {
        SOURCELINE_MAX_RESULTS: " 4 "
      }
    });

    expect(settings.maxClaims).toBe(9);
    expect(settings.maxResultsPerClaim).toBe(4);
    expect(settings.minConfidence).toBe(0.7);
    expect(settings.providerTimeoutMs).toBe(6000);
  });

  it("resolves remote provider timeout from flags, config, env, and defaults", () => {
    expect(resolveCheckSettings({ flags: {}, env: {} }).providerTimeoutMs).toBe(30_000);
    expect(resolveCheckSettings({ flags: {}, env: { SOURCELINE_PROVIDER_TIMEOUT_MS: "2500" } }).providerTimeoutMs).toBe(2500);
    expect(
      resolveCheckSettings({
        flags: {},
        config: {
          providers: {
            timeoutMs: 4000
          }
        },
        env: {
          SOURCELINE_PROVIDER_TIMEOUT_MS: "2500"
        }
      }).providerTimeoutMs
    ).toBe(4000);
    expect(
      resolveCheckSettings({
        flags: {
          providerTimeoutMs: "6000"
        },
        config: {
          providers: {
            timeoutMs: 4000
          }
        },
        env: {
          SOURCELINE_PROVIDER_TIMEOUT_MS: "2500"
        }
      }).providerTimeoutMs
    ).toBe(6000);
  });

  it("rejects invalid remote provider timeouts", () => {
    expect(() =>
      resolveCheckSettings({
        flags: {
          providerTimeoutMs: "10ms"
        },
        env: {}
      })
    ).toThrow("providerTimeoutMs must be a positive integer.");

    expect(() =>
      resolveCheckSettings({
        flags: {},
        config: {
          providers: {
            timeoutMs: 0
          }
        },
        env: {}
      })
    ).toThrow("providerTimeoutMs must be a positive integer.");
  });
});
