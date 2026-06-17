import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  loadConfig,
  MAX_CLAIMS,
  MAX_PROVIDER_TIMEOUT_MS,
  MAX_RESULTS_PER_CLAIM,
  resolveCheckSettings,
  type ResolvedCheckSettings
} from "@sourceline/config";
import {
  MAX_INPUT_BYTES,
  runCheck,
  type ClaimCheck,
  type InputDescriptor,
  type LlmProvider,
  type SearchProvider,
  type SourceLineReport
} from "@sourceline/core";
import {
  createBraveSearchProvider,
  createLocalSearchProvider,
  createMockLlmProvider,
  createMockSearchProvider,
  createOpenAiProvider,
  createTavilySearchProvider
} from "@sourceline/providers";
import { renderHtmlReport, renderJsonReport, renderMarkdownReport, renderTerminalReport } from "@sourceline/report";
import type { Command } from "commander";
import pc from "picocolors";

type CheckCommandOptions = {
  json?: boolean;
  config?: string;
  report?: string;
  out?: string;
  provider?: string;
  baseUrl?: string;
  model?: string;
  search?: string;
  sources?: string;
  maxClaims?: string;
  maxResults?: string;
  minConfidence?: string;
  failOn?: string;
  providerTimeoutMs?: string;
  yes?: boolean;
};

const MAX_CLI_PATH_OR_URL_CHARS = 2_000;
const outputWriteLocks = new Map<string, Promise<void>>();

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .argument("[input]", "Markdown/txt/HTML file path, http(s) URL, or '-' for stdin")
    .description("Create a claim-by-claim evidence report")
    .option("--json", "Print the report as JSON")
    .option("--config <file>", "Path to sourceline.config.json")
    .option("--report <format>", "Report format: terminal, markdown, json, html")
    .option("--out <file>", "Write the rendered report to a file")
    .option("--provider <name>", "LLM provider to use: mock or openai")
    .option("--base-url <url>", "OpenAI-compatible base URL. Defaults to OPENAI_BASE_URL or https://api.openai.com/v1")
    .option("--model <model>", "OpenAI-compatible model. Defaults to OPENAI_MODEL or gpt-5.5-openai-compact")
    .option("--search <name>", "Search provider: mock, local, tavily, or brave")
    .option("--sources <dir>", "Use a local Markdown/txt/HTML source folder")
    .option("--max-claims <number>", `Maximum claims to extract (max ${MAX_CLAIMS})`)
    .option("--max-results <number>", `Maximum evidence results per claim (max ${MAX_RESULTS_PER_CLAIM})`)
    .option("--min-confidence <number>", "Minimum confidence threshold between 0 and 1")
    .option("--provider-timeout-ms <number>", `Remote provider request timeout in milliseconds (max ${MAX_PROVIDER_TIMEOUT_MS})`)
    .option("--fail-on <level>", "Exit with code 2 on: never, review, unsupported, or contradicted")
    .option("--yes", "Confirm cloud provider use in non-interactive runs")
    .action(async (input: string | undefined, options: CheckCommandOptions) => {
      await runCheckCommand(input, options);
    });
}

async function runCheckCommand(input: string | undefined, options: CheckCommandOptions): Promise<void> {
  const loadedConfig = await loadConfig({ configPath: options.config });
  const settings = resolveCheckSettings({
    flags: options,
    config: loadedConfig.config
  });
  const inputDescriptor = await resolveInput(input);
  await confirmCloudUse(settings, options);
  const llmProvider = createLlmProvider(settings);
  const searchProvider = createSearchProvider(settings);
  const report = await runCheck({
    input: inputDescriptor,
    llmProvider,
    searchProvider,
    maxClaims: settings.maxClaims,
    maxResultsPerClaim: settings.maxResultsPerClaim,
    minConfidence: settings.minConfidence
  });

  const format = options.json ? "json" : settings.reportFormat;
  const rendered = renderReport(format, report);

  if (options.out !== undefined) {
    const outputPath = await writeOutputFile(options.out, rendered);
    process.stdout.write(renderTerminalReport(report));
    process.stdout.write(`\n${pc.green("Full report:")} ${outputPath}\n`);
    applyFailOnGate(report, settings);
    return;
  }

  process.stdout.write(rendered);
  applyFailOnGate(report, settings);
}

async function confirmCloudUse(settings: ResolvedCheckSettings, options: CheckCommandOptions): Promise<void> {
  const cloudServices = [
    settings.llmProvider === "openai" ? "OpenAI-compatible LLM" : undefined,
    settings.searchProvider === "tavily" ? "Tavily Search" : undefined,
    settings.searchProvider === "brave" ? "Brave Search" : undefined
  ].filter((service): service is string => service !== undefined);

  if (cloudServices.length === 0 || options.yes || process.env.SOURCELINE_ALLOW_CLOUD === "1") {
    return;
  }

  const message = `SourceLine will send claim text and evidence snippets to: ${cloudServices.join(", ")}.`;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${message} Re-run with --yes or set SOURCELINE_ALLOW_CLOUD=1 to confirm.`);
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = await readline.question(`${message}\nContinue? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new Error("Cancelled.");
    }
  } finally {
    readline.close();
  }
}

