import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InputDescriptor, ParsedInput } from "./types.js";

const MAX_URL_INPUT_BYTES = 2_000_000;
const URL_FETCH_TIMEOUT_MS = 15_000;
const SOURCE_LINE_USER_AGENT = `SourceLine/${readCoreVersion()}`;

export async function loadInput(input: InputDescriptor): Promise<ParsedInput> {
  if (input.kind === "file") {
    const absolutePath = resolve(input.path);
    const rawText = await readFile(absolutePath, "utf8");
    const text = isHtmlFile(absolutePath) ? normalizeWhitespace(htmlToText(rawText)) : rawText;
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

  const text = normalizeInlineInputText(input.text, input.kind);

  return {
    kind: input.kind,
    name: input.name,
    text,
    hash: hashText(text)
  };
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readCoreVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("packages/core/package.json must define a version.");
  }

  return manifest.version;
}

function isHtmlFile(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === ".html" || extension === ".htm";
}

async function loadUrlInput(input: Extract<InputDescriptor, { kind: "url" }>): Promise<{ name: string; text: string }> {
  const url = parseHttpUrl(input.url);
  const fetchImpl = input.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(URL_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "User-Agent": SOURCE_LINE_USER_AGENT
      },
      signal
    });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw new Error(`Timed out fetching ${url} after ${URL_FETCH_TIMEOUT_MS} ms.`);
    }

    throw new Error(`Failed to fetch ${url}: ${formatFetchError(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = await readBoundedResponse(response, url);
  const text = contentType.includes("html") ? htmlToText(body) : body;
  const normalized = normalizeWhitespace(text);

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

function formatFetchError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
function parseHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Invalid URL input: URL must not be empty.");
  }
  if (hasUrlControlCharacters(trimmed)) {
    throw new Error("Invalid URL input: URL must not contain control characters.");
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

  return url.toString();
}

function hasUrlControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

async function readBoundedResponse(response: Response, url: string): Promise<string> {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > MAX_URL_INPUT_BYTES) {
    throw new Error(`Fetched ${url}, but the response is larger than ${MAX_URL_INPUT_BYTES} bytes.`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;
    if (totalBytes > MAX_URL_INPUT_BYTES) {
      await reader.cancel();
      throw new Error(`Fetched ${url}, but the response is larger than ${MAX_URL_INPUT_BYTES} bytes.`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
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
  assertReadableText(text, `${kind === "stdin" ? "Stdin" : "Text input"} contains no readable text.`);
  return text;
}

function assertReadableText(text: string, message: string): void {
  if (text.trim().length === 0) {
    throw new Error(message);
  }
}

function htmlToText(html: string): string {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;

  return body
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(p|div|section|article|header|footer|main|aside|nav|li|h[1-6]|blockquote|tr)\b[^>]*>/gi, "\n\n")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|li|h[1-6]|blockquote|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, codePoint: string) => decodeHtmlCodePoint(codePoint, 10, match))
    .replace(/&#x([0-9a-f]+);/gi, (match, codePoint: string) => decodeHtmlCodePoint(codePoint, 16, match));
}

function decodeHtmlCodePoint(value: string, radix: number, fallback: string): string {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return fallback;
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
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
