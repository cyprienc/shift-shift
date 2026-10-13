# Publishing

Publisher: `CyprienCourtot`. Extension ID: `CyprienCourtot.shift-shift-cc`.

Publishing is a maintainer action. CI validates and packages changes but does not upload them to the Marketplace. A separate release preparation workflow verifies reviewed source and exact artifact provenance, then requires independent approval before producing the upload bundle. That workflow has no Marketplace credentials or upload rights.

The first Marketplace release is a **0.1.1 pre-release for macOS ARM64 and Linux x64**. CI always sets and verifies the pre-release marker. Linux ARM64 is excluded from this release until its runtime is tested.

`cyprienc` and `jschweiz` are the designated code owners for every file. Require approval from a code owner other than the PR author, the existing CI checks and signed commits on `main`, including for administrators. GitHub requires code owners to have Write access. Code ownership is read from the PR's base branch, so the initial PR adding `CODEOWNERS` needs `jschweiz`'s approval checked explicitly before merging; later PRs use GitHub's code-owner gate.

## Prepare a release

1. Update `package.json`, the root version in `package-lock.json`, and `CHANGELOG.md`. Keep the worker version in `engine/Cargo.toml` and `engine/Cargo.lock` aligned.
2. Run the checks in `README.md`. Test the physical double-Shift chord, native picker navigation, reindexing and Remote SSH behavior on supported hosts.
3. Prefer the exact packages from the successful main-branch CI run after the reviewed PR merges. For local reproduction on macOS ARM64 with the Linux x64 Rust target, `cargo-zigbuild` and Zig installed:

   ```sh
   npm run build:worker
   npm run build:worker -- --cross \
     --target x86_64-unknown-linux-musl
   npm run build
   npm run package -- --target darwin-arm64 linux-x64 --pre-release
   python3 scripts/verify-package.py --target darwin-arm64 --pre-release
   python3 scripts/verify-package.py --target linux-x64 --pre-release
   ```

   Pre-release and stable versions must use distinct numeric versions; suffixes such as `-beta` are unsupported. Version 0.1.1 has not been published to the Marketplace, so it is available for this first pre-release. A future stable release must use a higher version and change the CI packaging channel explicitly.

4. Inspect each archive for the publisher, version, target platform, worker checksum, license notices and absence of private source/results. Install the final archive into an isolated VS Code profile and verify it. The release preparation workflow enforces the following stronger provenance policy:

   ```sh
   gh attestation verify artifacts/shift-shift-cc-<version>-<platform>.vsix \
     --repo cyprienc/shift-shift \
     --signer-workflow cyprienc/shift-shift/.github/workflows/ci.yml \
     --source-ref refs/heads/main --source-digest <reviewed-commit-sha> \
     --signer-digest <reviewed-commit-sha> --deny-self-hosted-runners
   ```

   Main builds also include a CycloneDX dependency inventory. The provenance job signs only this repository's successful main pushes, with no source execution or publishing credentials in the signing job. Local builds have no CI attestation.

## Approve the exact release bundle

1. Both `cyprienc` and `jschweiz` must be listed in the `release-approval` environment's required reviewers, with self-review prevented, administrator bypass disabled, and an explicit branch policy allowing only `main`. Jonas must accept the collaborator invitation before GitHub will retain him in this list. Recheck the environment after acceptance; release preparation refuses to proceed while either reviewer is missing.
2. After a reviewed PR merges, wait for its **main-push** CI and CodeQL runs to pass. Use the current `main` commit and CI run's first attempt. The initial repository commit has no independently reviewed PR and cannot qualify as a release candidate.
3. The release PR author uses **Actions → Prepare reviewed release → Run workflow**, selects `main` and provides that full commit SHA and CI run ID. Only the two named maintainers may initiate it, and the initiator must be the PR author so that the other owner must approve the artifacts. The verifier requires a merged PR approved by the other maintainer on its final head, verified commit signatures, all expected successful jobs, both platform artifacts, and cryptographically verified provenance tied to the exact source SHA, signer SHA and CI run. It never runs downloaded package contents.
4. The other maintainer downloads `release-candidate` from that workflow run, inspects the exact packages and their provenance, checks the SHA-256 values shown in the preparation job summary, then approves the waiting environment job. An approval concerns the exact bytes, not just the source PR. The approval job copies the same candidate to `approved-release` without repository checkout, builds or package execution.
5. The publisher verifies that both jobs succeeded in the expected main-branch `release.yml` run, that the approval came from the other named maintainer, and that every file still matches `release-manifest.json`. Download `approved-release` from that exact run and repeat provenance verification before uploading those VSIXs. Do not rebuild, repackage, edit, or substitute artifacts after approval.

The workflow does not enforce safety of arbitrary source, and repository administrators can edit or delete its environment policy. Neither CODEOWNERS nor a green workflow is a guarantee against a compromised administrator. The separate publisher must independently check the reviewed source, workflow revision, approval and exact artifact hashes.

## Isolate Marketplace publishing access

Recommended: use a dedicated Microsoft publishing identity protected by hardware-backed authentication, kept out of everyday developer/browser sessions. Keep Marketplace membership minimal. Neither an everyday GitHub identity nor build CI should have an unattended path to publishing credentials. If automated publication is added later, use short-lived Microsoft Entra credentials behind independently administered approval and exact workload/ref restrictions, rather than a long-lived PAT. GitHub workflow defaults are not a permission ceiling.

The Marketplace upload path does not enforce this repository's review or provenance policy. A person controlling a Marketplace identity with upload rights can bypass the entire GitHub process. An owner can also change publisher membership. Preventing a compromise of one everyday developer identity from publishing requires keeping both publisher upload and publisher administration access outside that identity. A compromise of the ultimate publishing administrator remains a trust boundary. No Marketplace account or membership changes have been made by this PR.

## Upload

After the exact release bundle is independently approved, upload through [Marketplace publisher management](https://marketplace.visualstudio.com/manage), under the existing publisher. For the first package, select **New extension → Visual Studio Code**. For the second platform package, use **Update** on the existing extension instead of creating another extension. Upload all matching platform packages to the same extension/version listing. A universal package is not provided because unsupported hosts cannot run the worker.

Marketplace requires globally unique package names. `shift-shift` is already owned by another publisher, so this project uses `shift-shift-cc`; the visible title and shortcut remain Shift Shift. If uploading reports a name collision, check for an existing listing under this publisher before changing the identity. Any package identity change requires reviewed source, new CI artifacts and fresh independent artifact approval; never edit an approved VSIX in place.

For automated publishing, use the [official Microsoft instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), preferably Microsoft Entra ID authentication. For example, after authenticating an identity that is a member of the publisher:

```sh
npx --no-install vsce publish --azure-credential --packagePath \
  artifacts/shift-shift-cc-<version>-darwin-arm64.vsix \
  artifacts/shift-shift-cc-<version>-linux-x64.vsix
```

Never commit credentials or put publishing tokens in issues or chat. Use the platform metadata already in each VSIX; keep the publisher/name stable for automatic upgrades.
