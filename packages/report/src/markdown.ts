import type { ClaimCheck, EvidenceItem, SourceLineReport } from "@sourceline/core";
import { sanitizeReport } from "./sanitize.js";
import { isCredentiallessHttpUrl } from "./url-safety.js";

export function renderMarkdownReport(report: SourceLineReport): string {
  report = sanitizeReport(report);
  const lines: string[] = [
    "# SourceLine Report",
    "",
    `Input: ${escapeMarkdownInline(report.input.name ?? report.input.kind)}`,
    `Generated: ${escapeMarkdownInline(report.generatedAt)}`,
    `Input hash: ${formatCodeSpan(report.input.hash)}`,
    "",
    "## Summary",
    "",
    `- Claims found: ${report.summary.totalClaims}`,
    `- Supported: ${report.summary.supported}`,
    `- Partially supported: ${report.summary.partiallySupported}`,
    `- Unsupported: ${report.summary.unsupported}`,
    `- Contradicted: ${report.summary.contradicted}`,
    `- Not enough evidence: ${report.summary.notEnoughEvidence}`,
    "",
    "## Claims",
    ""
  ];

  if (report.checks.length === 0) {
    lines.push("No factual claims were detected.");
    return `${lines.join("\n")}\n`;
  }

  report.checks.forEach((check, index) => {
    lines.push(...renderClaimCheck(check, index + 1));
  });

  return `${lines.join("\n")}\n`;
}

function renderClaimCheck(check: ClaimCheck, index: number): string[] {
  const lines: string[] = [
    `### ${index}. ${escapeMarkdownInline(check.claim.text)}`,
    "",
    `Status: ${formatCodeSpan(check.status)}`,
    `Confidence: ${formatConfidence(check.confidence)}`,
    `Type: ${formatCodeSpan(check.claim.claimType)}`,
    `Importance: ${formatCodeSpan(check.claim.importance)}`,
    "",
    "Evidence:",
    ""
  ];

  if (check.evidence.length === 0) {
    lines.push("- No evidence available.");
  } else {
    check.evidence.forEach((evidence) => {
      lines.push(renderEvidence(evidence));
    });
  }

  lines.push("", "Explanation:", "", formatMarkdownParagraph(check.explanation), "");

  if (check.riskFlags.length > 0) {
    lines.push("Risk flags:", "");
    check.riskFlags.forEach((flag) => lines.push(`- ${formatCodeSpan(flag)}`));
    lines.push("");
  }

  return lines;
}

function renderEvidence(evidence: EvidenceItem): string {
  const title = evidence.source.title ?? evidence.source.url ?? evidence.source.path ?? evidence.source.id;
  const location = evidence.source.url ?? evidence.source.path;
  const linkDestination = location ? formatLinkDestination(location) : undefined;
  const linkedTitle = linkDestination ? `[${escapeMarkdownInline(title)}](${linkDestination})` : escapeMarkdownInline(title);
  const retrieval = renderRetrieval(evidence);
  const snippet = evidence.source.snippet ? ` - ${escapeMarkdownInline(evidence.source.snippet)}` : "";

  return `- ${linkedTitle} (${evidence.relation}, ${formatConfidence(evidence.confidence)}${retrieval})${snippet}`;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\[\]])/g, "\\$1");
}

function escapeMarkdownInline(value: string): string {
  return escapeMarkdown(normalizeMarkdownInline(value));
}

function formatMarkdownParagraph(value: string): string {
  return escapeMarkdownInline(value) || "(empty explanation)";
}

function formatCodeSpan(value: string): string {
  const text = normalizeMarkdownInline(value);
  const longestBacktickRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const delimiter = "`".repeat(longestBacktickRun + 1);
  const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;

  return `${delimiter}${padded}${delimiter}`;
}

function normalizeMarkdownInline(value: string): string {
  return stripAnsi(value)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function formatLinkDestination(value: string): string | undefined {
  const safeHref = formatSafeHref(value);
  if (!safeHref) {
    return undefined;
  }
  if (/^https?:\/\//i.test(safeHref) && !/[\s()<>]/.test(safeHref)) {
    return safeHref;
  }

  return `<${safeHref.replace(/\\/g, "/").replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
}

function formatSafeHref(value: string): string | undefined {
  const trimmed = value.trim();
  if (hasHrefControlCharacters(trimmed)) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return /[\s<>]/.test(trimmed) || !isCredentiallessHttpUrl(trimmed) ? undefined : trimmed;
  }
  if (!trimmed.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return trimmed;
  }

  return undefined;
}

function hasHrefControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function formatConfidence(value: number): string {
  if (!Number.isFinite(value)) {
    return "0.00";
  }

  return Math.min(1, Math.max(0, value)).toFixed(2);
}

function formatFiniteNumber(value: number, fractionDigits: number): string | undefined {
  return Number.isFinite(value) ? value.toFixed(fractionDigits) : undefined;
}

function renderRetrieval(evidence: EvidenceItem): string {
  const retrieval = evidence.source.retrieval;
  if (!retrieval) {
    return "";
  }

  const parts: string[] = [];
  const score = retrieval.score !== undefined ? formatFiniteNumber(retrieval.score, 3) : undefined;
  if (score) {
    parts.push(`score ${score}`);
  }
  if (retrieval.matchedTerms && retrieval.matchedTerms.length > 0) {
    parts.push(`matched ${retrieval.matchedTerms.map(escapeMarkdownInline).join(", ")}`);
  }
  if (retrieval.explanation) {
    parts.push(escapeMarkdownInline(retrieval.explanation));
  }

  return parts.length > 0 ? `; ${parts.join("; ")}` : "";
}
