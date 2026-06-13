import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCliVersion } from "./version.js";

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("readCliVersion", () => {
  it("matches the CLI package manifest version", () => {
    const manifest = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as { version?: unknown };

    expect(readCliVersion()).toBe(manifest.version);
  });
});