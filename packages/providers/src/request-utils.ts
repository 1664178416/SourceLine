import { z } from "zod";

const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_TIMEOUT_MS = 300_000;
const MAX_ERROR_RESPONSE_BODY_BYTES = 4_096;
const MAX_JSON_RESPONSE_BODY_BYTES = 5_000_000;
const MAX_PROVIDER_CONFIG_STRING_CHARS = 2_000;
const MAX_FETCH_ERROR_CHARS = 2_000;
const MAX_VALIDATION_ERROR_CHARS = 2_000;
const MAX_VALIDATION_ERROR_ISSUES = 20;
const MAX_VALIDATION_ISSUE_CHARS = 300;
const MAX_VALIDATION_ISSUE_PATH_CHARS = 200;
const TRUNCATION_MARKER = "... [truncated]";

type ResponseBodyReadOptions = {
  timeoutMs?: number;
};

class ResponseBodyTimeoutError extends Error {}

export function normalizeHttpBaseUrl(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    throw new Error(`${label} must be a valid http(s) URL.`);
  }
  if (trimmed.length > MAX_PROVIDER_CONFIG_STRING_CHARS) {
    throw new Error(`${label} must be at most ${MAX_PROVIDER_CONFIG_STRING_CHARS} characters.`);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid http(s) URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must be a valid http(s) URL.`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${label} must be a valid http(s) URL.`);
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error(`${label} must be a valid http(s) URL.`);
  }

  return url.toString().replace(/\/+$/, "");
}

export function normalizeRequiredStringConfig(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
    throw new Error(`${label} must not be empty.`);
  }
  if (normalized.length > MAX_PROVIDER_CONFIG_STRING_CHARS) {
    throw new Error(`${label} must be at most ${MAX_PROVIDER_CONFIG_STRING_CHARS} characters.`);
  }

  return normalized;
}

export function redactBearerTokens(value: string): string {
  return value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***");
}

