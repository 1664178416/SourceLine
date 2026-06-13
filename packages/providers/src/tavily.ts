import type { SearchProvider, SearchResult } from "@sourceline/core";
import { finiteNumber, normalizeHttpUrl, normalizeOptionalText, normalizeSearchRequest } from "./search-utils.js";
import { z } from "zod";
import {
  fetchWithTimeout,
  normalizeHttpBaseUrl,
  normalizeRequestTimeoutMs,
  normalizeRequiredStringConfig,
  parseJsonResponse,
  readErrorResponseBody
} from "./request-utils.js";

const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";

export type TavilySearchProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  searchDepth?: "basic" | "advanced" | "fast" | "ultra-fast";
  includeRawContent?: boolean | "markdown" | "text";
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
};

const tavilyResultSchema = z.object({
  title: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  raw_content: z.string().nullable().optional(),
  score: z.number().nullable().optional()
});

const tavilyResponseSchema = z.object({
  results: z.array(tavilyResultSchema).default([])
});

export function createTavilySearchProvider(options: TavilySearchProviderOptions = {}): SearchProvider {
  const apiKey = normalizeApiKey(options.apiKey ?? process.env.TAVILY_API_KEY, "TAVILY_API_KEY is required for --search tavily.");
  const baseUrl = normalizeHttpBaseUrl(options.baseUrl ?? process.env.TAVILY_BASE_URL ?? DEFAULT_TAVILY_BASE_URL, "Tavily baseUrl");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = normalizeRequestTimeoutMs(options.timeoutMs);

  return {
    name: "tavily",
    async search(query) {
      const request = normalizeSearchRequest(query.query, query.maxResults);
      if (!request) {
        return [];
      }

      const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: request.query,
          max_results: request.maxResults,
          search_depth: options.searchDepth ?? "basic",
          include_raw_content: options.includeRawContent ?? false,
          include_answer: false,
          include_images: false
        })
      }, {
        timeoutMs,
        timeoutMessage: `Tavily search timed out after ${timeoutMs} ms.`,
        failureMessage: "Tavily search request failed",
        redact: redactSecrets
      });

      if (!response.ok) {
        const body = await readErrorResponseBody(response, redactSecrets);
        throw new Error(`Tavily search returned ${response.status}: ${body}`);
      }

      const parsed = await parseJsonResponse(response, tavilyResponseSchema, "Tavily search");

      return parsed.results
        .map((result, index): SearchResult | undefined => {
          const url = normalizeHttpUrl(result.url);
          if (!url) {
            return undefined;
          }

          const rank = index + 1;
          const title = normalizeOptionalText(result.title, { collapseWhitespace: true }) ?? url;
          const content = normalizeOptionalText(result.content, { collapseWhitespace: true });
          const rawContent = normalizeOptionalText(result.raw_content);
          const snippet = content ?? rawContent ?? "";
          if (snippet.length === 0) {
            return undefined;
          }
          const score = finiteNumber(result.score);

          return {
            id: `tavily-${query.claimId}-${rank}`,
            title,
            url,
            retrievedAt: now().toISOString(),
            snippet,
            text: rawContent ?? content,
            retrieval: score === undefined ? undefined : { score },
            provider: "tavily",
            rank,
            query: request.query
          };
        })
        .filter((result): result is SearchResult => result !== undefined);
    }
  };
}

function redactSecrets(value: string): string {
  return value.replace(/tvly-[A-Za-z0-9_-]+/g, "tvly-***");
}

function normalizeApiKey(value: string | undefined, message: string): string {
  try {
    return normalizeRequiredStringConfig(value, "apiKey");
  } catch {
    throw new Error(message);
  }
}
