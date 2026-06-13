import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, "scripts", "verify-action-manifest.mjs");

describe("verify-action-manifest", () => {
  it("accepts the repository action manifest", async () => {
    const result = await runVerifier(join(repoRoot, "action.yml"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SourceLine action manifest verified.");
  });

  it("rejects unsafe shell-split extra args", async () => {
    await withTempDir(async (dir) => {
      const actionPath = join(dir, "action.yml");
      await writeFile(
        actionPath,
        validActionManifest().replace(
          'while IFS= read -r extra_arg; do\n            trimmed_extra_arg="$(trim_input "$extra_arg")"\n            if [ -n "$trimmed_extra_arg" ]; then\n              extra_args+=("$trimmed_extra_arg")\n            fi\n          done <<< "$SOURCELINE_EXTRA_ARGS"',
          '# shellcheck disable=SC2206\n        extra_args=($SOURCELINE_EXTRA_ARGS)'
        ),
        "utf8"
      );

      const result = await runVerifier(actionPath);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("must parse extra-args line by line");
      expect(result.stderr).toContain("must not split extra-args with shell word splitting");
    });
  });

  it("rejects extra args passed without trimming each line", async () => {
    await withTempDir(async (dir) => {
      const actionPath = join(dir, "action.yml");
      await writeFile(
        actionPath,
        validActionManifest().replace(
          'trimmed_extra_arg="$(trim_input "$extra_arg")"\n            if [ -n "$trimmed_extra_arg" ]; then\n              extra_args+=("$trimmed_extra_arg")',
          'if [ -n "$(trim_input "$extra_arg")" ]; then\n              extra_args+=("$extra_arg")'
        ),
        "utf8"
      );

      const result = await runVerifier(actionPath);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("must trim each extra-args line before passing it to the CLI");
      expect(result.stderr).toContain("must not pass untrimmed extra-args lines to the CLI");
    });
  });
});

async function withTempDir(callback) {
  const dir = await mkdtemp(join(tmpdir(), "sourceline-action-test-"));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runVerifier(target) {
  try {
    const result = await execFileAsync(process.execPath, [scriptPath, target], { cwd: repoRoot });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? ""
    };
  }
}

function validActionManifest() {
  return `name: SourceLine
runs:
  using: composite
  steps:
    - shell: bash
      env:
        SOURCELINE_INPUT: \${{ inputs.input }}
        SOURCELINE_REPORT: \${{ inputs.report }}
        SOURCELINE_OUTPUT: \${{ inputs.output }}
        SOURCELINE_CONFIG_INPUT: \${{ inputs.config }}
        SOURCELINE_PROVIDER: \${{ inputs.provider }}
        SOURCELINE_BASE_URL_INPUT: \${{ inputs.base-url }}
        SOURCELINE_MODEL_INPUT: \${{ inputs.model }}
        SOURCELINE_SEARCH: \${{ inputs.search }}
        SOURCELINE_SOURCES_INPUT: \${{ inputs.sources }}
        SOURCELINE_MAX_CLAIMS_INPUT: \${{ inputs.max-claims }}
        SOURCELINE_MAX_RESULTS_INPUT: \${{ inputs.max-results }}
        SOURCELINE_MIN_CONFIDENCE_INPUT: \${{ inputs.min-confidence }}
        SOURCELINE_PROVIDER_TIMEOUT_MS_INPUT: \${{ inputs.provider-timeout-ms }}
        SOURCELINE_ALLOW_CLOUD_INPUT: \${{ inputs.allow-cloud }}
        SOURCELINE_FAIL_ON_INPUT: \${{ inputs.fail-on }}
        SOURCELINE_EXTRA_ARGS: \${{ inputs.extra-args }}
      run: |
        trim_input() {
          local value="$1"
          value="\${value#"\${value%%[![:space:]]*}"}"
          value="\${value%"\${value##*[![:space:]]}"}"
          printf '%s' "$value"
        }
        sourceline_input="$(trim_input "$SOURCELINE_INPUT")"
        sourceline_output="$(trim_input "$SOURCELINE_OUTPUT")"
        sourceline_config="$(trim_input "$SOURCELINE_CONFIG_INPUT")"
        sourceline_report="$(trim_input "$SOURCELINE_REPORT")"
        sourceline_provider="$(trim_input "$SOURCELINE_PROVIDER")"
        sourceline_base_url="$(trim_input "$SOURCELINE_BASE_URL_INPUT")"
        sourceline_model="$(trim_input "$SOURCELINE_MODEL_INPUT")"
        sourceline_search="$(trim_input "$SOURCELINE_SEARCH")"
        sourceline_sources="$(trim_input "$SOURCELINE_SOURCES_INPUT")"
        sourceline_max_claims="$(trim_input "$SOURCELINE_MAX_CLAIMS_INPUT")"
        sourceline_max_results="$(trim_input "$SOURCELINE_MAX_RESULTS_INPUT")"
        sourceline_min_confidence="$(trim_input "$SOURCELINE_MIN_CONFIDENCE_INPUT")"
        sourceline_provider_timeout_ms="$(trim_input "$SOURCELINE_PROVIDER_TIMEOUT_MS_INPUT")"
        sourceline_allow_cloud="$(trim_input "$SOURCELINE_ALLOW_CLOUD_INPUT")"
        sourceline_fail_on="$(trim_input "$SOURCELINE_FAIL_ON_INPUT")"
        args=("packages/cli/dist/index.js" "check" "$sourceline_input" "--out" "$sourceline_output")
        args+=("--config" "$sourceline_config")
        args+=("--report" "$sourceline_report")
        args+=("--provider" "$sourceline_provider")
        args+=("--base-url" "$sourceline_base_url")
        args+=("--model" "$sourceline_model")
        args+=("--search" "$sourceline_search")
        args+=("--sources" "$sourceline_sources")
        args+=("--max-claims" "$sourceline_max_claims")
        args+=("--max-results" "$sourceline_max_results")
        args+=("--min-confidence" "$sourceline_min_confidence")
        args+=("--provider-timeout-ms" "$sourceline_provider_timeout_ms")
        args+=("--yes")
        args+=("--fail-on" "$sourceline_fail_on")
        extra_args=()
        if [ -n "$SOURCELINE_EXTRA_ARGS" ]; then
          while IFS= read -r extra_arg; do
            trimmed_extra_arg="$(trim_input "$extra_arg")"
            if [ -n "$trimmed_extra_arg" ]; then
              extra_args+=("$trimmed_extra_arg")
            fi
          done <<< "$SOURCELINE_EXTRA_ARGS"
        fi
        node "\${args[@]}" "\${extra_args[@]}"
inputs:
  input:
    description: input
  report:
    description: report
  output:
    description: output
  config:
    description: config
  provider:
    description: provider
  base-url:
    description: base-url
  model:
    description: model
  search:
    description: search
  sources:
    description: sources
  max-claims:
    description: max-claims
  max-results:
    description: max-results
  min-confidence:
    description: min-confidence
  provider-timeout-ms:
    description: provider-timeout-ms
  allow-cloud:
    description: allow-cloud
  fail-on:
    description: fail-on
  extra-args:
    description: Additional SourceLine CLI arguments, one argument per line.
`;
}
