export function normalizeHttpUrl(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }

    return url.toString();
  } catch {
    return undefined;
  }
}

export function normalizeOptionalText(value: string | null | undefined, options: { collapseWhitespace?: boolean } = {}): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const withoutControls = stripAnsi(value).replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "");
  const normalized = options.collapseWhitespace ? withoutControls.replace(/\s+/g, " ").trim() : withoutControls.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function joinSnippetParts(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => normalizeOptionalText(part, { collapseWhitespace: true }))
    .filter((part): part is string => part !== undefined)
    .join(" ");
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
    query: normalizedQuery,
    maxResults
  };
}
