import type { ClaimCheck, SourceLineReport } from "./types.js";

export function summarizeChecks(checks: ClaimCheck[]): SourceLineReport["summary"] {
  return {
    totalClaims: checks.length,
    supported: checks.filter((check) => check.status === "supported").length,
    partiallySupported: checks.filter((check) => check.status === "partially_supported").length,
    unsupported: checks.filter((check) => check.status === "unsupported").length,
    contradicted: checks.filter((check) => check.status === "contradicted").length,
    notEnoughEvidence: checks.filter((check) => check.status === "not_enough_evidence").length
  };
}
