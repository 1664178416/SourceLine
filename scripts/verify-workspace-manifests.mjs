#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = process.argv[2] ? resolve(process.argv[2]) : repoRoot;
const failures = [];

const rootManifest = readManifest(join(workspaceRoot, "package.json"));
const workspaceManifestPaths = findWorkspaceManifestPaths(workspaceRoot);
const workspaceManifests = workspaceManifestPaths.map((path) => ({ path, manifest: readManifest(path) }));
const packageNames = new Set(workspaceManifests.map((entry) => entry.manifest.name));
const expectedVersion = rootManifest.version;
const expectedNodeEngine = rootManifest.engines?.node;

if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
  fail("Root package.json must define a version.");
}
if (typeof expectedNodeEngine !== "string" || expectedNodeEngine.length === 0) {
  fail("Root package.json must define engines.node.");
}

for (const { path, manifest } of workspaceManifests) {
  const label = formatManifestPath(path);

  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    fail(`${label} must define a package name.`);
  }
  if (manifest.version !== expectedVersion) {
    fail(`${label} version must match root version ${expectedVersion}.`);
  }
  if (manifest.engines?.node !== expectedNodeEngine) {
    fail(`${label} engines.node must match root engines.node ${expectedNodeEngine}.`);
  }

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

function findWorkspaceManifestPaths(root) {
  const workspaceYaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const packagePatterns = parseWorkspacePackagePatterns(workspaceYaml);
  const paths = [];

  for (const pattern of packagePatterns) {
    if (pattern === "packages/*") {
      const packagesDir = join(root, "packages");
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

function parseWorkspacePackagePatterns(yaml) {
  const patterns = [];
  let inPackages = false;

  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed === "packages:") {
      inPackages = true;
      continue;
    }
    if (/^[A-Za-z0-9_-]+:/.test(trimmed)) {
      inPackages = false;
    }
    if (inPackages && trimmed.startsWith("-")) {
      const pattern = trimmed.slice(1).trim().replace(/^['"]|['"]$/g, "");
      if (pattern.length > 0) {
        patterns.push(pattern);
      }
    }
  }

  if (patterns.length === 0) {
    fail("pnpm-workspace.yaml must list workspace package patterns.");
  }

  return patterns;
}

function verifyInternalDependencies(label, manifest, packageNames) {
  const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

  for (const section of dependencySections) {
    const dependencies = manifest[section] ?? {};
    for (const [name, version] of Object.entries(dependencies)) {
      if (!packageNames.has(name)) {
        continue;
      }
      if (version !== "workspace:*") {
        fail(`${label} ${section}.${name} must use workspace:* before packing.`);
      }
    }
  }
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Could not read ${formatManifestPath(path)}: ${formatError(error)}`);
    return {};
  }
}

function formatManifestPath(path) {
  return path.startsWith(workspaceRoot) ? path.slice(workspaceRoot.length + 1).replace(/\\/g, "/") : basename(path);
}

function fail(message) {
  failures.push(message);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}