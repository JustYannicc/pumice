# Claude release scanner tools

These repository tools read an extracted Claude Code release, build a static module inventory, and produce a report or inventory diff. They are not part of Pumice's published package API.

The scanner reads a locally supplied extraction tree and capability manifest. Its reports contain module names, import relationships, runtime API names, and diagnostics, but not source bodies. Keep extracted provider files, binaries, and generated reports in the environment that needs them; do not publish them as package contents or CI artifacts.

`bun-graph.ts` retains its source attribution to `DigiBugCat/codex-wasi-agentos` under Apache-2.0. The corresponding upstream license and notice are in [`licenses/`](licenses/). The graph fixture is synthetic test data.

Run the scanner with local extraction and capability inputs:

```sh
pnpm scan:claude-release <extracted> <capabilities.json> <new-output-directory> <version> <platform> <bun-version-or-unknown> [baseline-inventory.json]
```

The new output directory receives `inventory.json` and `release-report.json`, plus `diff.json` when a baseline is supplied. Existing output directories are refused. Static findings leave execution checks pending until a runtime proof supplies their evidence.

Use `pnpm test:claude-release` for the focused scanner tests and `pnpm typecheck:claude-release` to check the tool sources.

Use the gitignored `.local/` directory for local provider inputs and outputs. Download and extract an official release, or extract a binary you already have:

```sh
node tools/claude-release/releases.ts .local/claude-releases latest linux-x64
node tools/claude-release/extract.ts <binary> .local/claude-extracted
```

Keep provider binaries and extracted JavaScript local. The scanner accepts those paths without adding them to source or package contents.
