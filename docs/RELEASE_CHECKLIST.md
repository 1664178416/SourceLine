# SourceLine Release Checklist

Use this checklist before publishing an npm CLI package or tagging a GitHub Action release.

## 1. Release Identity

- Choose and add the project license, then replace `UNLICENSED` in package manifests.
- Add `LICENSE` at the repository root.
- Confirm npm package names are available or intentionally scoped:
  - `sourceline`
  - `@sourceline/core`
  - `@sourceline/config`
  - `@sourceline/providers`
  - `@sourceline/report`
- Add verified `repository`, `homepage`, and `bugs` fields after the remote URL is final.
- Decide whether internal packages are public API packages or kept private.

## 2. Version And Metadata

- Set the same release version across workspace packages. `corepack pnpm run release:verify-manifests` checks this before release packaging.
- Remove `private: true` only from packages that should be publishable.
- For scoped public packages, add `publishConfig.access = "public"`.
- Update README examples if command names, report names, or provider defaults changed.
- Add or update changelog/release notes.

## 3. Local Verification

Run from the workspace root:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run release:verify-manifests
corepack pnpm run check
corepack pnpm test
corepack pnpm run release:check
```

`corepack pnpm run release:check` also verifies workspace manifests and the generated tarball in `.tmp-pack`:

- Workspace package versions and Node engine requirements match the root manifest.
- Internal workspace dependencies still use `workspace:*` before packing.
- The generated CLI tarball contains `dist/` and `package.json`.
- It does not contain `src/`, test files, `.tmp-*`, `.sourceline/`, or local reports.
- The `bin.sourceline` path points to `dist/index.js`.
- The CLI starts with `#!/usr/bin/env node`.
- `corepack pnpm run release:verify-tarball` passes against the generated tarball.

## 4. CLI Smoke

```bash
node packages/cli/dist/index.js check examples/answer.md --report terminal
node packages/cli/dist/index.js check examples/answer.md --json > .tmp-smoke/sourceline-report.json
node packages/cli/dist/index.js check examples/sources/web-evidence.html --report markdown --out .tmp-smoke/html-input-report.md
node packages/cli/dist/index.js check examples/answer.md --report html --out .tmp-smoke/sourceline-report.html
node packages/cli/dist/index.js check examples/answer.md --search local --sources examples/sources --report markdown --out .tmp-smoke/local-report.md
node packages/cli/dist/index.js cache info --sources examples/sources
```

Local source smoke should cover Markdown/txt/HTML files when the examples folder includes them.

## 5. GitHub Action Smoke

- Run the `SourceLine CI` workflow on the release branch. It should pass the workspace manifest and package smoke checks.
- Confirm the composite action can use `config` without explicit `report`, `search`, or `sources` inputs, and still generates the expected artifact with local sources.
- Confirm the action smoke fails if the generated report no longer includes expected local source evidence such as `SourceLine Notes` and `AI Answer Review Notes`.
- Confirm cloud-provider examples still require explicit `allow-cloud: "true"`.

## 6. Publish

- Publish npm packages in dependency order if they are public:
  1. `@sourceline/core`
  2. `@sourceline/config`
  3. `@sourceline/report`
  4. `@sourceline/providers`
  5. `sourceline`
- Create a GitHub release/tag for the composite action.
- Record the package version, tag, and CI run URL in release notes.

## 7. Post-Publish Verification

From a clean directory:

```bash
npx sourceline --version
npx sourceline check <path-to-sample.md> --report terminal
```

For the GitHub Action, test a workflow that uses the tagged release instead of `./`.