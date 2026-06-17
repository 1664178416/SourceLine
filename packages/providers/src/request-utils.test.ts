import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  fetchWithTimeout,
  normalizeHttpBaseUrl,
  normalizeRequestTimeoutMs,
  normalizeRequiredStringConfig,
  parseJsonResponse,
  readErrorResponseBody,
  redactBearerTokens
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

  it("rejects credentials in base URLs", () => {
    for (const value of ["https://user@example.test/v1", "https://user:secret@example.test/v1"]) {
      expect(() => normalizeHttpBaseUrl(value, "baseUrl")).toThrow("baseUrl must be a valid http(s) URL.");
    }
  });

  it("rejects overlong base URLs before parsing", () => {
    expect(() => normalizeHttpBaseUrl(`https://example.test/${"a".repeat(2_000)}`, "baseUrl")).toThrow(
      "baseUrl must be at most 2000 characters."
    );
  });
});

describe("normalizeRequestTimeoutMs", () => {
  it("defaults and validates provider request timeouts", () => {
    expect(normalizeRequestTimeoutMs(undefined)).toBe(30_000);
    expect(normalizeRequestTimeoutMs(123)).toBe(123);
    expect(() => normalizeRequestTimeoutMs(0)).toThrow("timeoutMs must be a positive integer.");
    expect(() => normalizeRequestTimeoutMs(0.5)).toThrow("timeoutMs must be a positive integer.");
    expect(() => normalizeRequestTimeoutMs(123.9)).toThrow("timeoutMs must be a positive integer.");
    expect(() => normalizeRequestTimeoutMs(Number.NaN)).toThrow("timeoutMs must be a positive integer.");
    expect(() => normalizeRequestTimeoutMs(300_001)).toThrow("timeoutMs must be at most 300000.");
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

  it("rejects overlong string configuration values", () => {
    expect(() => normalizeRequiredStringConfig("x".repeat(2_001), "setting")).toThrow(
      "setting must be at most 2000 characters."
    );
  });
});

describe("redactBearerTokens", () => {
  it("redacts bearer credentials without removing surrounding error context", () => {
    expect(redactBearerTokens("Authorization: Bearer custom.secret-token_123 failed")).toBe(
      "Authorization: Bearer *** failed"
    );
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

  it("times out even when a custom fetch implementation ignores abort signals", async () => {
    let signal: AbortSignal | undefined;
    let aborted = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      signal?.addEventListener("abort", () => {
        aborted = true;
      });

      return await new Promise<Response>(() => undefined);
    };

    await expect(
      fetchWithTimeout(fetchImpl, "https://example.test", {}, {
        timeoutMs: 5,
        timeoutMessage: "provider hard timed out.",
        failureMessage: "provider failed"
      })
    ).rejects.toThrow("provider hard timed out.");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    expect(aborted).toBe(true);
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

  it("bounds and normalizes non-timeout network errors after redaction", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error(`socket\n\u001b[31mclosed\u001b[0m for Bearer custom.secret-token ${"x".repeat(2_500)} hidden-tail`);
    };

    let thrown: unknown;
    try {
      await fetchWithTimeout(fetchImpl, "https://example.test", {}, {
        timeoutMs: 25,
        timeoutMessage: "provider timed out",
        failureMessage: "provider failed",
        redact: redactBearerTokens
      });
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    const prefix = "provider failed: ";
    expect(message.startsWith(`${prefix}socket closed for Bearer *** `)).toBe(true);
    expect(message).toContain("[truncated]");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("custom.secret-token");
    expect(message).not.toContain("hidden-tail");
    expect(message.length).toBeLessThanOrEqual(prefix.length + 2_000);
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

  it("times out JSON response body reads that never finish", async () => {
    vi.useFakeTimers();

    try {
      const response = {
        headers: new Headers(),
        body: undefined,
        text: async () => await new Promise<string>(() => undefined)
      } as Response;
      const pendingParse = parseJsonResponse(response, schema, "Provider", { timeoutMs: 5 });
      const assertion = expect(pendingParse).rejects.toThrow("Provider response body timed out after 5 ms.");

      await vi.advanceTimersByTimeAsync(5);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects oversized JSON responses from content-length before reading the body", async () => {
    await expect(
      parseJsonResponse(
        new Response('{"value":"ok"}', {
          headers: {
            "content-length": "5000001"
          }
        }),
        schema,
        "Provider"
      )
    ).rejects.toThrow("Provider response is larger than 5000000 bytes.");
  });

  it("rejects oversized JSON responses while streaming bodies without content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new Uint8Array(5_000_001));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      }
    });

    await expect(parseJsonResponse(new Response(stream), schema, "Provider")).rejects.toThrow(
      "Provider response is larger than 5000000 bytes."
    );
  });

  it("wraps schema validation failures with field paths", async () => {
    await expect(parseJsonResponse(new Response('{"value":123}'), schema, "Provider")).rejects.toThrow(
      "Provider returned an unexpected response shape: value: Invalid input: expected string, received number"
    );
  });

  it("bounds and normalizes schema validation failure details", async () => {
    const noisySchema = z.object({
      value: z.string().superRefine((_value, context) => {
        context.addIssue({
          code: "custom",
          message: `bad \u001b[31m${"x".repeat(1_000)} hidden-tail`
        });
      })
    });

    let thrown: unknown;
    try {
      await parseJsonResponse(new Response('{"value":"ok"}'), noisySchema, "Provider");
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("Provider returned an unexpected response shape:");
    expect(message).toContain("[truncated]");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("hidden-tail");
    expect(message.length).toBeLessThanOrEqual(2_200);
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

  it("omits error response bodies that never finish", async () => {
    vi.useFakeTimers();

    try {
      const response = {
        headers: new Headers(),
        body: undefined,
        text: async () => await new Promise<string>(() => undefined)
      } as Response;
      const pendingBody = readErrorResponseBody(response, undefined, { timeoutMs: 5 });
      const assertion = expect(pendingBody).resolves.toBe("[response body omitted after 5 ms]");

      await vi.advanceTimersByTimeAsync(5);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
