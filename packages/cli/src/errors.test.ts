import { describe, expect, it } from "vitest";
import { formatCliError } from "./errors.js";

describe("formatCliError", () => {
  it("formats user-facing errors without a stack by default", () => {
    const output = formatCliError(new Error("Unsupported report format."));

    expect(output).toContain("SourceLine error: Unsupported report format.");
    expect(output).toContain("SOURCELINE_DEBUG=1");
    expect(output).not.toContain("Error: Unsupported report format.");
  });

  it("includes a stack trace in debug mode", () => {
    const error = new Error("Boom");
    const output = formatCliError(error, { debug: true });

    expect(output).toContain("SourceLine error: Boom");
    expect(output).toContain("Error: Boom");
  });

  it("keeps non-debug error messages on a safe single terminal line", () => {
    const output = formatCliError(new Error("Bad\n\u001b[31mred\u001b[0m\u0007 message"));

    expect(output).toContain("SourceLine error: Bad red message");
    expect(output).not.toContain("\u001b[31m");
    expect(output).not.toContain("\u0007");
    expect(output.split("\n")[0]).toBe("SourceLine error: Bad red message");
  });

  it("falls back for empty error messages", () => {
    const output = formatCliError(new Error("\n\t"));

    expect(output).toContain("SourceLine error: Unknown error.");
  });

  it("truncates oversized non-debug error messages", () => {
    const output = formatCliError(new Error(`${"x".repeat(2_500)} secret-tail`));
    const firstLine = output.split("\n")[0] ?? "";

    expect(firstLine).toHaveLength("SourceLine error: ".length + 2_000);
    expect(firstLine).toMatch(/\.\.\. \[truncated\]$/);
    expect(firstLine).not.toContain("secret-tail");
  });
});
