# Validation

Validated on 2026-07-27.

## Automated checks

- Six parser, filename, path traversal, JSON, and artifact-name unit tests passed.
- Strict TypeScript checking passed with TypeScript 5.8.3 and Node.js type definitions.
- Workflow and issue-form YAML parsed successfully.

## End-to-end HTTP test

A local HTTP server was used to verify:

- Concurrent downloads.
- Same-host redirects.
- Cross-host redirects without forwarding host-scoped authorization headers.
- Retry of HTTP 503 followed by successful completion.
- No retry for permanent HTTP 404 failure.
- Partial-success manifest generation and non-zero exit status.
- SHA-256 generation and GitHub step outputs.

The integration result contained three successful files and one expected permanent failure.
