import { access, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import pc from "picocolors";

const CONFIG_FILE = "sourceline.config.json";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Create a starter SourceLine config file")
    .action(async () => {
      await runInitCommand();
    });
}

export async function runInitCommand(options: { configPath?: string; writeOutput?: (value: string) => void } = {}): Promise<void> {
  const configPath = options.configPath ?? CONFIG_FILE;
  const writeOutput = options.writeOutput ?? ((value: string) => process.stdout.write(value));

  try {
    await writeFile(configPath, starterConfig(), { encoding: "utf8", flag: "wx" });
    writeOutput(`${pc.green("Created:")} ${configPath}\n`);
  } catch (error) {
    if (getErrorCode(error) === "EEXIST" || (await fileExists(configPath))) {
      writeOutput(`${pc.yellow("Skipped:")} ${configPath} already exists.\n`);
      return;
    }
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
