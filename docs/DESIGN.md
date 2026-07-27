# Design

## Success criteria

1. Accept one or many arbitrary public HTTP(S) URLs through `workflow_dispatch` or a trusted `[fetch-files]` issue.
2. Preserve caller-selected filenames without allowing path traversal.
3. Retry transient failures and enforce per-attempt timeouts and per-file size limits.
4. Stream downloads to disk and publish partial successes even when the job fails.
5. Emit deterministic SHA-256 checksums and a machine-readable manifest.
6. Support authenticated hosts without exposing credentials in workflow inputs or leaking them across redirects.
7. Return the artifact ID to issue-based callers so connector clients can retrieve the ZIP.
8. Keep installation to two required repository files and no runtime package dependencies.

## Input grammar

Each non-empty, non-comment line is one of:

```text
URL
relative/name :: URL
{"url":"URL","name":"relative/name","sha256":"64 hex characters"}
```

The JSON form is intended for exact checksum verification. Authentication is deliberately configured separately through a repository secret.
