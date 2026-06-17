import { stat, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import pc from "picocolors";

const CONFIG_FILE = "sourceline.config.json";
const MAX_CONFIG_PATH_CHARS = 2_000;

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Create a starter SourceLine config file")
    .action(async () => {
      await runInitCommand();
    });
}

export async function runInitCommand(options: { configPath?: string; writeOutput?: (value: string) => void } = {}): Promise<void> {
  const configPath = normalizeConfigPath(options.configPath ?? CONFIG_FILE);
  const writeOutput = options.writeOutput ?? ((value: string) => process.stdout.write(value));

  try {
    await writeFile(configPath, starterConfig(), { encoding: "utf8", flag: "wx" });
    writeOutput(`${pc.green("Created:")} ${configPath}\n`);
  } catch (error) {
    const existingStat = await stat(configPath).catch(() => undefined);
    if (existingStat && !existingStat.isFile()) {
      throw new Error(`SourceLine config must be a file: ${configPath}`);
    }
    if (getErrorCode(error) === "EEXIST" || existingStat) {
      writeOutput(`${pc.yellow("Skipped:")} ${configPath} already exists.\n`);
      return;
    }
    throw error;
  }
}

function normalizeConfigPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new Error("SourceLine config path must not be empty.");
  }
  if (hasControlCharacters(trimmed)) {
    throw new Error("SourceLine config path must not contain control characters.");
  }
  if (trimmed.length > MAX_CONFIG_PATH_CHARS) {
    throw new Error(`SourceLine config path must be at most ${MAX_CONFIG_PATH_CHARS} characters.`);
  }
  if (/[\\/]$/.test(trimmed)) {
    throw new Error("SourceLine config path must be a file path, not a directory.");
  }

  return trimmed;
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function starterConfig(): string {
  return `{
  "llm": {
    "provider": "mock"
  },
  "search": {
    "provider": "mock",
    "maxResultsPerClaim": 5
  },
  "checks": {
    "maxClaims": 30,
    "minConfidence": 0.65
  },
  "reports": {
    "defaultFormat": "markdown"
  }
}
`;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
