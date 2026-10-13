# Security boundary

This extension is not audited software or an OS sandbox.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/cyprienc/shift-shift/security/advisories/new) for security issues. Include the version, affected platform and a minimal reproducer. Do not include credentials or private workspace source in a public issue.

## Supply chain and CI

- Direct npm and Rust dependencies use exact versions; lockfiles pin the full dependency graph and integrity checksums.
- npm lifecycle scripts are disabled by `.npmrc` and `npm ci --ignore-scripts`. Explicit project build commands still run. Rust dependencies can execute build scripts and procedural macros; locked versions and audits do not make those sandboxed.
- CI actions use full commit SHAs, checkout does not persist its GitHub token, and the default workflow permission set is empty. Build and audit jobs receive only `contents: read` on GitHub-hosted runners with no publishing secrets.
- CI does not use `pull_request_target`, run on self-hosted cluster machines, share build caches or automatically publish Marketplace packages. Pull-request artifacts are not uploaded or promoted to releases.
- Weekly npm/Rust advisory checks, Dependabot update PRs with a seven-day version-update cooldown, CodeQL for TypeScript/JavaScript, a pinned workflow-security scanner and a pinned secret scanner check changes. Dependencies and actions must be reviewed before upgrades; automatic merging is not configured.
- Packaging copies an explicit set of public files and includes a worker checksum. The official worker build remaps machine-specific compiler paths. Bundled checksums detect accidental changes, not a maliciously substituted package.
- Each build emits a CycloneDX inventory from both lockfiles, including build-time dependencies. A separate job with no source checkout or code execution creates GitHub/Sigstore provenance attestations only after the main-branch build and dependency/workflow checks succeed. Signing uses short-lived OIDC; build jobs cannot attest or publish.
- Before Marketplace publication, verify the source commit, all CI checks, artifact provenance and the exact VSIX on each advertised runtime. Provenance identifies a build and artifact digest; it does not establish that the code is safe. CI artifacts are not release approval.
- Release preparation requires a current main commit from an independently approved merged PR, verified signatures, successful expected CI/CodeQL jobs and provenance bound to the exact commit and build run. A protected environment requires approval by the other named maintainer for the exact artifact hashes. The verifier rejects a missing reviewer, self-approval configuration, administrator deployment bypass or a branch policy broader than `main`. The release workflow has no publishing credentials and never executes downloaded artifacts.
- Repository administrators can alter protection settings. Workflow permissions are declarations, not an immutable security boundary against someone who can change workflows. A compromised Marketplace account with upload rights can publish outside GitHub regardless of CODEOWNERS, signatures or attestations. Isolate publisher upload and administration access from everyday GitHub identities; see `PUBLISHING.md`. These controls reduce attack paths and do not prove an extension non-malicious.

## Runtime

- Source is read and parsed; Python is never imported or executed.
- No networking, telemetry, shell execution, package installation or project-command execution occurs at runtime.
- The extension spawns only the bundled worker (`shell: false`) and validates its SHA-256 against the packaged manifest.
- The worker receives only locale variables, not the extension host's environment or credentials. Loader injection variables such as `LD_PRELOAD` and `DYLD_INSERT_LIBRARIES` are not inherited.
- Worker updates and removals are confined to configured roots, reject traversal and reject observed symlinks. Navigation rechecks the path before opening it.
- Source files are not modified. Only a private system-temp index and VS Code output/status logs are written.
- Restricted/untrusted workspaces and virtual filesystems are unsupported.
- The Rust application has `#![forbid(unsafe_code)]`. This does not forbid unsafe implementation code in its dependencies.
- Parsing uses four workers by default; update concurrency is bounded, and only one query is active. Input frames are limited to 16 MiB; queries to 4 KiB. Normal picker queries allocate at most the configured result limit.
- This is not a boundary against a malicious process running as the same user. Filesystem checks have normal time-of-check/time-of-use races; another process can replace paths after validation. Checksums provide integrity within a trusted package, not signing or provenance.
- Resource budgets are estimates. Malformed/pathological source can still consume substantial CPU, memory or parser stack. Oversize disk/editor sources are reported as failures. A worker crash triggers one restart, then stops with an error and requires reindexing.
- Temporary storage contains private symbol names and paths. Clean extension shutdown removes it. Forced process termination can leave it behind; remove stale `shift-shift-*` directories under your system temp directory when no worker is running.

## Verification

On 2026-10-13, `cargo audit --file engine/Cargo.lock` reported no vulnerabilities or warnings. Both `npm audit` and `npm audit --omit=dev` reported zero vulnerabilities after upgrading the development packaging tool to `@vscode/vsce` 4.0.0. There are no runtime npm dependencies. These are dated known-advisory checks, not a proof of safety.

The test suite covers root confinement, symlink/environment exclusion, Unicode positions, unsaved updates, directory removal, cancellation, malformed syntax, resource failure visibility, top-result ranking, forced disk fallback and search refresh during indexing. The README records remaining platform limitations. Build-time dependencies and toolchains are distinct from runtime behavior; install/build commands may access public registries.
