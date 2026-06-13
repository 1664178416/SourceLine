import { mkdir, rm, writeFile } from "node:fs/promises";
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
