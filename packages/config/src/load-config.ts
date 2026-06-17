import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { MAX_CONFIG_STRING_CHARS, sourceLineConfigSchema, type SourceLineConfig } from "./schema.js";

export const DEFAULT_CONFIG_FILE = "sourceline.config.json";
export const MAX_CONFIG_BYTES = 1_000_000;
const MAX_CONFIG_ERROR_CHARS = 2_000;
const MAX_CONFIG_ERROR_ISSUES = 20;
const MAX_CONFIG_ISSUE_CHARS = 300;
const MAX_CONFIG_ISSUE_PATH_CHARS = 200;
const TRUNCATION_MARKER = "... [truncated]";

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
  let configStat;

  try {
    configStat = await stat(configPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      if (explicitConfigPath) {
        throw new Error(`SourceLine config not found: ${configPath}`);
      }
      return { config: {} };
    }

    throw error;
  }

  try {
    if (!configStat.isFile()) {
      throw new Error(`SourceLine config must be a file: ${configPath}`);
    }
    if (configStat.size > MAX_CONFIG_BYTES) {
      throw new Error(`SourceLine config is larger than ${MAX_CONFIG_BYTES} bytes: ${configPath}`);
    }
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
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    throw new Error("--config must not contain control characters.");
  }
  if (trimmed.length > MAX_CONFIG_STRING_CHARS) {
    throw new Error(`--config must be at most ${MAX_CONFIG_STRING_CHARS} characters.`);
  }

  return trimmed;
}

function formatZodIssues(error: ZodError): string {
  const issues = error.issues.slice(0, MAX_CONFIG_ERROR_ISSUES).map(formatZodIssue);
  const omitted = error.issues.length - issues.length;
  if (omitted > 0) {
    issues.push(`${TRUNCATION_MARKER} (${omitted} more validation issues omitted)`);
  }

  return normalizeIssueText(issues.join("; "), MAX_CONFIG_ERROR_CHARS);
}

function formatZodIssue(issue: ZodError["issues"][number]): string {
  const path = normalizeIssueText(formatIssuePath(issue.path), MAX_CONFIG_ISSUE_PATH_CHARS) || "<root>";
  const message = normalizeIssueText(issue.message, MAX_CONFIG_ISSUE_CHARS) || "Invalid value";
  return `${path}: ${message}`;
}

function formatIssuePath(path: PropertyKey[]): string {
  return path.length === 0 ? "<root>" : path.map(String).join(".");
}

function normalizeIssueText(value: string, maxLength: number): string {
  const normalized = stripAnsi(value)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  if (maxLength <= TRUNCATION_MARKER.length) {
    return normalized.slice(0, maxLength);
  }

  return `${normalized.slice(0, maxLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isMissingPathError(error: unknown): boolean {
  return getErrorCode(error) === "ENOENT" || getErrorCode(error) === "ENOTDIR";
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
