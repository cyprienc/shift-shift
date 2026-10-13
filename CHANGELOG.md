# Changelog

## 0.1.1

- Parse files during directory discovery and show incremental indexing progress.
- Index open Python documents before the full scan reaches them.
- Refresh search results during indexing without postponing or cancelling a slower query.
- Preserve newer editor updates and directory removals during the initial scan.

## 0.1.0

- Native VS Code picker bound to double Shift.
- Local Rust index for file paths and Python definitions, without a file-count cap.
- Case-insensitive fuzzy search, unsaved-document updates and private disk fallback.
- macOS ARM64, Linux x64 and Linux ARM64 packaging.
