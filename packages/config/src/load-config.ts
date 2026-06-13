import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { sourceLineConfigSchema, type SourceLineConfig } from "./schema.js";

export const DEFAULT_CONFIG_FILE = "sourceline.config.json";

export type LoadConfigOptions = {
  cwd?: string;
  configPath?: string;
};

export type LoadedConfig = {
  config: SourceLineConfig;
  path?: string;
};

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const explicitConfigPath = options.configPath !== undefined;
  const configFile = explicitConfigPath ? normalizeConfigPath(options.configPath) : DEFAULT_CONFIG_FILE;
  const configPath = resolve(cwd, configFile);

  if (!(await fileExists(configPath))) {
    if (explicitConfigPath) {
      throw new Error(`SourceLine config not found: ${configPath}`);
    }
    return { config: {} };
  }

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return {
      config: sourceLineConfigSchema.parse(parsed),
      path: configPath
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${configPath}: ${error.message}`);
    }
    if (error instanceof ZodError) {
      throw new Error(`Invalid SourceLine config in ${configPath}: ${formatZodIssues(error)}`);
    }
    throw error;
  }
}


function normalizeConfigPath(path: string | undefined): string {
  const trimmed = path?.trim();
  if (!trimmed) {
    throw new Error("--config must not be empty.");
  }

  return trimmed;
}

function formatZodIssues(error: ZodError): string {
  return error.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`).join("; ");
}

function formatIssuePath(path: PropertyKey[]): string {
  return path.length === 0 ? "<root>" : path.map(String).join(".");
}
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
