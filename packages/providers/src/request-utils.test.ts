import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  fetchWithTimeout,
  normalizeHttpBaseUrl,
  normalizeRequestTimeoutMs,
  normalizeRequiredStringConfig,
  parseJsonResponse,
  readErrorResponseBody
} from "./request-utils.js";

describe("normalizeHttpBaseUrl", () => {
  it("normalizes http base URLs and removes trailing slashes", () => {
    expect(normalizeHttpBaseUrl(" https://example.test/v1/// ", "baseUrl")).toBe("https://example.test/v1");
    expect(normalizeHttpBaseUrl("http://example.test/api/", "baseUrl")).toBe("http://example.test/api");
  });

  it("rejects blank, malformed, control-character, and non-http base URLs", () => {
    for (const value of ["   ", "notaurl", "https://example.test/bad\npath", "file:///tmp/api"]) {
      expect(() => normalizeHttpBaseUrl(value, "baseUrl")).toThrow("baseUrl must be a valid http(s) URL.");
    }
  });

  it("rejects query strings and fragments in base URLs", () => {
    for (const value of ["https://example.test/v1?debug=true", "https://example.test/v1#beta"]) {
      expect(() => normalizeHttpBaseUrl(value, "baseUrl")).toThrow("baseUrl must be a valid http(s) URL.");
    }
  });
});

describe("normalizeRequestTimeoutMs", () => {
  it("defaults and validates provider request timeouts", () => {
    expect(normalizeRequestTimeoutMs(undefined)).toBe(30_000);
    expect(normalizeRequestTimeoutMs(123.9)).toBe(123);
    expect(() => normalizeRequestTimeoutMs(0)).toThrow("timeoutMs must be a positive integer.");
    expect(() => normalizeRequestTimeoutMs(0.5)).toThrow("timeoutMs must be a positive integer.");
    expect(() => normalizeRequestTimeoutMs(Number.NaN)).toThrow("timeoutMs must be a positive integer.");
  });
});

describe("normalizeRequiredStringConfig", () => {
  it("trims non-empty string configuration values", () => {
    expect(normalizeRequiredStringConfig(" test-value ", "setting")).toBe("test-value");
  });

  it("rejects blank and control-character string configuration values", () => {
    for (const value of [undefined, "   ", "safe\nunsafe"]) {
      expect(() => normalizeRequiredStringConfig(value, "setting")).toThrow("setting must not be empty.");
    }
  });
});

describe("fetchWithTimeout", () => {
  it("passes a timeout signal to fetch", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      return new Response("{}", { status: 200 });
    };

    await fetchWithTimeout(fetchImpl, "https://example.test", {}, {
      timeoutMs: 25,
      timeoutMessage: "timed out",
      failureMessage: "failed"
    });

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("maps abort errors to provider timeout messages", async () => {
    const fetchImpl: typeof fetch = async () => {
      const error = new Error("operation aborted");
      error.name = "AbortError";
      throw error;
    };

    await expect(
      fetchWithTimeout(fetchImpl, "https://example.test", {}, {
        timeoutMs: 25,
        timeoutMessage: "provider timed out after 25 ms.",
        failureMessage: "provider failed"
      })
    ).rejects.toThrow("provider timed out after 25 ms.");
  });

  it("wraps and redacts non-timeout network errors", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("socket closed with sk-secret-token");
    };

    await expect(
      fetchWithTimeout(fetchImpl, "https://example.test", {}, {
        timeoutMs: 25,
        timeoutMessage: "provider timed out",
        failureMessage: "provider failed",
        redact: (value) => value.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
      })
    ).rejects.toThrow("provider failed: socket closed with sk-***");
  });
});

describe("parseJsonResponse", () => {
  const schema = z.object({
    value: z.string()
  });

  it("parses JSON responses that match the requested schema", async () => {
    await expect(
      parseJsonResponse(new Response('{"value":"ok"}', { headers: { "Content-Type": "application/json" } }), schema, "Provider")
    ).resolves.toEqual({ value: "ok" });
  });

  it("wraps invalid JSON responses", async () => {
    await expect(parseJsonResponse(new Response("not-json"), schema, "Provider")).rejects.toThrow(
      "Provider returned invalid JSON:"
    );
  });

  it("wraps schema validation failures with field paths", async () => {
    await expect(parseJsonResponse(new Response('{"value":123}'), schema, "Provider")).rejects.toThrow(
      "Provider returned an unexpected response shape: value: Invalid input: expected string, received number"
    );
  });
});

describe("readErrorResponseBody", () => {
  it("normalizes empty and control-character error bodies", async () => {
    await expect(readErrorResponseBody(new Response(""))).resolves.toBe("<empty response body>");
    await expect(readErrorResponseBody(new Response("First\n\u001b[31mred\u001b[0m\tline"))).resolves.toBe("First red line");
  });

  it("redacts error bodies before returning them", async () => {
    await expect(
      readErrorResponseBody(new Response("token sk-secret-token leaked"), (value) => value.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***"))
    ).resolves.toBe("token sk-*** leaked");
  });

  it("does not mark exactly bounded error bodies as truncated", async () => {
    await expect(readErrorResponseBody(new Response("x".repeat(4096)))).resolves.toBe("x".repeat(4096));
  });

  it("truncates oversized error bodies", async () => {
    const body = await readErrorResponseBody(new Response(`${"x".repeat(4096)}secret-tail`));

    expect(body).toBe(`${"x".repeat(4096)}... [truncated after 4096 bytes]`);
    expect(body).not.toContain("secret-tail");
  });
});
