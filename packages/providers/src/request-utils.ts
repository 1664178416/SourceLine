import { z } from "zod";

const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const MAX_ERROR_RESPONSE_BODY_BYTES = 4_096;

export function normalizeHttpBaseUrl(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    throw new Error(`${label} must be a valid http(s) URL.`);
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

  return normalized;
}

export function normalizeRequestTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  const normalized = Math.trunc(value);
  if (!Number.isFinite(value) || normalized <= 0) {
    throw new Error("timeoutMs must be a positive integer.");
  }

  return normalized;
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
  const signal = AbortSignal.timeout(options.timeoutMs);

  try {
    return await fetchImpl(input, { ...init, signal });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw new Error(options.timeoutMessage);
    }

    const message = formatFetchError(error);
    throw new Error(`${options.failureMessage}: ${options.redact ? options.redact(message) : message}`);
  }
}

export async function parseJsonResponse<T>(response: Response, schema: z.ZodType<T>, label: string): Promise<T> {
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${formatFetchError(error)}`);
  }

  try {
    return schema.parse(json);
  } catch (error) {
    throw new Error(`${label} returned an unexpected response shape: ${formatValidationError(error)}`);
  }
}

export async function readErrorResponseBody(response: Response, redact?: (value: string) => string): Promise<string> {
  const { text, truncated } = await readResponseBodyPrefix(response, MAX_ERROR_RESPONSE_BODY_BYTES);
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
    return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

async function readResponseBodyPrefix(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= maxBytes) {
      return { text, truncated: false };
    }

    return { text: new TextDecoder().decode(bytes.slice(0, maxBytes)), truncated: true };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  while (totalBytes < maxBytes) {
    const { done, value } = await reader.read();
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
      const { done, value } = await reader.read();
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

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: new TextDecoder().decode(bytes), truncated };
}

function normalizeErrorBody(value: string): string {
  return stripAnsi(value).replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
