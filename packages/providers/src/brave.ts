import type { SearchProvider, SearchResult } from "@sourceline/core";
import { joinSnippetParts, normalizeHttpUrl, normalizeIdentifierPart, normalizeOptionalText, normalizeSearchRequest } from "./search-utils.js";
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

const DEFAULT_BRAVE_BASE_URL = "https://api.search.brave.com/res/v1";
const MAX_RESULT_TITLE_CHARS = 2_000;
const MAX_RESULT_DATE_CHARS = 2_000;
const MAX_BRAVE_OPTION_CHARS = 20;

export type BraveSearchProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  country?: string;
  searchLang?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
};

const braveResultSchema = z.object({
  title: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  extra_snippets: z.array(z.string().nullable()).optional(),
  age: z.string().nullable().optional()
});

const braveResponseSchema = z.object({
  web: z
    .object({
      results: z.array(braveResultSchema).default([])
    })
    .optional()
});

export function createBraveSearchProvider(options: BraveSearchProviderOptions = {}): SearchProvider {
  const apiKey = normalizeApiKey(options.apiKey ?? process.env.BRAVE_SEARCH_API_KEY, "BRAVE_SEARCH_API_KEY is required for --search brave.");
  const baseUrl = normalizeHttpBaseUrl(options.baseUrl ?? process.env.BRAVE_SEARCH_BASE_URL ?? DEFAULT_BRAVE_BASE_URL, "Brave baseUrl");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = normalizeRequestTimeoutMs(options.timeoutMs);
  const country = normalizeBraveRequestOption(options.country, "US", "Brave country");
  const searchLang = normalizeBraveRequestOption(options.searchLang, "en", "Brave searchLang");

  return {
    name: "brave",
    async search(query) {
      const request = normalizeSearchRequest(query.query, query.maxResults);
      if (!request) {
        return [];
      }

      const url = new URL(`${baseUrl}/web/search`);
      url.searchParams.set("q", request.query);
      url.searchParams.set("count", String(Math.min(request.maxResults, 20)));
      url.searchParams.set("country", country);
      url.searchParams.set("search_lang", searchLang);
      url.searchParams.set("extra_snippets", "true");

      const response = await fetchWithTimeout(fetchImpl, url, {
        method: "GET",
        headers: {
          "X-Subscription-Token": apiKey,
          Accept: "application/json"
        }
      }, {
        timeoutMs,
        timeoutMessage: `Brave search timed out after ${timeoutMs} ms.`,
        failureMessage: "Brave search request failed",
        redact: redactSecrets
      });

      if (!response.ok) {
        const body = await readErrorResponseBody(response, redactSecrets, { timeoutMs });
        throw new Error(`Brave search returned ${response.status}: ${body}`);
      }

      const parsed = await parseJsonResponse(response, braveResponseSchema, "Brave search", { timeoutMs });
      const results = parsed.web?.results ?? [];
      const claimId = normalizeIdentifierPart(query.claimId, "claim");

      return results
        .map((result, index): SearchResult | undefined => {
          const url = normalizeHttpUrl(result.url);
          if (!url) {
            return undefined;
          }

          const rank = index + 1;
          const snippet = joinSnippetParts([result.description, ...(result.extra_snippets ?? [])]);
          if (snippet.length === 0) {
            return undefined;
          }

          return {
            id: `brave-${claimId}-${rank}`,
            title: normalizeOptionalText(result.title, { collapseWhitespace: true, maxLength: MAX_RESULT_TITLE_CHARS }) ?? url,
            url,
            publishedAt: normalizeOptionalText(result.age, { collapseWhitespace: true, maxLength: MAX_RESULT_DATE_CHARS }),
            retrievedAt: now().toISOString(),
            snippet,
            text: snippet,
            provider: "brave",
            rank,
            query: request.query
          };
        })
        .filter((result): result is SearchResult => result !== undefined)
        .slice(0, request.maxResults);
    }
  };
}

function redactSecrets(value: string): string {
  return redactBearerTokens(value).replace(/[A-Za-z0-9_-]{20,}/g, "***");
}

function normalizeBraveRequestOption(value: string | undefined, fallback: string, label: string): string {
  const normalized = value?.trim() ?? fallback;
  if (
    normalized.length === 0 ||
    normalized.length > MAX_BRAVE_OPTION_CHARS ||
    /[\u0000-\u001f\u007f-\u009f\s]/.test(normalized) ||
    !/^[A-Za-z0-9_-]+$/.test(normalized)
  ) {
    throw new Error(`${label} must be a short token containing only letters, numbers, underscores, or hyphens.`);
  }

  return normalized;
}

function normalizeApiKey(value: string | undefined, message: string): string {
  try {
    return normalizeRequiredStringConfig(value, "apiKey");
  } catch {
    throw new Error(message);
  }
}
