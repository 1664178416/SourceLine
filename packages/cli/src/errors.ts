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

  return formatted.length > 0 ? formatted : "Unknown error.";
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}