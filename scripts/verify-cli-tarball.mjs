#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultPackDir = ".tmp-pack";
const target = process.argv[2] ?? defaultPackDir;
const cliPackageVersion = readCliPackageVersion();
const failures = [];
const requiredEntries = [
  "package/package.json",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/errors.js",
  "package/dist/errors.d.ts",
  "package/dist/commands/cache.js",
  "package/dist/commands/cache.d.ts",
  "package/dist/commands/check.js",
  "package/dist/commands/check.d.ts",
  "package/dist/commands/init.js",
  "package/dist/commands/init.d.ts"
];
const requiredRuntimeDependencies = [
  "@sourceline/config",
  "@sourceline/core",
  "@sourceline/providers",
  "@sourceline/report",
  "commander",
  "picocolors"
];

const tarballPath = resolveTarballPath(target);

if (!tarballPath) {
  fail(`Could not find a SourceLine tarball for version ${cliPackageVersion} in ${target}.`);
} else if (!existsSync(tarballPath)) {
  fail(`Tarball does not exist: ${tarballPath}.`);
} else {
  verifyTarball(tarballPath);
}

if (failures.length > 0) {
  console.error("SourceLine tarball verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`SourceLine tarball verified: ${tarballPath}`);
}

function resolveTarballPath(pathOrDirectory) {
  if (!existsSync(pathOrDirectory)) {
    return pathOrDirectory.endsWith(".tgz") ? pathOrDirectory : undefined;
  }

  return statSync(pathOrDirectory).isDirectory() ? findTarball(pathOrDirectory) : pathOrDirectory;
}

function findTarball(directory) {
  const matches = readdirSync(directory)
    .filter((name) => /^sourceline-\d+\.\d+\.\d+.*\.tgz$/.test(name))
    .map((name) => join(directory, name));
  const versionedName = `sourceline-${cliPackageVersion}.tgz`;
  const versionedMatches = matches.filter((path) => path.endsWith(versionedName));

  if (versionedMatches.length === 1) {
    return versionedMatches[0];
  }
  if (matches.length === 1) {
    return matches[0];
  }

  return undefined;
}

function verifyTarball(path) {
  let entries;
  try {
    entries = readTarGz(path);
  } catch (error) {
    fail(`Could not read tarball ${path}: ${formatError(error)}`);
    return;
  }

  const names = entries.map((entry) => entry.name).sort();
  const nameSet = new Set(names);
  const packageEntry = entries.find((entry) => entry.name === "package/package.json");
  const indexEntry = entries.find((entry) => entry.name === "package/dist/index.js");
  let manifest;

  for (const name of requiredEntries) {
    requireEntry(nameSet, name);
  }

  for (const name of names) {
    if (!isAllowedEntry(name)) {
      fail(`Unexpected tarball entry: ${name}`);
    }
    if (/\/src\/|\/tests?\/|__tests__\/|\.(?:test|spec)\.|\.tmp|\.sourceline\//.test(name)) {
      fail(`Tarball contains local-only content: ${name}`);
    }
  }

  if (packageEntry) {
    manifest = verifyPackageJson(packageEntry.content.toString("utf8"));
  }
  if (manifest) {
    verifyDistImports(entries, manifest);
  }
  if (indexEntry) {
    const index = indexEntry.content.toString("utf8");
    if (!/^#!\/usr\/bin\/env node\r?\n/.test(index)) {
      fail("package/dist/index.js must start with #!/usr/bin/env node.");
    }
    if ((indexEntry.mode & 0o111) === 0) {
      fail("package/dist/index.js must be executable in the packed tarball.");
    }
  }
}

function readTarGz(path) {
  const tar = gunzipSync(readFileSync(path));
  const entries = [];
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = readNullTerminated(header, 0, 100);
    const prefix = readNullTerminated(header, 345, 155);
    const modeText = readNullTerminated(header, 100, 8).trim();
    const mode = parseTarOctal(modeText);
    const sizeText = readNullTerminated(header, 124, 12).trim();
    const size = parseTarOctal(sizeText);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;

    if (!Number.isFinite(mode) || mode < 0) {
      throw new Error(`Invalid tar entry mode for ${fullName || "<empty>"}.`);
    }
    if (!Number.isFinite(size) || size < 0 || contentEnd > tar.length) {
      throw new Error(`Invalid tar entry size for ${fullName || "<empty>"}.`);
    }

    entries.push({
      name: fullName,
      mode,
      content: tar.subarray(contentStart, contentEnd)
    });

    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function parseTarOctal(value) {
  const normalized = value || "0";
  if (!/^[0-7]+$/.test(normalized)) {
    return Number.NaN;
  }

  const parsed = Number.parseInt(normalized, 8);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function readNullTerminated(buffer, start, length) {
  const end = start + length;
  let cursor = start;
  while (cursor < end && buffer[cursor] !== 0) {
    cursor += 1;
  }
  return buffer.subarray(start, cursor).toString("utf8");
}

function readCliPackageVersion() {
  const manifestPath = join(repoRoot, "packages", "cli", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("packages/cli/package.json must define a version.");
  }

  return manifest.version;
}

function verifyPackageJson(raw) {
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    fail("package/package.json is not valid JSON.");
    return;
  }

  if (manifest.name !== "sourceline") {
    fail('package/package.json must have name "sourceline".');
  }
  if (manifest.type !== "module") {
    fail('package/package.json must have type "module".');
  }
  if (manifest.version !== cliPackageVersion) {
    fail(`package/package.json must have version "${cliPackageVersion}".`);
  }
  if (manifest.bin?.sourceline !== "./dist/index.js") {
    fail('package/package.json must set bin.sourceline to "./dist/index.js".');
  }
  if (!manifest.engines || manifest.engines.node !== ">=24") {
    fail('package/package.json must require engines.node ">=24".');
  }

  verifyRequiredRuntimeDependencies(manifest);

  const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  for (const section of dependencySections) {
    const dependencies = manifest[section] ?? {};
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version === "string" && version.startsWith("workspace:")) {
        fail(`${section}.${name} was not rewritten from workspace protocol.`);
      }
    }
  }

  return manifest;
}