export function normalizeRequestTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("timeoutMs must be a positive integer.");
  }
  if (value > MAX_PROVIDER_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be at most ${MAX_PROVIDER_TIMEOUT_MS}.`);
  }

  return value;
}

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  options: {
    timeoutMs: number;
    timeoutMessage: string;
    failureMessage: string;
    redact?: (value: string) => string;
  }
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    const response = await Promise.race([
      fetchImpl(input, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            reject(new Error(options.timeoutMessage));
          },
          { once: true }
        );
      })
    ]);

    return response;
  } catch (error) {
    if (timedOut || isAbortError(error)) {
      throw new Error(options.timeoutMessage);
    }

    const message = formatFetchError(error);
    const redacted = options.redact ? options.redact(message) : message;
    throw new Error(`${options.failureMessage}: ${normalizeErrorText(redacted, MAX_FETCH_ERROR_CHARS) || "Unknown error"}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function parseJsonResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  label: string,
  options: ResponseBodyReadOptions = {}
): Promise<T> {
  const body = await readJsonResponseBody(response, label, options);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${formatFetchError(error)}`);
  }

  try {
    return schema.parse(json);
  } catch (error) {
    throw new Error(`${label} returned an unexpected response shape: ${formatValidationError(error)}`);
  }
}

async function readJsonResponseBody(response: Response, label: string, options: ResponseBodyReadOptions): Promise<string> {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > MAX_JSON_RESPONSE_BODY_BYTES) {
    throw new Error(`${label} response is larger than ${MAX_JSON_RESPONSE_BODY_BYTES} bytes.`);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const { text, truncated } = await readResponseBodyPrefix(response, MAX_JSON_RESPONSE_BODY_BYTES, {
    timeoutMs,
    timeoutMessage: `${label} response body timed out after ${timeoutMs} ms.`
  });
  if (truncated) {
    throw new Error(`${label} response is larger than ${MAX_JSON_RESPONSE_BODY_BYTES} bytes.`);
  }

  return text;
}

export async function readErrorResponseBody(
  response: Response,
  redact?: (value: string) => string,
  options: ResponseBodyReadOptions = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  let body: { text: string; truncated: boolean };
  try {
    body = await readResponseBodyPrefix(response, MAX_ERROR_RESPONSE_BODY_BYTES, {
      timeoutMs,
      timeoutMessage: `Error response body timed out after ${timeoutMs} ms.`
    });
  } catch (error) {
    if (error instanceof ResponseBodyTimeoutError) {
      return `[response body omitted after ${timeoutMs} ms]`;
    }
    throw error;
  }
  const { text, truncated } = body;
  const normalized = normalizeErrorBody(redact ? redact(text) : text);
  if (normalized.length === 0) {
    return truncated ? `[response body omitted after ${MAX_ERROR_RESPONSE_BODY_BYTES} bytes]` : "<empty response body>";
  }

  return truncated ? `${normalized}... [truncated after ${MAX_ERROR_RESPONSE_BODY_BYTES} bytes]` : normalized;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function formatFetchError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

function formatValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return normalizeErrorText(formatZodIssues(error), MAX_VALIDATION_ERROR_CHARS);
  }
  if (error instanceof Error && error.message.length > 0) {
    return normalizeErrorText(error.message, MAX_VALIDATION_ERROR_CHARS);
  }

  return normalizeErrorText(String(error), MAX_VALIDATION_ERROR_CHARS);
}

function formatZodIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, MAX_VALIDATION_ERROR_ISSUES).map(formatZodIssue);
  const omitted = error.issues.length - issues.length;
  if (omitted > 0) {
    issues.push(`${TRUNCATION_MARKER} (${omitted} more validation issues omitted)`);
  }

  return issues.join("; ");
}

function formatZodIssue(issue: z.ZodError["issues"][number]): string {
  const path = normalizeErrorText(formatIssuePath(issue.path), MAX_VALIDATION_ISSUE_PATH_CHARS) || "<root>";
  const message = normalizeErrorText(issue.message, MAX_VALIDATION_ISSUE_CHARS) || "Invalid value";
  return `${path}: ${message}`;
}

function formatIssuePath(path: PropertyKey[]): string {
  return path.length === 0 ? "<root>" : path.map((part) => String(part)).join(".");
}

function parseContentLength(value: string | null): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readResponseBodyPrefix(
  response: Response,
  maxBytes: number,
  options: { timeoutMs: number; timeoutMessage: string }
): Promise<{ text: string; truncated: boolean }> {
  const deadline = Date.now() + options.timeoutMs;
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await withBodyReadTimeout(response.text(), deadline, options.timeoutMessage);
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= maxBytes) {
      return { text, truncated: false };
    }

    return { text: new TextDecoder().decode(bytes.slice(0, maxBytes)), truncated: true };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await withBodyReadTimeout(reader.read(), deadline, options.timeoutMessage);
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      const remaining = maxBytes - totalBytes;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        totalBytes += remaining;
        truncated = true;
        break;
      }

      chunks.push(value);
      totalBytes += value.byteLength;
    }

    if (truncated) {
      await reader.cancel().catch(() => undefined);
    } else if (totalBytes >= maxBytes) {
      while (true) {
        const { done, value } = await withBodyReadTimeout(reader.read(), deadline, options.timeoutMessage);
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }

        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: new TextDecoder().decode(bytes), truncated };
}

async function withBodyReadTimeout<T>(operation: Promise<T>, deadline: number, timeoutMessage: string): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new ResponseBodyTimeoutError(timeoutMessage);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new ResponseBodyTimeoutError(timeoutMessage));
        }, remainingMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function normalizeErrorBody(value: string): string {
  return normalizeErrorText(value);
}

function normalizeErrorText(value: string, maxLength?: number): string {
  const normalized = stripAnsi(value).replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
  if (maxLength === undefined || normalized.length <= maxLength) {
    return normalized;
  }
  if (maxLength <= TRUNCATION_MARKER.length) {
    return normalized.slice(0, maxLength);
  }

  return `${normalized.slice(0, maxLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
