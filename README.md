# Shift Shift

Local file and Python symbol search for VS Code, backed by a Rust worker. Tap and release **Shift twice within 300 ms** to open search. VS Code handles the modifier chord; the extension installs no keyboard hook.

## Install and use

This repository contains the source for `CyprienCourtot.shift-shift`. The first Marketplace pre-release is being prepared for macOS ARM64 and Linux x64. Build a VSIX using the instructions below, then install it with **Extensions → … → Install from VSIX…** and open a trusted filesystem workspace. Linux ARM64 source builds are experimental and still need runtime testing. For Remote SSH, install the matching Linux package on the remote extension host.

Search starts indexing on first use. Files are parsed in bounded batches during discovery, so results appear before the entire directory tree has been walked. Open Python documents are indexed first. The picker refreshes as indexing progresses; its status bar shows the number of files indexed so far.

- Type a name to search files and Python definitions together.
- Prefix with `@` for symbols or `/` for files.
- Press Enter to open the file at the definition.
- Run **Shift Shift: Index Status** to inspect progress, excluded paths, parse issues and failures.
- Run **Shift Shift: Reindex** after changing workspace roots or exclusion settings, or to retry a failed worker.

The shortcut is inactive in the terminal. **Shift Shift: Open Search** also works from the Command Palette. Rebind it using VS Code's Keyboard Shortcuts editor.

## Coverage

Every eligible file is searchable by path. `.py` and `.pyi` files are parsed for classes, functions (including nested functions), methods, module/class assignment variables and constants, and type aliases. Parameters, function-local assignments, instance attributes, import aliases and dynamically generated definitions are outside this index's scope. Other languages have file search only.

There is **no file-count limit**. `.gitignore` is deliberately ignored and `third_party` is included. These directory/component names are excluded by default:

```text
.git .hg .svn .venv venv node_modules __pycache__ .mypy_cache
.ruff_cache .pytest_cache target build dist .cache site-packages
```

Symlinks are excluded, including symlink workspace roots. Add other environment, generated-output or dependency paths with `shiftShift.exclude`. Glob patterns are relative to each workspace root; to prune a directory and its contents, use e.g. `vendor` and `vendor/**`, or `**/generated` and `**/generated/**`.

The default picker displays the best 100 results, configurable up to 1,000 with `shiftShift.resultLimit`. This limits display and result allocation, not index coverage. Fuzzy matching uses qualified symbol names; exact and prefix name matches receive a ranking bonus.

Unsaved Python edits update the index after a 100 ms debounce, with pending edits flushed before searching. Filesystem events update saved files. A closed document reloads its disk content. OS/VS Code watcher exclusions and limits can delay or miss filesystem events; reindex reconciles the workspace.

Invalid Python is parsed with recovery and reported in Index Status. Unreadable files, unsupported encodings, oversize sources or storage failures are reported there. A completed scan can still have failures; inspect status before assuming complete coverage.

## Local storage and safety

The worker reads source without importing Python, running project commands or making network requests. It runs with the extension host's user permissions and is **not an OS sandbox**. The application's Rust source forbids unsafe code; dependencies may use unsafe internally. See the included `SECURITY.md` for the precise boundary and verification.

The default `shiftShift.memoryBudgetMiB` is 1,024. This is an **estimate, not a hard RSS limit**. Half is reserved for transient parsing, query snapshots and overhead. Above the record threshold the index moves to private session-local redb storage (`0700` directory, `0600` file). Large files exceeding one eighth of the budget are reported as failed. Disk fallback is slower; temporary allocations can exceed estimates.

ASTs and source buffers are discarded after extraction. Disk storage contains names, positions and paths, not complete source text. Clean shutdown deletes the session directory; a forced host/OS crash can leave it under the system temp directory. No search history or telemetry is stored. Status logs can contain private paths. Checksums detect accidental binary changes; they do not establish package authenticity.

## Build

Requires Node 22+ and Rust 1.97. Dependencies are locked. From this directory:

```sh
npm ci
npm run build:worker
npm run build
npm run typecheck
cargo test --locked --manifest-path engine/Cargo.toml
cargo clippy --locked --manifest-path engine/Cargo.toml -- -D warnings
npm test
npm run package
```

`npm run package` packages the current supported host. VSIX files appear in `artifacts/`. To cross-compile the Linux targets from macOS ARM64, install `cargo-zigbuild` and Zig, then run:

```sh
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
npm run build:worker -- --cross \
  --target x86_64-unknown-linux-musl --target aarch64-unknown-linux-musl
npm run package -- --target darwin-arm64 linux-x64 linux-arm64
```

Each VSIX includes only its platform's worker, bundled JavaScript and license/security documentation. No runtime npm dependencies. The cross-compiled Linux musl binaries are statically linked. macOS ARM64 and Linux x64 have passed native smoke checks; Linux ARM64 has been cross-compiled and inspected but still needs runtime testing. Windows and Intel macOS packages are not available yet.

## Benchmarks

See [benchmark/README.md](benchmark/README.md) to compare against actual Pylance on your own source snapshot and verify extraction coverage against CPython. The original development corpus and raw results are private and are not distributed here. Query semantics and definition coverage differ, so compare successful target recall and matching result sets along with latency. Pylance remains useful for type checking, completion, references and semantic analysis; this extension provides lexical definition navigation.

## Contributing and publishing

Run the build and checks above before submitting a pull request. Report bugs through [GitHub Issues](https://github.com/cyprienc/shift-shift/issues), including extension version, platform and Index Status, with private paths and symbol names removed.

The repository disables npm install scripts, pins CI actions, runs dependency and workflow audits, and keeps publishing credentials out of build jobs. A separate release workflow verifies reviewed source and exact package provenance, then requires independent approval of the package hashes before producing an upload bundle. See [SECURITY.md](SECURITY.md) for the supply-chain controls, private reporting channel and remaining runtime limitations.

See [PUBLISHING.md](PUBLISHING.md) for platform packaging and Marketplace release steps. The project uses the [MIT license](LICENSE); dependency licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
