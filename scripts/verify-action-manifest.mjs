#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const actionPath = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, "action.yml");
const MAX_ACTION_MANIFEST_BYTES = 1_000_000;
const failures = [];
const raw = readActionManifest(actionPath);

const requiredInputs = [
  "input",
  "report",
  "output",
  "config",
  "provider",
  "base-url",
  "model",
  "search",
  "sources",
  "max-claims",
  "max-results",
  "min-confidence",
  "provider-timeout-ms",
  "allow-cloud",
  "fail-on",
  "extra-args"
];

const requiredMappings = new Map([
  ["SOURCELINE_INPUT", "inputs.input"],
  ["SOURCELINE_REPORT", "inputs.report"],
  ["SOURCELINE_OUTPUT", "inputs.output"],
  ["SOURCELINE_CONFIG_INPUT", "inputs.config"],
  ["SOURCELINE_PROVIDER", "inputs.provider"],
  ["SOURCELINE_BASE_URL_INPUT", "inputs.base-url"],
  ["SOURCELINE_MODEL_INPUT", "inputs.model"],
  ["SOURCELINE_SEARCH", "inputs.search"],
  ["SOURCELINE_SOURCES_INPUT", "inputs.sources"],
  ["SOURCELINE_MAX_CLAIMS_INPUT", "inputs.max-claims"],
  ["SOURCELINE_MAX_RESULTS_INPUT", "inputs.max-results"],
  ["SOURCELINE_MIN_CONFIDENCE_INPUT", "inputs.min-confidence"],
  ["SOURCELINE_PROVIDER_TIMEOUT_MS_INPUT", "inputs.provider-timeout-ms"],
  ["SOURCELINE_ALLOW_CLOUD_INPUT", "inputs.allow-cloud"],
  ["SOURCELINE_FAIL_ON_INPUT", "inputs.fail-on"],
  ["SOURCELINE_EXTRA_ARGS", "inputs.extra-args"]
]);

const requiredCliFlags = [
  "--out",
  "--config",
  "--report",
  "--provider",
  "--base-url",
  "--model",
  "--search",
  "--sources",
  "--max-claims",
  "--max-results",
  "--min-confidence",
  "--provider-timeout-ms",
  "--fail-on"
];

if (raw !== undefined) {
  for (const input of requiredInputs) {
    if (!new RegExp(`^  ${escapeRegExp(input)}:\\r?$`, "m").test(raw)) {
      fail(`action.yml must declare input ${input}.`);
    }
  }

  for (const [envName, expression] of requiredMappings) {
    if (!raw.includes(`${envName}: $` + `{{ ${expression} }}`)) {
      fail(`action.yml must map ${expression} to ${envName}.`);
    }
  }

  for (const flag of requiredCliFlags) {
    if (!raw.includes(`"${flag}"`)) {
      fail(`action.yml must pass CLI flag ${flag}.`);
    }
  }

  if (!raw.includes("set -euo pipefail")) {
    fail("action.yml must enable strict shell mode with set -euo pipefail.");
  }
  if (!raw.includes("using: composite")) {
    fail("action.yml must be a composite action.");
  }
  if (!raw.includes("shell: bash")) {
    fail("action.yml must run SourceLine steps with bash.");
  }
  if (!raw.includes('description: Additional SourceLine CLI arguments, one argument per line.')) {
    fail("action.yml must document extra-args as one argument per line.");
  }
  if (!raw.includes('"packages/cli/dist/index.js"') || !raw.includes('"check"')) {
    fail("action.yml must invoke the built local SourceLine CLI check command.");
  }
  if (!raw.includes('node "${args[@]}" "${extra_args[@]}"')) {
    fail("action.yml must invoke node with quoted argument arrays.");
  }
  if (!raw.includes("trim_input()")) {
    fail("action.yml must trim optional inputs before deciding whether to pass CLI flags.");
  }
  if (!raw.includes('sourceline_config="$(trim_input "$SOURCELINE_CONFIG_INPUT")"')) {
    fail("action.yml must trim config input before applying the default report decision.");
  }
  if (!raw.includes('if [ -z "$sourceline_input" ]; then')) {
    fail("action.yml must reject blank required input after trimming.");
  }
  if (!raw.includes("SourceLine input is required after trimming whitespace.")) {
    fail("action.yml must explain blank required input failures.");
  }
  if (!raw.includes('while IFS= read -r extra_arg; do')) {
    fail("action.yml must parse extra-args line by line.");
  }
  if (!raw.includes('trimmed_extra_arg="$(trim_input "$extra_arg")"')) {
    fail("action.yml must trim each extra-args line before passing it to the CLI.");
  }
  if (!raw.includes('if [ -n "$trimmed_extra_arg" ]; then')) {
    fail("action.yml must skip whitespace-only extra-args lines.");
  }
  if (raw.includes('extra_args+=("$extra_arg")')) {
    fail("action.yml must not pass untrimmed extra-args lines to the CLI.");
  }
  if (/extra_args=\(\$SOURCELINE_EXTRA_ARGS\)/.test(raw)) {
    fail("action.yml must not split extra-args with shell word splitting.");
  }
  verifyNoShellEval(raw);
  verifyAllowCloudGate(raw);

  const rawInputChecks = Array.from(raw.matchAll(/\[ -n "\$(SOURCELINE_[A-Z0-9_]+(?:_INPUT)?)" \]/g), (match) => match[1]).filter(
    (name) => name !== "SOURCELINE_EXTRA_ARGS"
  );
  if (rawInputChecks.length > 0) {
    fail(`action.yml must not test raw optional input variables for emptiness: ${rawInputChecks.join(", ")}.`);
  }
}

if (failures.length > 0) {
  console.error("SourceLine action manifest verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("SourceLine action manifest verified.");
}

function fail(message) {
  failures.push(message);
}

function readActionManifest(path) {
  try {
    const manifestStat = statSync(path);
    if (!manifestStat.isFile()) {
      throw new Error(`Action manifest must be a file: ${path}`);
    }
    if (manifestStat.size > MAX_ACTION_MANIFEST_BYTES) {
      throw new Error(`Action manifest is larger than ${MAX_ACTION_MANIFEST_BYTES} bytes.`);
    }

    return readFileSync(path, "utf8");
  } catch (error) {
    fail(`Could not read action manifest ${path}: ${formatError(error)}`);
    return undefined;
  }
}

function verifyAllowCloudGate(manifest) {
  const allowCloudYesPattern = /if \[ "\$sourceline_allow_cloud" = "true" \]; then\r?\n\s*args\+=\("--yes"\)\r?\n\s*fi/;
  const match = manifest.match(allowCloudYesPattern);
  if (!match || match.index === undefined) {
    fail("action.yml must pass --yes only when allow-cloud is true.");
    return;
  }

  const remainder = manifest.slice(0, match.index) + manifest.slice(match.index + match[0].length);
  if (remainder.includes('args+=("--yes")')) {
    fail("action.yml must not pass --yes outside the allow-cloud gate.");
  }
}

function verifyNoShellEval(manifest) {
  const bannedPatterns = [
    { label: "eval", pattern: /\beval\b/ },
    { label: "bash -c or sh -c", pattern: /\b(?:ba)?sh\s+-c\b/ }
  ];

  for (const { label, pattern } of bannedPatterns) {
    if (pattern.test(manifest)) {
      fail(`action.yml must not invoke SourceLine through ${label}.`);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
