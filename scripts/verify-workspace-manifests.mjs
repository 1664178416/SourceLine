#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = process.argv[2] ? resolve(process.argv[2]) : repoRoot;
const MAX_PACKAGE_NAME_LENGTH = 214;
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_FAILURE_MESSAGE_CHARS = 2_000;
const MAX_DYNAMIC_FIELD_CHARS = 300;
const PACKAGE_NAME_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._~-]*$/;
const PACKAGE_MANAGER_PATTERN = /^pnpm@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SUPPORTED_WORKSPACE_TOP_LEVEL_KEYS = new Set(["allowBuilds", "packages"]);
const TRUNCATION_MARKER = "... [truncated]";
const failures = [];

const rootManifest = readManifest(join(workspaceRoot, "package.json"));
const workspaceManifestPaths = findWorkspaceManifestPaths(workspaceRoot);
const workspaceManifests = workspaceManifestPaths.map((path) => ({ path, manifest: readManifest(path) }));
const packageNames = new Set(
  workspaceManifests.map((entry) => entry.manifest.name).filter((name) => typeof name === "string" && name.length > 0)
);
const expectedVersion = rootManifest.version;
const expectedNodeEngine = rootManifest.engines?.node;

if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
  fail("Root package.json must define a version.");
}
if (typeof expectedNodeEngine !== "string" || expectedNodeEngine.length === 0) {
  fail("Root package.json must define engines.node.");
}
verifyPackageName("Root package.json", rootManifest.name);
verifyRootManifest(rootManifest);
if (workspaceManifests.length === 0) {
  fail("pnpm-workspace.yaml package patterns must match at least one workspace package manifest.");
}

verifyUniquePackageNames(workspaceManifests);

for (const { path, manifest } of workspaceManifests) {
  const label = formatManifestPath(path);

  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    fail(`${label} must define a package name.`);
  } else {
    verifyPackageName(label, manifest.name);
  }
  if (manifest.version !== expectedVersion) {
    fail(`${label} version must match root version ${expectedVersion}.`);
  }
  if (manifest.engines?.node !== expectedNodeEngine) {
    fail(`${label} engines.node must match root engines.node ${expectedNodeEngine}.`);
  }

  verifyWorkspaceManifestShape(label, manifest);
  verifyInternalDependencies(label, manifest, packageNames);
}

if (failures.length > 0) {
  console.error("SourceLine workspace manifest verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`SourceLine workspace manifests verified: ${workspaceManifests.length} packages at version ${expectedVersion}`);
}

function verifyUniquePackageNames(entries) {
  const seen = new Map();

  for (const { path, manifest } of entries) {
    const name = manifest.name;
    if (typeof name !== "string" || name.length === 0) {
      continue;
    }

    const firstPath = seen.get(name);
    if (firstPath) {
      fail(`Duplicate workspace package name "${name}" in ${formatManifestPath(firstPath)} and ${formatManifestPath(path)}.`);
    } else {
      seen.set(name, path);
    }
  }
}

function findWorkspaceManifestPaths(root) {
  let workspaceYaml;
  try {
    workspaceYaml = readTextFile(join(root, "pnpm-workspace.yaml"));
  } catch (error) {
    fail(`Could not read pnpm-workspace.yaml: ${formatError(error)}`);
    return [];
  }
  const packagePatterns = parseWorkspacePackagePatterns(workspaceYaml);
  const paths = [];

  for (const pattern of packagePatterns) {
    if (pattern === "packages/*") {
      const packagesDir = join(root, "packages");
      if (!existsSync(packagesDir)) {
        continue;
      }
      if (!statSync(packagesDir).isDirectory()) {
        fail("Workspace package pattern packages/* must resolve to a packages directory.");
        continue;
      }
      for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const manifestPath = join(packagesDir, entry.name, "package.json");
        if (existsSync(manifestPath)) {
          paths.push(manifestPath);
        }
      }
      continue;
    }

    fail(`Unsupported pnpm workspace package pattern: ${pattern}`);
  }

  return paths.sort((a, b) => a.localeCompare(b));
}

function verifyRootManifest(manifest) {
  if (manifest.private !== true) {
    fail("Root package.json must be private.");
  }
  if (manifest.type !== "module") {
    fail('Root package.json must have type "module".');
  }
  if (manifest.license !== "UNLICENSED") {
    fail('Root package.json must have license "UNLICENSED".');
  }
  if (typeof manifest.packageManager !== "string" || !PACKAGE_MANAGER_PATTERN.test(manifest.packageManager)) {
    fail("Root package.json packageManager must pin pnpm as pnpm@x.y.z.");
  }
}

