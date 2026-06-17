import { mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./load-config.js";

describe("loadConfig", () => {
  it("ignores a missing default config file", async () => {
    const rootDir = join(tmpdir(), `sourceline-default-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await expect(loadConfig({ cwd: rootDir })).resolves.toEqual({ config: {} });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("fails when an explicit config file is missing", async () => {
    const rootDir = join(tmpdir(), `sourceline-missing-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await expect(loadConfig({ cwd: rootDir, configPath: "missing.json" })).rejects.toThrow("SourceLine config not found");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("treats explicit config paths beneath files as missing", async () => {
    const rootDir = join(tmpdir(), `sourceline-enotdir-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, "not-a-dir"), "plain file", "utf8");

      await expect(loadConfig({ cwd: rootDir, configPath: "not-a-dir/config.json" })).rejects.toThrow(
        "SourceLine config not found"
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("loads a valid explicit config file", async () => {
    const rootDir = join(tmpdir(), `sourceline-valid-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "custom.config.json"),
        JSON.stringify({
          llm: {
            provider: " OpenAI ",
            baseUrl: " https://example.test/v1/ ",
            model: " test-model "
          },
          search: {
            provider: " LOCAL ",
            sources: " examples/sources "
          },
          checks: {
            failOn: " Review "
          },
          reports: {
            defaultFormat: " Markdown "
          }
        }),
        "utf8"
      );

      const loaded = await loadConfig({ cwd: rootDir, configPath: " custom.config.json " });

      expect(loaded.path).toMatch(/custom\.config\.json$/);
      expect(loaded.config).toEqual({
        llm: {
          provider: "openai",
          baseUrl: "https://example.test/v1/",
          model: "test-model"
        },
        search: {
          provider: "local",
          sources: "examples/sources"
        },
        checks: {
          failOn: "review"
        },
        reports: {
          defaultFormat: "markdown"
        }
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects an empty explicit config path", async () => {
    const rootDir = join(tmpdir(), `sourceline-empty-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await expect(loadConfig({ cwd: rootDir, configPath: "   " })).rejects.toThrow("--config must not be empty.");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects explicit config paths with control characters", async () => {
    const rootDir = join(tmpdir(), `sourceline-control-config-path-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await expect(loadConfig({ cwd: rootDir, configPath: "sourceline.config.json\nnext" })).rejects.toThrow(
        "--config must not contain control characters."
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects overlong explicit config paths", async () => {
    const rootDir = join(tmpdir(), `sourceline-overlong-config-path-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await expect(loadConfig({ cwd: rootDir, configPath: "x".repeat(2_001) })).rejects.toThrow(
        "--config must be at most 2000 characters."
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects config paths that point to directories", async () => {
    const rootDir = join(tmpdir(), `sourceline-directory-config-${Date.now()}`);
    await mkdir(join(rootDir, "config-dir"), { recursive: true });

    try {
      await expect(loadConfig({ cwd: rootDir, configPath: "config-dir" })).rejects.toThrow("SourceLine config must be a file");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects default config paths that point to directories", async () => {
    const rootDir = join(tmpdir(), `sourceline-default-directory-config-${Date.now()}`);
    await mkdir(join(rootDir, "sourceline.config.json"), { recursive: true });

    try {
      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow("SourceLine config must be a file");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects oversized config files before reading JSON", async () => {
    const rootDir = join(tmpdir(), `sourceline-oversized-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const configPath = join(rootDir, "sourceline.config.json");
      await writeFile(configPath, "{}", "utf8");
      await truncate(configPath, 1_000_001);

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow("SourceLine config is larger than 1000000 bytes");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports invalid JSON with the config path", async () => {
    const rootDir = join(tmpdir(), `sourceline-invalid-json-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, "sourceline.config.json"), "{bad-json", "utf8");

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/Invalid JSON in .*sourceline\.config\.json/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports config schema errors with field paths", async () => {
    const rootDir = join(tmpdir(), `sourceline-invalid-schema-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "sourceline.config.json"),
        JSON.stringify({
          checks: {
            maxClaims: "many"
          },
          search: {
            unknownSetting: true
          }
        }),
        "utf8"
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/checks\.maxClaims: .*number/);
      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/search: .*unknownSetting/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("bounds noisy config schema error details", async () => {
    const rootDir = join(tmpdir(), `sourceline-noisy-schema-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const noisyConfig = Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [`unknownSetting${index}${index === 199 ? "HiddenTail" : ""}`, true])
      );
      await writeFile(join(rootDir, "sourceline.config.json"), JSON.stringify(noisyConfig), "utf8");

      let thrown: unknown;
      try {
        await loadConfig({ cwd: rootDir });
      } catch (error) {
        thrown = error;
      }

      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain("Invalid SourceLine config");
      expect(message).toContain("[truncated]");
      expect(message).not.toContain("HiddenTail");
      expect(message.length).toBeLessThanOrEqual(2_400);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects config numeric settings above bounded runtime limits", async () => {
    const rootDir = join(tmpdir(), `sourceline-bounded-number-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "sourceline.config.json"),
        JSON.stringify({
          checks: {
            maxClaims: 101
          },
          search: {
            maxResultsPerClaim: 21
          },
          providers: {
            timeoutMs: 300_001
          }
        }),
        "utf8"
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/checks\.maxClaims: .*100/);
      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/search\.maxResultsPerClaim: .*20/);
      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/providers\.timeoutMs: .*300000/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects config string fields that are blank after trimming", async () => {
    const rootDir = join(tmpdir(), `sourceline-blank-string-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "sourceline.config.json"),
        JSON.stringify({
          llm: {
            model: "   "
          },
          search: {
            sources: "   "
          }
        }),
        "utf8"
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/llm\.model: .*Too small/);
      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/search\.sources: .*Too small/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects config string fields with control characters", async () => {
    const rootDir = join(tmpdir(), `sourceline-control-string-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "sourceline.config.json"),
        JSON.stringify({
          llm: {
            model: "safe\nunsafe"
          },
          search: {
            sources: "examples\nsources"
          }
        }),
        "utf8"
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/llm\.model: Invalid string/);
      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/search\.sources: Invalid string/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects overlong config string fields before runtime use", async () => {
    const rootDir = join(tmpdir(), `sourceline-overlong-string-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "sourceline.config.json"),
        JSON.stringify({
          llm: {
            baseUrl: `https://example.test/${"a".repeat(2_000)}`,
            model: "m".repeat(2_001)
          },
          search: {
            sources: "s".repeat(2_001)
          }
        }),
        "utf8"
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/llm\.baseUrl: .*2000/);
      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/llm\.model: .*2000/);
      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/search\.sources: .*2000/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects non-http LLM base URLs in config files", async () => {
    const rootDir = join(tmpdir(), `sourceline-non-http-base-url-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "sourceline.config.json"),
        JSON.stringify({
          llm: {
            baseUrl: "file:///tmp/api"
          }
        }),
        "utf8"
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/llm\.baseUrl: Invalid URL protocol/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects LLM base URLs with control characters in config files", async () => {
    const rootDir = join(tmpdir(), `sourceline-control-base-url-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "sourceline.config.json"),
        JSON.stringify({
          llm: {
            baseUrl: "https://example.test/bad\npath"
          }
        }),
        "utf8"
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(/llm\.baseUrl: Invalid URL/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects LLM base URLs with credentials in config files", async () => {
    const rootDir = join(tmpdir(), `sourceline-credential-base-url-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "sourceline.config.json"),
        JSON.stringify({
          llm: {
            baseUrl: "https://user:secret@example.test/v1"
          }
        }),
        "utf8"
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /llm\.baseUrl: Invalid URL: base URL must not include username or password/
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects LLM base URLs with query strings or fragments in config files", async () => {
    const rootDir = join(tmpdir(), `sourceline-query-base-url-config-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "sourceline.config.json"),
        JSON.stringify({
          llm: {
            baseUrl: "https://example.test/v1?debug=true"
          }
        }),
        "utf8"
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /llm\.baseUrl: Invalid URL: base URL must not include query strings or fragments/
      );

      await writeFile(
        join(rootDir, "sourceline.config.json"),
        JSON.stringify({
          llm: {
            baseUrl: "https://example.test/v1#beta"
          }
        }),
        "utf8"
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /llm\.baseUrl: Invalid URL: base URL must not include query strings or fragments/
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
