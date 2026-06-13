# SourceLine

Every claim, traced.

SourceLine turns AI answers, essays, reports, and policy text into claim-by-claim evidence reports.

The current MVP is a TypeScript CLI with mock, local-source, and cloud-provider paths:

- `mock`: no API keys, useful for demos and tests.
- `local`: verifies against local Markdown/txt/HTML source folders.
- `openai` + `tavily` / `brave`: real LLM and web search provider paths.

## Quickstart

```bash
corepack pnpm install
corepack pnpm run build
node packages/cli/dist/index.js check examples/answer.md
```

Use local sources:

```bash
node packages/cli/dist/index.js check examples/answer.md --search local --sources examples/sources --report markdown
```

Local source folders honor `.sourcelineignore` files in the current working directory and in the source folder, including `!` negation rules.
SourceLine also keeps a best-effort local retrieval cache at `<sources>/.sourceline/cache/local-index.json` so repeated CLI runs can reuse unchanged Markdown/txt/HTML chunks. The cache stays inside your source folder, is ignored by git via `.sourceline/`, is rebuilt when the index schema changes, and can be deleted at any time.

Inspect or clear the local retrieval cache:

```bash
node packages/cli/dist/index.js cache info --sources examples/sources
node packages/cli/dist/index.js cache clear --sources examples/sources
```

Check a web page directly:

```bash
node packages/cli/dist/index.js check https://example.com/article --report markdown
```

SourceLine fetches `http` and `https` URLs, extracts readable text from HTML, and caps fetched input size to keep CLI runs predictable.
Local `.html` and `.htm` input files are also cleaned into readable text before claim extraction.

Check piped text:

```bash
echo "SourceLine uses JSON reports." | node packages/cli/dist/index.js check -
```

Use a config file:

```bash
node packages/cli/dist/index.js check examples/answer.md --config examples/sourceline.config.json
```

Write a Markdown report:

```bash
node packages/cli/dist/index.js check examples/answer.md --report markdown --out sourceline-report.md
```

When `--out` points into a nested folder, SourceLine creates the parent directories before writing the report.

Write a single-file HTML report:

```bash
node packages/cli/dist/index.js check examples/answer.md --report html --out sourceline-report.html
```

HTML reports include status filters, claim/evidence search, a claim index, keyboard shortcuts for quick filtering and search focus, visible-claim copying, reset, JSON download, print styles, and accessibility landmarks.

Local-source reports include retrieval scores and matched query terms so you can see why each evidence chunk was selected.

Print JSON:

```bash
node packages/cli/dist/index.js check examples/answer.md --json
```

## Cloud Providers

SourceLine asks for explicit confirmation before sending claim text or evidence snippets to cloud providers. In non-interactive runs, pass `--yes` or set `SOURCELINE_ALLOW_CLOUD=1`.
Remote provider calls time out after 30 seconds by default. Use `--provider-timeout-ms`, `SOURCELINE_PROVIDER_TIMEOUT_MS`, or `providers.timeoutMs` in config to tune this for slow gateways.

OpenAI-compatible LLM with local sources:

```powershell
$env:OPENAI_API_KEY="..."
node packages/cli/dist/index.js check examples/answer.md `
  --provider openai `
  --base-url https://runanytime.hxi.me/v1 `
  --model gpt-5.5-openai-compact `
  --search local `
  --sources examples/sources `
  --report markdown `
  --out sourceline-report.md `
  --yes
```

OpenAI-compatible LLM with Tavily web search:

```powershell
$env:OPENAI_API_KEY="..."
$env:TAVILY_API_KEY="..."
node packages/cli/dist/index.js check examples/answer.md `
  --provider openai `
  --search tavily `
  --report markdown `
  --yes
```

OpenAI-compatible LLM with Brave Search:

