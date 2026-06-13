#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const actionPath = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, "action.yml");
const raw = readFileSync(actionPath, "utf8");
const failures = [];

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
  "--yes",
  "--fail-on"
];

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

if (!raw.includes('description: Additional SourceLine CLI arguments, one argument per line.')) {
  fail("action.yml must document extra-args as one argument per line.");
}
if (!raw.includes("trim_input()")) {
  fail("action.yml must trim optional inputs before deciding whether to pass CLI flags.");
}
if (!raw.includes('sourceline_config="$(trim_input "$SOURCELINE_CONFIG_INPUT")"')) {
  fail("action.yml must trim config input before applying the default report decision.");
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
const rawInputChecks = Array.from(raw.matchAll(/\[ -n "\$(SOURCELINE_[A-Z0-9_]+(?:_INPUT)?)" \]/g), (match) => match[1]).filter(
  (name) => name !== "SOURCELINE_EXTRA_ARGS"
);
if (rawInputChecks.length > 0) {
  fail(`action.yml must not test raw optional input variables for emptiness: ${rawInputChecks.join(", ")}.`);
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
