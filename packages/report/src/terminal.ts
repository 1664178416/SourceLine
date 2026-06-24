import type { ClaimCheck, SourceLineReport } from "@sourceline/core";
import { sanitizeReport } from "./sanitize.js";

const MAX_TERMINAL_LINE_TEXT_CHARS = 240;
const TRUNCATION_MARKER = "... [truncated]";

export function renderTerminalReport(report: SourceLineReport): string {
  report = sanitizeReport(report);
  const reviewItems = report.checks.filter(shouldShowInReview);
  const shownReviewItems = reviewItems.slice(0, 8);
  const omittedReviewItems = reviewItems.length - shownReviewItems.length;
  const inputName = formatTerminalLine(report.input.name ?? report.input.kind) || report.input.kind;
  const lines: string[] = [
    "SourceLine Report",
    `Input: ${inputName}`,
    `Claims: ${report.summary.totalClaims} | Review: ${reviewItems.length}`,
    `Status: Supported ${report.summary.supported} | Partial ${report.summary.partiallySupported} | Unsupported ${report.summary.unsupported} | Contradicted ${report.summary.contradicted} | No Evidence ${report.summary.notEnoughEvidence}`,
    ""
  ];

  if (reviewItems.length > 0) {
    lines.push("Needs review:");
    shownReviewItems.forEach((check) => {
      lines.push(`- [${check.status}] ${formatTerminalLine(check.claim.text) || "(empty claim)"}`);
    });
    if (omittedReviewItems > 0) {
      lines.push(`- ... ${omittedReviewItems} more claim${omittedReviewItems === 1 ? "" : "s"} omitted from terminal summary`);
    }
  } else if (report.checks.length === 0) {
    lines.push("No factual claims were detected.");
  } else {
    lines.push("No unsupported or evidence-limited claims in this run.");
  }

  return `${lines.join("\n")}\n`;
}

function formatTerminalLine(value: string): string {
  const normalized = stripAnsi(value)
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .trim();
  if (normalized.length <= MAX_TERMINAL_LINE_TEXT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TERMINAL_LINE_TEXT_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function shouldShowInReview(check: ClaimCheck): boolean {
  return (
    check.status === "unsupported" ||
    check.status === "contradicted" ||
    check.status === "not_enough_evidence" ||
    check.status === "partially_supported"
  );
}
