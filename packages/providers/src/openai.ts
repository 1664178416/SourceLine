import type {
  Claim,
  ClaimCheck,
  EvidenceItem,
  EvidenceRelation,
  ExtractClaimsInput,
  LlmProvider,
  RiskFlag,
  SearchResult,
  VerificationStatus
} from "@sourceline/core";
import { z } from "zod";
import {
  fetchWithTimeout,
  normalizeHttpBaseUrl,
  normalizeRequestTimeoutMs,
  normalizeRequiredStringConfig,
  parseJsonResponse,
  readErrorResponseBody
} from "./request-utils.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.5-openai-compact";

export type OpenAiProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const claimTypeSchema = z.enum([
  "statistical",
  "historical",
  "scientific",
  "legal_or_policy",
  "biographical",
  "technical",
  "general_factual"
]);

const importanceSchema = z.enum(["high", "medium", "low"]);
const normalizedNonEmptyStringSchema = z
  .string()
  .transform((value) => normalizeText(value))
  .pipe(z.string().min(1));
const normalizedSearchQueriesSchema = z
  .array(z.string())
  .optional()
  .transform((queries) => (queries ?? []).map((query) => normalizeText(query)).filter((query) => query.length > 0));

const extractedClaimSchema = z.object({
  text: normalizedNonEmptyStringSchema,
  sourceStartLine: z.number().int().positive().optional(),
  sourceEndLine: z.number().int().positive().optional(),
  quote: z.string().optional(),
  claimType: claimTypeSchema.default("general_factual"),
  importance: importanceSchema.default("medium"),
  searchQueries: normalizedSearchQueriesSchema
});

const extractClaimsSchema = z.object({
  claims: z.array(extractedClaimSchema)
});

const verificationStatusSchema = z.enum([
  "supported",
  "partially_supported",
  "unsupported",
  "contradicted",
  "not_enough_evidence"
]);

const evidenceRelationSchema = z.enum([
  "supports",
  "partially_supports",
  "contradicts",
  "related",
  "irrelevant"
]);

const riskFlagSchema = z.enum([
  "no_source_found",
  "weak_source",
  "stale_source",
  "source_paywalled",
  "ambiguous_claim",
  "overgeneralized_claim",
  "requires_expert_review"
]);

const evidenceDecisionSchema = z.object({
  sourceId: normalizedNonEmptyStringSchema,
  relation: evidenceRelationSchema,
  confidence: z.number().min(0).max(1),
  quotedSupport: z.string().optional().transform((value) => (value === undefined ? undefined : normalizeText(value))),
  explanation: normalizedNonEmptyStringSchema
});

const verifyClaimSchema = z.object({
  status: verificationStatusSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceDecisionSchema).default([]),
  explanation: normalizedNonEmptyStringSchema,
  riskFlags: z.array(riskFlagSchema).default([])
});

const chatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().optional()
          })
          .optional()
      })
    )
    .optional()
});

export function createOpenAiProvider(options: OpenAiProviderOptions = {}): LlmProvider {
  const apiKey = normalizeApiKey(options.apiKey ?? process.env.OPENAI_API_KEY, "OPENAI_API_KEY is required for --provider openai.");
  const baseUrl = normalizeHttpBaseUrl(options.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL, "OpenAI baseUrl");
  const model = normalizeRequiredStringConfig(options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL, "OpenAI model");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = normalizeRequestTimeoutMs(options.timeoutMs);

  return {
    name: "openai",
    async extractClaims(input) {
      const parsed = await chatJsonWithSchema({
        apiKey,
        baseUrl,
        fetchImpl,
        model,
        timeoutMs,
        messages: buildExtractMessages(input),
        schema: extractClaimsSchema,
        label: "extract claims"
      });

      return {
        claims: parsed.claims.slice(0, input.maxClaims).map((claim, index): Claim => {
          const text = normalizeText(claim.text);

          return {
            id: `claim-${index + 1}`,
            text,
            sourceSpan: {
              startLine: claim.sourceStartLine,
              endLine: claim.sourceEndLine,
              quote: claim.quote ?? text
            },
            claimType: claim.claimType,
            importance: claim.importance,
            searchQueries: claim.searchQueries.length > 0 ? claim.searchQueries : [text]
          };
        })
      };
    },
    async verifyClaim(input) {
      if (input.evidence.length === 0) {
        return noEvidenceCheck(input.claim);
      }

      const parsed = await chatJsonWithSchema({
        apiKey,
        baseUrl,
        fetchImpl,
        model,
        timeoutMs,
        messages: buildVerifyMessages(input.claim, input.evidence, input.minConfidence),
        schema: verifyClaimSchema,
        label: "verify claim"
      });
      const usedSourceIds = new Set<string>();
      const evidence = parsed.evidence
        .map((item): EvidenceItem | undefined => {
          const source = input.evidence.find((candidate) => candidate.id === item.sourceId);
          if (!source || usedSourceIds.has(source.id)) {
            return undefined;
          }
          usedSourceIds.add(source.id);

          return {
            source,
            relation: item.relation,
            confidence: roundConfidence(item.confidence),
            quotedSupport: item.quotedSupport && item.quotedSupport.length > 0 ? item.quotedSupport : undefined,
            explanation: item.explanation
          };
        })
        .filter((item): item is EvidenceItem => item !== undefined);

      return {
        claim: input.claim,
        status: parsed.status,
        confidence: roundConfidence(parsed.confidence),
        evidence,
        explanation: parsed.explanation,
        riskFlags: parsed.riskFlags
      };
    }
  };
}