function createLlmProvider(settings: ResolvedCheckSettings): LlmProvider {
  switch (settings.llmProvider) {
    case "mock":
      return createMockLlmProvider();
    case "openai":
      return createOpenAiProvider({
        baseUrl: settings.baseUrl,
        model: settings.model,
        timeoutMs: settings.providerTimeoutMs
      });
  }
}

function createSearchProvider(settings: ResolvedCheckSettings): SearchProvider {
  switch (settings.searchProvider) {
    case "mock":
      return createMockSearchProvider();
    case "local":
      if (!settings.sources) {
        throw new Error("--sources is required when using --search local.");
      }
      return createLocalSearchProvider({
        rootDir: settings.sources
      });
    case "tavily":
      return createTavilySearchProvider({
        timeoutMs: settings.providerTimeoutMs
      });
    case "brave":
      return createBraveSearchProvider({
        timeoutMs: settings.providerTimeoutMs
      });
  }
}

type ResolveInputOptions = {
  stdinIsTTY?: boolean;
  readStdin?: () => Promise<string>;
};

export async function resolveInput(input: string | undefined, options: ResolveInputOptions = {}): Promise<InputDescriptor> {
  const trimmedInput = input?.trim();

  if (trimmedInput && trimmedInput !== "-") {
    if (hasControlCharacters(trimmedInput)) {
      throw new Error("Input path or URL must not contain control characters.");
    }
    if (trimmedInput.length > MAX_CLI_PATH_OR_URL_CHARS) {
      throw new Error(`Input path or URL must be at most ${MAX_CLI_PATH_OR_URL_CHARS} characters.`);
    }
    if (isHttpUrl(trimmedInput)) {
      return {
        kind: "url",
        url: trimmedInput
      };
    }

    return {
      kind: "file",
      path: trimmedInput
    };
  }

  if (options.stdinIsTTY ?? process.stdin.isTTY === true) {
    throw new Error("No input provided. Pass a file path, URL, or pipe text into `sourceline check -`.");
  }

  const stdin = await (options.readStdin ?? readStdin)();
  if (new TextEncoder().encode(stdin).byteLength > MAX_INPUT_BYTES) {
    throw new Error(`Stdin input is larger than ${MAX_INPUT_BYTES} bytes.`);
  }
  if (stdin.trim().length === 0) {
    throw new Error("No input provided. Pass a file path, URL, or pipe text into `sourceline check -`.");
  }

  return {
    kind: "stdin",
    name: "stdin",
    text: stdin
  };
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function renderReport(format: string, report: Parameters<typeof renderTerminalReport>[0]): string {
  switch (format) {
    case "terminal":
      return renderTerminalReport(report);
    case "markdown":
      return renderMarkdownReport(report);
    case "json":
      return renderJsonReport(report);
    case "html":
      return renderHtmlReport(report);
    default:
      throw new Error(`Unsupported report format "${format}". Use terminal, markdown, json, or html.`);
  }
}

function applyFailOnGate(report: SourceLineReport, settings: ResolvedCheckSettings): void {
  const failures = report.checks.filter((check) => claimFailsGate(check, settings.failOn));
  if (failures.length === 0) {
    return;
  }

  process.exitCode = 2;
  process.stderr.write(
    `SourceLine gate failed: ${failures.length} claim${failures.length === 1 ? "" : "s"} matched --fail-on ${settings.failOn}.\n`
  );
}

export function claimFailsGate(check: Pick<ClaimCheck, "status">, failOn: ResolvedCheckSettings["failOn"]): boolean {
  switch (failOn) {
    case "never":
      return false;
    case "review":
      return check.status !== "supported";
    case "unsupported":
      return check.status === "unsupported" || check.status === "contradicted";
    case "contradicted":
      return check.status === "contradicted";
  }
}

export async function writeOutputFile(path: string, content: string): Promise<string> {
  const outputPath = normalizeOutputPath(path);
  return withOutputPathLock(outputPath, async () => {
    await ensureOutputDirectory(outputPath);
    await assertOutputFilePath(outputPath);
    const tempPath = `${outputPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;

    try {
      await writeFile(tempPath, content, "utf8");
      await rename(tempPath, outputPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return outputPath;
  });
}

async function withOutputPathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = outputWriteLocks.get(path) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const token = previous.catch(() => undefined).then(() => current);

  outputWriteLocks.set(path, token);
  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (outputWriteLocks.get(path) === token) {
      outputWriteLocks.delete(path);
    }
  }
}

function normalizeOutputPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new Error("--out must not be empty.");
  }
  if (hasControlCharacters(trimmed)) {
    throw new Error("--out must not contain control characters.");
  }
  if (trimmed.length > MAX_CLI_PATH_OR_URL_CHARS) {
    throw new Error(`--out must be at most ${MAX_CLI_PATH_OR_URL_CHARS} characters.`);
  }
  if (/[\\/]$/.test(trimmed)) {
    throw new Error("--out must be a file path, not a directory.");
  }

  return trimmed;
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

async function ensureOutputDirectory(path: string): Promise<void> {
  const outputDir = dirname(path);
  if (outputDir === ".") {
    return;
  }

  await mkdir(outputDir, { recursive: true });
}

async function assertOutputFilePath(path: string): Promise<void> {
  try {
    const outputStat = await stat(path);
    if (!outputStat.isFile()) {
      throw new Error("--out must be a file path, not a directory.");
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_INPUT_BYTES) {
      throw new Error(`Stdin input is larger than ${MAX_INPUT_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