```powershell
$env:OPENAI_API_KEY="..."
$env:BRAVE_SEARCH_API_KEY="..."
node packages/cli/dist/index.js check examples/answer.md `
  --provider openai `
  --search brave `
  --report markdown `
  --yes
```

## Configuration

Create a starter config:

```bash
node packages/cli/dist/index.js init
```

Supported config file: `sourceline.config.json`.

Config priority:

1. CLI flags
2. `sourceline.config.json`
3. Environment variables
4. Built-in defaults

## Troubleshooting

CLI failures are printed as `SourceLine error: ...` with a non-zero exit code. For stack traces while debugging local development, set:

```bash
SOURCELINE_DEBUG=1
```

## CI Gates

Use `--fail-on` when SourceLine should fail a script or CI job after writing the report:

```bash
node packages/cli/dist/index.js check examples/answer.md --fail-on review
```

Levels:

- `never`: always exit 0 when the run itself succeeds.
- `review`: exit 2 for `partially_supported`, `unsupported`, `contradicted`, or `not_enough_evidence` claims.
- `unsupported`: exit 2 for `unsupported` or `contradicted` claims.
- `contradicted`: exit 2 only for contradicted claims.

## Local Source Ignore Rules

Use `.sourcelineignore` to exclude files from local source-folder retrieval:

```gitignore
private/
*.draft.md
!public/keep-this-source.md
```

Rules are evaluated in order. Later `!` rules can re-include specific files or folders.

## Current Scope

- TypeScript workspace.
- `sourceline check <file>` and `sourceline init`.
- `sourceline cache info` and `sourceline cache clear` for local retrieval cache maintenance.
- Markdown, txt, HTML, stdin, and http(s) URL input.
- Mock claim extraction and mock evidence.
- OpenAI-compatible LLM provider.
- Local Markdown/txt/HTML source-folder retrieval via `--sources`.
- `.sourcelineignore` support, including negation rules, for local source folders.
- Tavily and Brave web search providers.
- Same-run search query caching to avoid duplicate provider calls.
- Local retrieval uses an in-memory inverted index for candidate chunks, plus BM25-style scores, matched terms, title/phrase boosts, concise snippets, HTML cleanup, and a cross-run incremental cache for unchanged source files.
- Local retrieval cache status and cleanup commands.
- Terminal, Markdown, JSON, and single-file HTML reports.
- HTML claim index, full status filters, search, visible claim counts, keyboard shortcuts, visible-claim copying, reset, JSON download, print styles, and accessibility landmarks.
- JSON config loading.
- Friendly CLI errors with strict option parsing and optional debug stack traces.
- CI gate support via `--fail-on` and `SOURCELINE_FAIL_ON`.
- GitHub Actions CI workflow plus composite action smoke coverage.
- Vitest coverage for core pipeline, config, providers, local retrieval, and report rendering.

## GitHub Action

This repository includes a composite action:

```yaml
- uses: ./
  with:
    input: examples/answer.md
    config: examples/sourceline.config.json
    output: sourceline-report.md
    fail-on: review
```

Action inputs map to the main CLI flags, including `config`, `provider`, `base-url`, `model`, `search`, `sources`, `max-claims`, `max-results`, `min-confidence`, `provider-timeout-ms`, `report`, `output`, and `fail-on`. Optional inputs are only passed when non-empty, so config files, environment variables, and CLI defaults keep their normal priority. If no `config` or `report` is provided, the Action defaults to a Markdown report. For cloud providers, pass `allow-cloud: "true"` and provide the required API keys as workflow secrets. `extra-args` is supported for advanced cases and treats each non-empty line as one CLI argument. The repository CI runs build/typecheck, tests, CLI smoke checks, and the composite action against the example input.

## Release Preparation

Release checks and publish steps are tracked in [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md). Package manifests currently stay private until the license, npm names, and repository URL are confirmed.

## Next Milestones

- Confirm license, npm package names, and repository URL for first public release.
- PDF input.
- Next.js web demo.
