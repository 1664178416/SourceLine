import type { SearchProvider, SearchResult } from "@sourceline/core";
import { joinSnippetParts, normalizeHttpUrl, normalizeOptionalText, normalizeSearchRequest } from "./search-utils.js";
import { z } from "zod";
import {
  fetchWithTimeout,
  normalizeHttpBaseUrl,
  normalizeRequestTimeoutMs,
  normalizeRequiredStringConfig,
  parseJsonResponse,
  readErrorResponseBody
} from "./request-utils.js";

const DEFAULT_BRAVE_BASE_URL = "https://api.search.brave.com/res/v1";

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
      url.searchParams.set("country", options.country ?? "US");
      url.searchParams.set("search_lang", options.searchLang ?? "en");
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
        const body = await readErrorResponseBody(response, redactSecrets);
        throw new Error(`Brave search returned ${response.status}: ${body}`);
      }

      const parsed = await parseJsonResponse(response, braveResponseSchema, "Brave search");
      const results = parsed.web?.results ?? [];

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
            id: `brave-${query.claimId}-${rank}`,
            title: normalizeOptionalText(result.title, { collapseWhitespace: true }) ?? url,
            url,
            publishedAt: normalizeOptionalText(result.age, { collapseWhitespace: true }),
            retrievedAt: now().toISOString(),
            snippet,
            text: snippet,
            provider: "brave",
            rank,
            query: request.query
          };
        })
        .filter((result): result is SearchResult => result !== undefined);
    }
  };
}

function redactSecrets(value: string): string {
  return value.replace(/[A-Za-z0-9_-]{20,}/g, "***");
}

function normalizeApiKey(value: string | undefined, message: string): string {
  try {
    return normalizeRequiredStringConfig(value, "apiKey");
  } catch {
    throw new Error(message);
  }
}
