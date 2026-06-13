import {
  failOnSchema,
  llmProviderSchema,
  reportFormatSchema,
  searchProviderSchema,
  type FailOnLevel,
  type LlmProviderName,
  type ReportFormat,
  type SearchProviderName,
  type SourceLineConfig
} from "./schema.js";

export type CheckFlagValues = {
  provider?: string;
  baseUrl?: string;
  model?: string;
  search?: string;
  sources?: string;
  report?: string;
  maxClaims?: string;
  maxResults?: string;
  minConfidence?: string;
  failOn?: string;
  providerTimeoutMs?: string;
};

export type CheckEnvironment = {
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  SOURCELINE_LLM_PROVIDER?: string;
  SOURCELINE_SEARCH_PROVIDER?: string;
  SOURCELINE_SOURCES?: string;
  SOURCELINE_REPORT_FORMAT?: string;
  SOURCELINE_MAX_CLAIMS?: string;
  SOURCELINE_MAX_RESULTS?: string;
  SOURCELINE_MIN_CONFIDENCE?: string;
  SOURCELINE_FAIL_ON?: string;
  SOURCELINE_PROVIDER_TIMEOUT_MS?: string;
};

export type ResolvedCheckSettings = {
  llmProvider: LlmProviderName;
  baseUrl?: string;
  model?: string;
  searchProvider: SearchProviderName;
  sources?: string;
  reportFormat: ReportFormat;
  maxClaims: number;
  maxResultsPerClaim: number;
  minConfidence: number;
  failOn: FailOnLevel;
  providerTimeoutMs: number;
};

export function resolveCheckSettings(options: {
  flags: CheckFlagValues;
  config?: SourceLineConfig;
  env?: CheckEnvironment;
}): ResolvedCheckSettings {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const flags = options.flags;
  const sources = parseOptionalNonEmptyString(flags.sources ?? config.search?.sources ?? env.SOURCELINE_SOURCES, "sources");
  const searchProvider = parseSearchProvider(
    flags.search ?? config.search?.provider ?? env.SOURCELINE_SEARCH_PROVIDER ?? (sources ? "local" : "mock")
  );

  return {
    llmProvider: parseLlmProvider(flags.provider ?? config.llm?.provider ?? env.SOURCELINE_LLM_PROVIDER ?? "mock"),
    baseUrl: parseOptionalHttpUrl(flags.baseUrl ?? config.llm?.baseUrl ?? env.OPENAI_BASE_URL, "baseUrl"),
    model: parseOptionalNonEmptyString(flags.model ?? config.llm?.model ?? env.OPENAI_MODEL, "model"),
    searchProvider,
    sources,
    reportFormat: parseReportFormat(flags.report ?? config.reports?.defaultFormat ?? env.SOURCELINE_REPORT_FORMAT ?? "terminal"),
    maxClaims: parsePositiveInteger(flags.maxClaims ?? config.checks?.maxClaims ?? env.SOURCELINE_MAX_CLAIMS, 30, "maxClaims"),
    maxResultsPerClaim: parsePositiveInteger(
      flags.maxResults ?? config.search?.maxResultsPerClaim ?? env.SOURCELINE_MAX_RESULTS,
      5,
      "maxResultsPerClaim"
    ),
    minConfidence: parseConfidence(flags.minConfidence ?? config.checks?.minConfidence ?? env.SOURCELINE_MIN_CONFIDENCE, 0.65),
    failOn: parseFailOn(flags.failOn ?? config.checks?.failOn ?? env.SOURCELINE_FAIL_ON ?? "never"),
    providerTimeoutMs: parsePositiveInteger(
      flags.providerTimeoutMs ?? config.providers?.timeoutMs ?? env.SOURCELINE_PROVIDER_TIMEOUT_MS,
      30_000,
      "providerTimeoutMs"
    )
  };
}

function parseOptionalNonEmptyString(value: string | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return trimmed;
}

function parseOptionalHttpUrl(value: string | undefined, label: string): string | undefined {
  const trimmed = parseOptionalNonEmptyString(value, label);
  if (trimmed === undefined) {
    return undefined;
  }
  if (hasControlCharacters(trimmed)) {
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

  return url.toString();
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function normalizeEnumValue(value: string): string {
  return value.trim().toLowerCase();
}
function parseLlmProvider(value: string): LlmProviderName {
  const normalized = normalizeEnumValue(value);
  const parsed = llmProviderSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(`Unsupported LLM provider "${value}". Use mock or openai.`);
  }
  return parsed.data;
}

function parseSearchProvider(value: string): SearchProviderName {
  const normalized = normalizeEnumValue(value);
  const parsed = searchProviderSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(`Unsupported search provider "${value}". Use mock, local, tavily, or brave.`);
  }
  return parsed.data;
}

function parseReportFormat(value: string): ReportFormat {
  const normalized = normalizeEnumValue(value);
  const parsed = reportFormatSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(`Unsupported report format "${value}". Use terminal, markdown, json, or html.`);
  }
  return parsed.data;
}

function parseFailOn(value: string): FailOnLevel {
  const normalized = normalizeEnumValue(value);
  const parsed = failOnSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(`Unsupported fail-on level "${value}". Use never, review, unsupported, or contradicted.`);
  }
  return parsed.data;
}

function parsePositiveInteger(value: string | number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${label} must be a positive integer.`);
    }
    return value;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a positive integer.`);
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

function parseConfidence(value: string | number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error("minConfidence must be a number between 0 and 1.");
    }
    return value;
  }

  const trimmed = value.trim();
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(trimmed)) {
    throw new Error("minConfidence must be a number between 0 and 1.");
  }

  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("minConfidence must be a number between 0 and 1.");
  }

  return parsed;
}
