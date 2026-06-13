import type { ClaimCheck, SourceLineReport } from "@sourceline/core";
import { sanitizeReport } from "./sanitize.js";

export function renderTerminalReport(report: SourceLineReport): string {
  report = sanitizeReport(report);
  const reviewItems = report.checks.filter(shouldShowInReview);
  const inputName = formatTerminalLine(report.input.name ?? report.input.kind) || report.input.kind;
  const lines: string[] = [
    "SourceLine Report",
    `Input: ${inputName}`,
    `Claims: ${report.summary.totalClaims} | Supported: ${report.summary.supported} | Partial: ${report.summary.partiallySupported} | Unsupported: ${report.summary.unsupported} | Review: ${reviewItems.length}`,
    ""
  ];

  if (reviewItems.length > 0) {
    lines.push("Needs review:");
    reviewItems.slice(0, 8).forEach((check) => {
      lines.push(`- [${check.status}] ${formatTerminalLine(check.claim.text) || "(empty claim)"}`);
    });
  } else if (report.checks.length === 0) {
    lines.push("No factual claims were detected.");
  } else {
    lines.push("No unsupported or evidence-limited claims in this run.");
  }

  return `${lines.join("\n")}\n`;
}

function formatTerminalLine(value: string): string {
  return stripAnsi(value)
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .trim();
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