function verifyWorkspaceManifestShape(label, manifest) {
  if (manifest.private !== true) {
    fail(`${label} must be private before publishing is deliberately enabled.`);
  }
  if (manifest.type !== "module") {
    fail(`${label} must have type "module".`);
  }
  if (manifest.license !== "UNLICENSED") {
    fail(`${label} must have license "UNLICENSED".`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== 1 || manifest.files[0] !== "dist") {
    fail(`${label} files must only include "dist".`);
  }
}

function verifyPackageName(label, name) {
  if (typeof name !== "string" || name.length === 0) {
    fail(`${label} must define a package name.`);
    return;
  }

  if (!isValidPackageName(name)) {
    fail(`${label} package name "${name}" must be a lowercase npm package name (name or @scope/name).`);
  }
}

function isValidPackageName(name) {
  if (name.length > MAX_PACKAGE_NAME_LENGTH || name.trim() !== name || /[\u0000-\u001f\u007f\s]/.test(name)) {
    return false;
  }
  if (name !== name.toLowerCase()) {
    return false;
  }
  if (name.startsWith("@")) {
    const segments = name.split("/");
    return (
      segments.length === 2 &&
      segments[0].length > 1 &&
      segments[1].length > 0 &&
      PACKAGE_NAME_SEGMENT_PATTERN.test(segments[0].slice(1)) &&
      PACKAGE_NAME_SEGMENT_PATTERN.test(segments[1])
    );
  }

  return !name.includes("/") && PACKAGE_NAME_SEGMENT_PATTERN.test(name);
}

function parseWorkspacePackagePatterns(yaml) {
  const patterns = [];
  const seenPatterns = new Set();
  let inPackages = false;

  for (const line of yaml.split(/\r?\n/)) {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) {
      fail("pnpm-workspace.yaml must not contain control characters.");
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const topLevelMatch = /^([A-Za-z0-9_-]+):/.exec(line);
    if (topLevelMatch) {
      const key = topLevelMatch[1];
      if (!SUPPORTED_WORKSPACE_TOP_LEVEL_KEYS.has(key)) {
        fail(`Unsupported pnpm-workspace.yaml top-level key: ${key}.`);
      }
      inPackages = key === "packages";
      continue;
    }

    if (/^\S/.test(line)) {
      inPackages = false;
    }

    if (inPackages && trimmed.startsWith("-")) {
      const pattern = parseWorkspacePattern(trimmed.slice(1));
      if (pattern.length > 0) {
        if (seenPatterns.has(pattern)) {
          fail(`Duplicate pnpm workspace package pattern: ${pattern}`);
        }
        seenPatterns.add(pattern);
        patterns.push(pattern);
      }
      continue;
    }

    if (inPackages) {
      fail(`Unsupported pnpm-workspace.yaml packages entry: ${trimmed}`);
    }
  }

  if (patterns.length === 0) {
    fail("pnpm-workspace.yaml must list workspace package patterns.");
  }

  return patterns;
}

function parseWorkspacePattern(value) {
  const pattern = value.trim().replace(/^['"]|['"]$/g, "");
  if (/[\u0000-\u001f\u007f]/.test(pattern)) {
    fail("pnpm workspace package patterns must not contain control characters.");
    return "";
  }

  return pattern;
}

function verifyInternalDependencies(label, manifest, packageNames) {
  const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

  for (const section of dependencySections) {
    const dependencies = manifest[section] ?? {};
    if (!isRecord(dependencies)) {
      fail(`${label} ${section} must be an object.`);
      continue;
    }
    for (const [name, version] of Object.entries(dependencies)) {
      const dependencyPath = formatDependencyPath(section, name);
      if (!isValidPackageName(name)) {
        fail(`${label} ${dependencyPath} must be a lowercase npm package name (name or @scope/name).`);
      }
      if (typeof version !== "string" || version.length === 0 || /[\u0000-\u001f\u007f]/.test(version)) {
        fail(`${label} ${dependencyPath} must be a non-empty string without control characters.`);
        continue;
      }
      if (!packageNames.has(name)) {
        continue;
      }
      if (version !== "workspace:*") {
        fail(`${label} ${dependencyPath} must use workspace:* before packing.`);
      }
    }
  }
}

function formatDependencyPath(section, name) {
  return `${section}.${normalizeFailureMessage(name, MAX_DYNAMIC_FIELD_CHARS)}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(path) {
  try {
    const manifest = JSON.parse(readTextFile(path));
    if (!isRecord(manifest)) {
      fail(`${formatManifestPath(path)} must be a JSON object.`);
      return {};
    }
    return manifest;
  } catch (error) {
    fail(`Could not read ${formatManifestPath(path)}: ${formatError(error)}`);
    return {};
  }
}

function readTextFile(path) {
  const fileStat = statSync(path);
  if (!fileStat.isFile()) {
    throw new Error(`${formatManifestPath(path)} must be a file.`);
  }
  if (fileStat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`${formatManifestPath(path)} is larger than ${MAX_MANIFEST_BYTES} bytes.`);
  }

  return readFileSync(path, "utf8");
}

function formatManifestPath(path) {
  return path.startsWith(workspaceRoot) ? path.slice(workspaceRoot.length + 1).replace(/\\/g, "/") : basename(path);
}

function fail(message) {
  failures.push(normalizeFailureMessage(message));
}

function formatError(error) {
  const message = error instanceof Error && error.message.length > 0 ? error.message : String(error);
  return normalizeFailureMessage(message);
}

function normalizeFailureMessage(value, maxLength = MAX_FAILURE_MESSAGE_CHARS) {
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

function stripAnsi(value) {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
