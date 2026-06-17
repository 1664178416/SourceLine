const MAX_CLI_ERROR_MESSAGE_CHARS = 2_000;
const TRUNCATION_MARKER = "... [truncated]";

export function formatCliError(error: unknown, options: { debug?: boolean } = {}): string {
  const message = formatErrorMessage(error);
  const lines = [`SourceLine error: ${message}`];

  if (options.debug && error instanceof Error && error.stack) {
    lines.push("", error.stack);
  } else {
    lines.push("Run with SOURCELINE_DEBUG=1 for a stack trace.");
  }

  return `${lines.join("\n")}\n`;
}

function formatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const formatted = stripAnsi(message)
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .trim();

  return formatted.length > 0 ? truncateText(formatted, MAX_CLI_ERROR_MESSAGE_CHARS) : "Unknown error.";
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= TRUNCATION_MARKER.length) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}
