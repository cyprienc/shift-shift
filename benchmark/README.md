# Reproduce locally

Keep source snapshots, symbol exports and results local: they contain private paths and names. No benchmark files are shipped in VSIX packages.

1. Build the Rust release worker and JavaScript (`README.md`). Use Python 3.12+ for the independent AST inventory. `prepare.py` copies tracked `.py`/`.pyi` files without importing or running them.

```sh
python3 benchmark/prepare.py /path/to/repo /path/to/benchmark
python3 benchmark/subset.py /path/to/benchmark /path/to/small-benchmark 1000
# Optional final argument: saved subset manifest to reconstruct precisely the same paths.
node benchmark/coverage.mjs /path/to/small-benchmark
node benchmark/worker-bench.mjs /path/to/small-benchmark
```

2. Install actual Microsoft Python/Pylance packages in an isolated directory. The runner expects `<tools>/benchmark-extensions/python/extension` and `<tools>/benchmark-extensions/vscode-pylance/extension`, each containing the vendor package's `package.json`. Set `SHIFT_BENCH_NODE` to your Node 22 executable for the unlimited profile. Do not substitute Pyright for Pylance.

3. Build the controller to `<tools>/benchmark-controller/extension.js`:

```sh
./node_modules/.bin/esbuild benchmark/controller.ts --bundle --platform=node \
  --format=cjs --external:vscode --outfile=/path/to/tools/benchmark-controller/extension.js
```

Its adjacent `package.json` must be:

```json
{"name":"shift-benchmark","publisher":"local","version":"0.1.0","engines":{"vscode":"^1.100.0"},"main":"./extension.js","activationEvents":["*"]}
```

4. Set paths and run the profiles sequentially, with no competing benchmark or build and the computer kept awake:

```sh
export SHIFT_BENCH_TOOLS=/path/to/tools
export SHIFT_BENCH_CORPUS=/path/to/small-benchmark
export SHIFT_BENCH_CODE='/Applications/Visual Studio Code.app/Contents/MacOS/Code'
SHIFT_BENCH_RUN=1 python3 benchmark/run.py pylance-default rust
SHIFT_BENCH_RUN=2 python3 benchmark/run.py pylance-default rust
SHIFT_BENCH_RUN=3 python3 benchmark/run.py pylance-default rust
```

The macOS runner creates fresh short `/tmp` user-data paths, avoiding Unix socket length limits, and isolated extension directories. It disables updates/telemetry/Git, activates the Python extension, opens the fixture and observes Pylance indexing logs plus a successful fixture symbol query. Readiness is measured from controller activation, excluding VS Code launch. This is observed navigation readiness, not proof all workspace files have been fully analyzed. `pylance-default` uses `userFileIndexingLimit:2000`; `pylance-unlimited` uses `-1` and an external Node process with a 16 GiB heap.

There are 200 deterministic queries (40 each exact, prefix, subsequence, suffix, missing), three shuffled passes, raw result exports and target recall. All 160 targets are kept when creating the small subset. The controller asks VS Code's real `vscode.executeWorkspaceSymbolProvider`; Rust uses the same client transport as the extension. Timing includes IPC/result decoding, excludes gzip/file persistence, and uses unbounded results to detect coverage loss. The UI normally returns the best 100; `worker-bench.mjs` measures that path separately. Picker rendering, the 25 ms typing debounce, and human keypress time are excluded.

Literal substring Rust queries are an additional diagnostic; Pylance's API cannot select the same matching predicate. Result sets and symbol kinds differ. Compare requested target recall and identical returned definition sets as well as latency; do not label all returned sets equivalent or a failed/empty provider response a speedup.

`process-metrics.json` samples backend and whole-app RSS every 250 ms; backend memory excludes UI/extension host. Worker-only sampling uses its process ID. `results.json.partial` preserves intermediate passes; `provider-errors.json` and vendor logs identify failures. Keep pilots, errors, restarts and excluded runs explicit. Timings are warm-filesystem local measurements, not cold-disk or Remote SSH claims.
