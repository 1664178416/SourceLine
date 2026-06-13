import type { Claim } from "./types.js";

export function normalizeClaimText(text: string): string {
  const normalized = stripAnsi(text)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[`*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();

  return stripWrappingQuotes(normalized);
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function dedupeClaims(claims: Claim[]): Claim[] {
  const seen = new Set<string>();
  const deduped: Claim[] = [];

  for (const claim of claims) {
    const text = normalizeClaimText(claim.text);
    const key = normalizeClaimKey(text);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      ...claim,
      text
    });
  }

  return deduped;
}

export function dedupeSearchResults<T extends { url?: string; path?: string; id: string }>(
  results: T[]
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const result of results) {
    const key = searchResultKey(result);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(result);
  }

  return deduped;
}

function normalizeClaimKey(text: string): string {
  return text
    .replace(/["']/g, "")
    .replace(/[()[\]{}]/g, " ")
    .replace(/[.,;:!?\u3002\uff01\uff1f\uff1b\uff1a\uff0c\u3001]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripWrappingQuotes(text: string): string {
  const match = text.match(/^["'](.+)["']$/);
  return match?.[1]?.trim() ?? text;
}

function searchResultKey(result: { url?: string; path?: string; id: string }): string {
  const url = normalizeOptionalLocation(result.url);
  if (url) {
    return `url:${normalizeUrlKey(url)}`;
  }
  const path = normalizeOptionalLocation(result.path);
  if (path) {
    return `path:${normalizePathKey(path)}`;
  }

  return `id:${result.id}`;
}

function normalizeOptionalLocation(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeUrlKey(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return value;
    }

    url.hash = "";
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
      url.port = "";
    }
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function normalizePathKey(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}
