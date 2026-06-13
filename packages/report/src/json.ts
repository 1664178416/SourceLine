import type { SourceLineReport } from "@sourceline/core";
import { sanitizeReport } from "./sanitize.js";

export function renderJsonReport(report: SourceLineReport): string {
  return `${JSON.stringify(sanitizeReport(report), null, 2)}\n`;
}
