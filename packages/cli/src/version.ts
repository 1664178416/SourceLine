import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PACKAGE_MANIFEST_BYTES = 1_000_000;

export function readCliVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return readPackageVersion(packageJsonPath, "packages/cli/package.json");
}

export function readPackageVersion(packageJsonPath: string, label: string): string {
  const packageStat = statSync(packageJsonPath);
  if (!packageStat.isFile()) {
    throw new Error(`${label} must be a file.`);
  }
  if (packageStat.size > MAX_PACKAGE_MANIFEST_BYTES) {
    throw new Error(`${label} is larger than ${MAX_PACKAGE_MANIFEST_BYTES} bytes.`);
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
  if (!isRecord(manifest)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`${label} must define a version.`);
  }

  return manifest.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
