const MAX_SEARCH_QUERY_CHARS = 500;
const MAX_SEARCH_RESULTS = 20;
const MAX_HTTP_URL_CHARS = 2_000;
const MAX_IDENTIFIER_PART_CHARS = 200;
const MAX_OPTIONAL_TEXT_CHARS = 20_000;
const TRUNCATION_MARKER = "... [truncated]";

export function normalizeHttpUrl(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > MAX_HTTP_URL_CHARS || /[\u0000-\u001f\u007f-\u009f\s<>]/.test(trimmed)) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (url.username.length > 0 || url.password.length > 0) {
      return undefined;
    }

    return url.toString();
  } catch {
    return undefined;
  }
}

export function normalizeOptionalText(
  value: string | null | undefined,
  options: { collapseWhitespace?: boolean; maxLength?: number } = {}
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const withoutControls = stripAnsi(value).replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "");
  const normalized = options.collapseWhitespace ? withoutControls.replace(/\s+/g, " ").trim() : withoutControls.trim();
  const maxLength = options.maxLength ?? MAX_OPTIONAL_TEXT_CHARS;
  const truncated = truncateText(normalized, maxLength);
  return truncated.length > 0 ? truncated : undefined;
}

export function normalizeIdentifierPart(value: string, fallback: string): string {
  const normalized = normalizeIdentifierText(value);
  const slug = slugifyIdentifierPart(normalized);
  const fallbackSlug = slugifyIdentifierPart(normalizeIdentifierText(fallback)) || "id";
  const bounded = truncateIdentifierPart(slug);

  if (bounded.length > 0) {
    return bounded;
  }

  return normalized.length > 0 ? truncateIdentifierPart(`${fallbackSlug}-${stableHash(normalized)}`) : fallbackSlug;
}

function normalizeIdentifierText(value: string): string {
  return stripAnsi(value)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .trim()
    .toLowerCase();
}

function slugifyIdentifierPart(value: string): string {
  return value.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function truncateIdentifierPart(value: string): string {
  return value.length > MAX_IDENTIFIER_PART_CHARS ? value.slice(0, MAX_IDENTIFIER_PART_CHARS).replace(/-+$/g, "") : value;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function joinSnippetParts(parts: Array<string | null | undefined>): string {
  const joined = parts
    .map((part) => normalizeOptionalText(part, { collapseWhitespace: true, maxLength: 2_000 }))
    .filter((part): part is string => part !== undefined)
    .join(" ");
  return truncateText(joined, 2_000);
}

export function finiteNumber(value: number | null | undefined): number | undefined {
  return value !== undefined && value !== null && Number.isFinite(value) ? value : undefined;
}

export function normalizeSearchRequest(query: string, maxResults: number): { query: string; maxResults: number } | undefined {
  const normalizedQuery = stripAnsi(query).replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
  if (normalizedQuery.length === 0 || !Number.isInteger(maxResults) || maxResults <= 0) {
    return undefined;
  }

  return {
    query: normalizedQuery.length > MAX_SEARCH_QUERY_CHARS ? normalizedQuery.slice(0, MAX_SEARCH_QUERY_CHARS).trim() : normalizedQuery,
    maxResults: Math.min(maxResults, MAX_SEARCH_RESULTS)
  };
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= TRUNCATION_MARKER.length) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}
