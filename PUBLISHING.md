# Publishing

Publisher: `CyprienCourtot`. Extension ID: `CyprienCourtot.shift-shift`.

Publishing is a maintainer action. CI validates and packages changes but does not upload them to the Marketplace.

## Prepare a release

1. Update `package.json`, the root version in `package-lock.json`, and `CHANGELOG.md`. Keep the worker version in `engine/Cargo.toml` and `engine/Cargo.lock` aligned.
2. Run the checks in `README.md`. Test the physical double-Shift chord, native picker navigation, reindexing and Remote SSH behavior on supported hosts.
3. Build each worker and package matching VSIXs. On macOS ARM64 with Rust targets, `cargo-zigbuild` and Zig installed:

   ```sh
   npm run build:worker
   npm run build:worker -- --cross \
     --target x86_64-unknown-linux-musl --target aarch64-unknown-linux-musl
   npm run build
   npm run package -- --target darwin-arm64 linux-x64 linux-arm64
   ```

   Append `--pre-release` to the package command for a Marketplace pre-release. Pre-release and stable versions must use distinct numeric versions; suffixes such as `-beta` are unsupported.

4. Inspect each archive for the publisher, version, target platform, worker checksum, license notices and absence of private source/results. Install the final archive into an isolated VS Code profile and verify it. Prefer the exact successful main-branch CI artifacts and verify their provenance:

   ```sh
   gh attestation verify artifacts/shift-shift-<version>-<platform>.vsix --repo cyprienc/shift-shift
   ```

   Main builds also include a CycloneDX dependency inventory. The provenance job signs only this repository's successful main pushes, with no source execution or publishing credentials in the signing job. Local builds have no CI attestation.

## Upload

The first release can be uploaded through [Marketplace publisher management](https://marketplace.visualstudio.com/manage), under the existing publisher. Upload all matching platform packages to the same extension/version listing. A universal package is not provided because unsupported hosts cannot run the worker.

For automated publishing, use the [official Microsoft instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), preferably Microsoft Entra ID authentication. For example, after authenticating an identity that is a member of the publisher:

```sh
npx --no-install vsce publish --azure-credential --packagePath \
  artifacts/shift-shift-<version>-darwin-arm64.vsix \
  artifacts/shift-shift-<version>-linux-x64.vsix \
  artifacts/shift-shift-<version>-linux-arm64.vsix
```

Never commit credentials or put publishing tokens in issues or chat. Use the platform metadata already in each VSIX; keep the publisher/name stable for automatic upgrades.
