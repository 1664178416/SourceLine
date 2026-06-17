import { z } from "zod";

export const llmProviderSchema = z.enum(["mock", "openai"]);
export const searchProviderSchema = z.enum(["mock", "local", "tavily", "brave"]);
export const reportFormatSchema = z.enum(["terminal", "markdown", "json", "html"]);
export const failOnSchema = z.enum(["never", "review", "unsupported", "contradicted"]);
export const MAX_CLAIMS = 100;
export const MAX_RESULTS_PER_CLAIM = 20;
export const MAX_PROVIDER_TIMEOUT_MS = 300_000;
export const MAX_CONFIG_STRING_CHARS = 2_000;

const normalizedLlmProviderSchema = normalizeEnumSchema(llmProviderSchema);
const normalizedSearchProviderSchema = normalizeEnumSchema(searchProviderSchema);
const normalizedReportFormatSchema = normalizeEnumSchema(reportFormatSchema);
const normalizedFailOnSchema = normalizeEnumSchema(failOnSchema);
const nonEmptyStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CONFIG_STRING_CHARS)
  .refine((value) => !hasControlCharacters(value), "Invalid string: must not contain control characters");
const httpUrlStringSchema = z
  .string()
  .trim()
  .max(MAX_CONFIG_STRING_CHARS)
  .url()
  .refine((value) => !hasControlCharacters(value), "Invalid URL: must not contain control characters")
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  }, "Invalid URL protocol: expected http or https")
  .refine((value) => {
    const url = new URL(value);
    return url.username.length === 0 && url.password.length === 0;
  }, "Invalid URL: base URL must not include username or password")
  .refine((value) => {
    const url = new URL(value);
    return url.search.length === 0 && url.hash.length === 0;
  }, "Invalid URL: base URL must not include query strings or fragments");
const positiveIntegerSchema = z.number().int().positive();
const maxClaimsSchema = positiveIntegerSchema.max(MAX_CLAIMS);
const maxResultsPerClaimSchema = positiveIntegerSchema.max(MAX_RESULTS_PER_CLAIM);
const providerTimeoutMsSchema = positiveIntegerSchema.max(MAX_PROVIDER_TIMEOUT_MS);
const confidenceSchema = z.number().min(0).max(1);

export const sourceLineConfigSchema = z
  .object({
    llm: z
      .object({
        provider: normalizedLlmProviderSchema.optional(),
        baseUrl: httpUrlStringSchema.optional(),
        model: nonEmptyStringSchema.optional()
      })
      .strict()
      .optional(),
    search: z
      .object({
        provider: normalizedSearchProviderSchema.optional(),
        sources: nonEmptyStringSchema.optional(),
        maxResultsPerClaim: maxResultsPerClaimSchema.optional()
      })
      .strict()
      .optional(),
    checks: z
      .object({
        maxClaims: maxClaimsSchema.optional(),
        minConfidence: confidenceSchema.optional(),
        failOn: normalizedFailOnSchema.optional()
      })
      .strict()
      .optional(),
    providers: z
      .object({
        timeoutMs: providerTimeoutMsSchema.optional()
      })
      .strict()
      .optional(),
    reports: z
      .object({
        defaultFormat: normalizedReportFormatSchema.optional()
      })
      .strict()
      .optional()
  })
  .strict();

function normalizeEnumSchema<T extends z.ZodEnum>(schema: T) {
  return z.preprocess((value) => (typeof value === "string" ? value.trim().toLowerCase() : value), schema);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export type LlmProviderName = z.infer<typeof llmProviderSchema>;
export type SearchProviderName = z.infer<typeof searchProviderSchema>;
export type ReportFormat = z.infer<typeof reportFormatSchema>;
export type FailOnLevel = z.infer<typeof failOnSchema>;
export type SourceLineConfig = z.infer<typeof sourceLineConfigSchema>;
