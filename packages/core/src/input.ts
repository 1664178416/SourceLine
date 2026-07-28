import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToText } from "./html.js";
import type { InputDescriptor, ParsedInput } from "./types.js";

export const MAX_INPUT_BYTES = 2_000_000;
const MAX_INPUT_REFERENCE_CHARS = 2_000;
const MAX_PACKAGE_MANIFEST_BYTES = 1_000_000;
const FILE_READ_CHUNK_BYTES = 64_000;
const URL_FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_ERROR_CHARS = 1_000;
const TRUNCATION_MARKER = "... [truncated]";
const SOURCE_LINE_USER_AGENT = `SourceLine/${readCoreVersion()}`;

class ResponseBodyTimeoutError extends Error {}

export async function loadInput(input: InputDescriptor): Promise<ParsedInput> {
  if (input.kind === "file") {
    const absolutePath = resolve(normalizeFileInputPath(input.path));
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      throw new Error(`File input must be a file: ${absolutePath}`);
    }
    assertWithinInputByteLimit(fileStat.size, `File ${absolutePath}`);
    const rawText = await readBoundedFileText(absolutePath);
    const text = isHtmlFile(absolutePath) ? htmlToText(rawText) : rawText;
    assertReadableText(text, `File ${absolutePath} contains no readable text.`);

    return {
      kind: "file",
      name: basename(absolutePath),
      text,
      hash: hashText(text)
    };
  }

  if (input.kind === "url") {
    const loaded = await loadUrlInput(input);

    return {
      kind: "url",
      name: input.name ?? loaded.name,
      text: loaded.text,
      hash: hashText(loaded.text)
    };
  }

  if (input.kind === "stdin" || input.kind === "text") {
    const text = normalizeInlineInputText(input.text, input.kind);

    return {
      kind: input.kind,
      name: input.name,
      text,
      hash: hashText(text)
    };
  }

  throw new Error(`Unsupported input kind "${formatUnknownInputKind(input)}". Use file, url, stdin, or text.`);
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readCoreVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const packageStat = statSync(packageJsonPath);
  if (!packageStat.isFile()) {
    throw new Error("packages/core/package.json must be a file.");
  }
  if (packageStat.size > MAX_PACKAGE_MANIFEST_BYTES) {
    throw new Error(`packages/core/package.json is larger than ${MAX_PACKAGE_MANIFEST_BYTES} bytes.`);
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
  if (!isRecord(manifest)) {
    throw new Error("packages/core/package.json must be a JSON object.");
  }

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("packages/core/package.json must define a version.");
  }

  return manifest.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHtmlFile(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === ".html" || extension === ".htm";
}

async function readBoundedFileText(path: string): Promise<string> {
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const remaining = MAX_INPUT_BYTES + 1 - totalBytes;
      const buffer = Buffer.alloc(Math.min(FILE_READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);

      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes).toString("utf8");
      }

      totalBytes += bytesRead;
      if (totalBytes > MAX_INPUT_BYTES) {
        throw new Error(`File ${path} is larger than ${MAX_INPUT_BYTES} bytes.`);
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

function normalizeFileInputPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new Error("File input path must not be empty.");
  }
  if (hasControlCharacters(trimmed)) {
    throw new Error("File input path must not contain control characters.");
  }
  if (trimmed.length > MAX_INPUT_REFERENCE_CHARS) {
    throw new Error(`File input path must be at most ${MAX_INPUT_REFERENCE_CHARS} characters.`);
  }
  if (/[\\/]$/.test(trimmed)) {
    throw new Error("File input path must be a file path, not a directory.");
  }

  return trimmed;
}

async function loadUrlInput(input: Extract<InputDescriptor, { kind: "url" }>): Promise<{ name: string; text: string }> {
  const url = parseHttpUrl(input.url);
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMessage = `Timed out fetching ${url} after ${URL_FETCH_TIMEOUT_MS} ms.`;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, URL_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await Promise.race([
      fetchImpl(url, {
        headers: {
          Accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "User-Agent": SOURCE_LINE_USER_AGENT
        },
        signal: controller.signal
      }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            reject(new Error(timeoutMessage));
          },
          { once: true }
        );
      })
    ]);
  } catch (error) {
    if (timedOut || isAbortError(error)) {
      throw new Error(timeoutMessage);
    }

    throw new Error(`Failed to fetch ${url}: ${formatFetchError(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = await readBoundedResponse(response, url);
  const normalized = isHtmlContentType(contentType) ? htmlToText(body) : normalizeWhitespace(body);

  if (normalized.length === 0) {
    throw new Error(`Fetched ${url}, but no readable text was found.`);
  }

  return {
    name: url,
    text: normalized
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function isHtmlContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("html");
}

function formatFetchError(error: unknown): string {
  const message = error instanceof Error && error.message.length > 0 ? error.message : String(error);
  return normalizeErrorMessage(message, MAX_FETCH_ERROR_CHARS) || "Unknown error";
}

function normalizeErrorMessage(value: string, maxLength: number): string {
  const normalized = stripAnsi(value)
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .trim();
  if (normalized.length <= maxLength) {
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

function parseHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Invalid URL input: URL must not be empty.");
  }
  if (hasControlCharacters(trimmed)) {
    throw new Error("Invalid URL input: URL must not contain control characters.");
  }
  if (trimmed.length > MAX_INPUT_REFERENCE_CHARS) {
    throw new Error(`Invalid URL input: URL must be at most ${MAX_INPUT_REFERENCE_CHARS} characters.`);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL input: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol "${url.protocol}". Use http or https.`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("Invalid URL input: URL must not include username or password.");
  }

  return url.toString();
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

async function readBoundedResponse(response: Response, url: string): Promise<string> {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > MAX_INPUT_BYTES) {
    throw new Error(`Fetched ${url}, but the response is larger than ${MAX_INPUT_BYTES} bytes.`);
  }

  const timeoutMessage = `Timed out fetching ${url} after ${URL_FETCH_TIMEOUT_MS} ms.`;
  const deadline = Date.now() + URL_FETCH_TIMEOUT_MS;
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await withBodyReadTimeout(response.text(), deadline, timeoutMessage);
    assertWithinInputByteLimit(new TextEncoder().encode(text).byteLength, `Fetched ${url}, but the response`);

    return text;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await withBodyReadTimeout(reader.read(), deadline, timeoutMessage);
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > MAX_INPUT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Fetched ${url}, but the response is larger than ${MAX_INPUT_BYTES} bytes.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ResponseBodyTimeoutError) {
      await reader.cancel().catch(() => undefined);
    }
    throw error;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
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

function parseContentLength(value: string | null): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function normalizeInlineInputText(text: string, kind: "stdin" | "text"): string {
  assertWithinInputByteLimit(new TextEncoder().encode(text).byteLength, kind === "stdin" ? "Stdin input" : "Text input");
  assertReadableText(text, `${kind === "stdin" ? "Stdin" : "Text input"} contains no readable text.`);
  return text;
}

function assertWithinInputByteLimit(bytes: number, label: string): void {
  if (bytes > MAX_INPUT_BYTES) {
    throw new Error(`${label} is larger than ${MAX_INPUT_BYTES} bytes.`);
  }
}

function formatUnknownInputKind(input: unknown): string {
  const kind = (input as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0 ? kind : "unknown";
}

function assertReadableText(text: string, message: string): void {
  if (text.trim().length === 0) {
    throw new Error(message);
  }
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
