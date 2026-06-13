import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function readCliVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("packages/cli/package.json must define a version.");
  }

  return manifest.version;
}