async function chatJsonWithSchema<T>(options: {
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  model: string;
  timeoutMs: number;
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  label: string;
}): Promise<T> {
  let lastContent = "";
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages =
      attempt === 0
        ? options.messages
        : [
            ...options.messages,
            {
              role: "assistant" as const,
              content: lastContent.slice(0, 4000)
            },
            {
              role: "user" as const,
              content: `The previous response was invalid for ${options.label}. Return only valid JSON that matches the requested schema. Validation error: ${formatValidationError(lastError)}`
            }
          ];

    lastContent = await chatJson({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      model: options.model,
      timeoutMs: options.timeoutMs,
      messages
    });

    try {
      return parseJsonWithSchema(lastContent, options.schema);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`OpenAI-compatible provider returned invalid JSON for ${options.label}: ${formatValidationError(lastError)}`);
}

async function chatJson(options: {
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  model: string;
  timeoutMs: number;
  messages: ChatMessage[];
}): Promise<string> {
  const response = await fetchWithTimeout(options.fetchImpl, `${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      response_format: {
        type: "json_object"
      }
    })
  }, {
    timeoutMs: options.timeoutMs,
    timeoutMessage: `OpenAI-compatible provider timed out after ${options.timeoutMs} ms.`,
    failureMessage: "OpenAI-compatible provider request failed",
    redact: redactSecrets
  });

  if (!response.ok) {
    const body = await readErrorResponseBody(response, redactSecrets);
    throw new Error(`OpenAI-compatible provider returned ${response.status}: ${body}`);
  }

  const json = await parseJsonResponse(response, chatCompletionSchema, "OpenAI-compatible provider");
  const content = json.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI-compatible provider returned no message content.");
  }

  return content;
}

function buildExtractMessages(input: ExtractClaimsInput): ChatMessage[] {
  const segmentText = input.segments
    .map((segment) => `[${segment.id}, lines ${segment.startLine}-${segment.endLine}]\n${segment.text}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        "You extract factual claims for verification. Return only valid JSON. Do not include markdown. Ignore opinions, instructions, headings, and vague claims."
    },
    {
      role: "user",
      content: `Extract up to ${input.maxClaims} factual claims from the document segments below.

Return this exact JSON shape:
{
  "claims": [
    {
      "text": "claim text",
      "sourceStartLine": 1,
      "sourceEndLine": 1,
      "quote": "short original quote",
      "claimType": "statistical|historical|scientific|legal_or_policy|biographical|technical|general_factual",
      "importance": "high|medium|low",
      "searchQueries": ["query 1", "query 2"]
    }
  ]
}

Rules:
- A claim must be checkable against sources.
- Preserve the original meaning.
- Prefer precise, source-searchable wording.
- Keep searchQueries short and specific.
- If no factual claims exist, return {"claims":[]}.

Segments:
${segmentText}`
    }
  ];
}

function buildVerifyMessages(claim: Claim, evidence: SearchResult[], minConfidence: number): ChatMessage[] {
  const evidenceText = evidence
    .map((source) => {
      const title = normalizeText(source.title ?? "Untitled") || "Untitled";
      const location = normalizeText(source.url ?? source.path ?? "N/A") || "N/A";
      const snippet = normalizeText(source.snippet ?? source.text ?? "");

      return `Source ID: ${source.id}
Title: ${title}
URL: ${location}
Snippet: ${snippet}`;
    })
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        "You verify one factual claim against provided evidence. Return only valid JSON. Be conservative. Do not assume a source supports a claim unless the evidence snippet directly supports it."
    },
    {
      role: "user",
      content: `Claim:
${normalizeText(claim.text)}

Minimum confidence threshold: ${minConfidence}

Evidence:
${evidenceText}

Return this exact JSON shape:
{
  "status": "supported|partially_supported|unsupported|contradicted|not_enough_evidence",
  "confidence": 0.0,
  "evidence": [
    {
      "sourceId": "source id from the provided evidence",
      "relation": "supports|partially_supports|contradicts|related|irrelevant",
      "confidence": 0.0,
      "quotedSupport": "short quote or snippet only if available",
      "explanation": "brief reason"
    }
  ],
  "explanation": "brief overall reason",
  "riskFlags": ["no_source_found|weak_source|stale_source|source_paywalled|ambiguous_claim|overgeneralized_claim|requires_expert_review"]
}

Rules:
- Use only the provided evidence.
- If evidence is mock, synthetic, too vague, or only loosely related, use partially_supported or not_enough_evidence.
- Use unsupported when evidence does not support the claim.
- Use contradicted only when evidence clearly conflicts with the claim.
- Keep confidence between 0 and 1.`
    }
  ];
}

function parseJsonWithSchema<T>(content: string, schema: z.ZodType<T>): T {
  let lastError: unknown;

  try {
    return schema.parse(JSON.parse(content));
  } catch (error) {
    lastError = error;
  }

  const candidates = extractJsonObjectCandidates(content);
  if (candidates.length === 0) {
    throw new Error("Provider response was not valid JSON.");
  }

  for (const candidate of candidates) {
    try {
      return schema.parse(JSON.parse(candidate));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function extractJsonObjectCandidates(content: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (depth === 0) {
      if (char === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function formatValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function noEvidenceCheck(claim: Claim): ClaimCheck {
  return {
    claim,
    status: "not_enough_evidence",
    confidence: 0.2,
    evidence: [],
    explanation: "No evidence was retrieved for this claim.",
    riskFlags: ["no_source_found"]
  };
}

function normalizeText(text: string): string {
  return stripAnsi(text)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function roundConfidence(confidence: number): number {
  return Math.round(confidence * 100) / 100;
}

function redactSecrets(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
}

function normalizeApiKey(value: string | undefined, message: string): string {
  try {
    return normalizeRequiredStringConfig(value, "apiKey");
  } catch {
    throw new Error(message);
  }
}