function verifyDistImports(entries, manifest) {
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {};

  for (const entry of entries) {
    if (!/^package\/dist\/.+\.js$/.test(entry.name)) {
      continue;
    }

    const source = entry.content.toString("utf8");
    for (const specifier of extractBareModuleSpecifiers(source)) {
      const packageName = packageNameFromSpecifier(specifier);
      if (!Object.hasOwn(dependencies, packageName)) {
        fail(`${entry.name} imports ${specifier}, but package/package.json dependencies.${packageName} is missing.`);
      }
    }
  }
}

function extractBareModuleSpecifiers(source) {
  const specifiers = [];
  const importPattern = /(?:import|export)\s+(?:[^'";]+\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImportPattern = /import\(\s*["']([^"']+)["']\s*\)/g;

  for (const pattern of [importPattern, dynamicImportPattern]) {
    let match;
    while ((match = pattern.exec(source))) {
      const specifier = match[1];
      if (isBareModuleSpecifier(specifier)) {
        specifiers.push(specifier);
      }
    }
  }

  return Array.from(new Set(specifiers));
}

function isBareModuleSpecifier(specifier) {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:");
}

function packageNameFromSpecifier(specifier) {
  if (!specifier.startsWith("@")) {
    return specifier.split("/")[0];
  }

  const [scope, name] = specifier.split("/");
  return `${scope}/${name}`;
}

function verifyRequiredRuntimeDependencies(manifest) {
  if (!isRecord(manifest.dependencies)) {
    fail("package/package.json must define dependencies for the CLI runtime.");
    return;
  }

  for (const name of requiredRuntimeDependencies) {
    const version = manifest.dependencies[name];
    if (typeof version !== "string" || version.length === 0) {
      fail(`package/package.json dependencies.${name} must be present for the CLI runtime.`);
    }
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireEntry(nameSet, name) {
  if (!nameSet.has(name)) {
    fail(`Missing tarball entry: ${name}`);
  }
}

function isAllowedEntry(name) {
  return name === "package/package.json" || /^package\/dist\/.+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(name);
}

function fail(message) {
  failures.push(message);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
