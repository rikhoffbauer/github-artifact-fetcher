# GitHub Artifact Fetcher

A GitHub Actions workflow that downloads public or authenticated HTTP(S) files on a GitHub-hosted runner and publishes them as a workflow artifact. It supports manual dispatch and trusted issue-based requests for connector clients.

The artifact contains the downloaded files plus:

- `manifest.json`: source URL, final URL, output path, byte count, SHA-256, attempts, and failures.
- `SHA256SUMS`: checksums suitable for `shasum -a 256 -c SHA256SUMS`.

## Install

Copy these files into the target repository:

```text
.github/workflows/fetch-files.yml
scripts/fetch-files.ts
```

Commit and push them to the repository's default branch. Both manual dispatch and issue-triggered execution use the workflow from the default branch.

## Run from GitHub

1. Open **Actions → Fetch files as artifact → Run workflow**.
2. Paste one entry per line into **files**.
3. Run the workflow.
4. Open the completed run and download the artifact.

Examples:

```text
https://example.com/archive.zip
model.glb :: https://example.com/download?id=123
models/chair.glb :: https://example.com/chair
{"url":"https://example.com/file.bin","name":"file.bin","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}
```

Blank lines and lines beginning with `#` are ignored. Duplicate output names are changed to `name-2.ext`, `name-3.ext`, and so on. A compact JSON array is also accepted when a UI does not support multiline values:

```json
[{"url":"https://example.com/a.zip"},{"url":"https://example.com/b","name":"b.bin"}]
```

## Run through a GitHub issue

This mode is designed for tools that can create GitHub issues and download Actions artifacts but cannot dispatch workflows directly.

Use the included **Fetch files as artifact** issue form, or create an issue whose title begins with:

```text
[fetch-files]
```

Put the file specification directly in the issue body. The workflow only accepts requests created by an `OWNER`, `MEMBER`, or `COLLABORATOR`. It downloads the files, comments with the workflow run ID and artifact ID, and closes the issue.

Example issue body:

```text
model.glb :: https://example.com/model.glb
https://example.com/textures.zip
```

The artifact ID in the bot comment can be passed directly to GitHub's Actions artifact download API or a connector wrapping that API.

## Run with GitHub CLI

A single URL:

```bash
gh workflow run fetch-files.yml \
  --repo OWNER/REPO \
  -f files='https://example.com/archive.zip' \
  -f artifact_name='archive'
```

Multiple URLs without fighting shell quoting:

```bash
cat > /tmp/fetch-inputs.json <<'JSON'
{
  "ref": "main",
  "inputs": {
    "files": "first.zip :: https://example.com/one\nsecond.bin :: https://example.com/two",
    "artifact_name": "download-batch",
    "concurrency": "4",
    "retries": "3",
    "request_timeout_seconds": "600",
    "max_file_size_mb": "4096",
    "fail_fast": "true",
    "compression_level": "0",
    "retention_days": "7"
  }
}
JSON

gh api \
  --method POST \
  -H 'Accept: application/vnd.github+json' \
  "/repos/OWNER/REPO/actions/workflows/fetch-files.yml/dispatches" \
  --input /tmp/fetch-inputs.json
```

Find and download the newest run:

```bash
RUN_ID="$({
  gh run list \
    --repo OWNER/REPO \
    --workflow fetch-files.yml \
    --event workflow_dispatch \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId'
})"

gh run watch "$RUN_ID" --repo OWNER/REPO --exit-status
gh run download "$RUN_ID" --repo OWNER/REPO --dir ./artifacts
```

## Authenticated downloads

Do not put credentials in workflow inputs; inputs are visible in workflow metadata.

Create a repository Actions secret named `DOWNLOAD_HEADERS_JSON`. Its value is a JSON object keyed by an exact hostname:

```json
{
  "downloads.example.com": {
    "Authorization": "Bearer secret-token"
  },
  "storage.example.net": {
    "Cookie": "session=secret-value"
  }
}
```

Headers are selected again after every redirect and are only sent to the exact matching hostname. They are never automatically forwarded to a different host.

## Behavior and limits

- Only `http://` and `https://` URLs are accepted.
- Redirects are limited to 10.
- Downloads are streamed to disk and written atomically through `.part` files.
- Retryable responses: HTTP 408, 425, 429, and 5xx.
- The size limit is applied per file, both from `Content-Length` and while streaming.
- A failed run still uploads its successful files and `manifest.json` because the upload step uses `always()`.
- `fail_fast=true` stops scheduling new files after a failure; already-running downloads finish.
- GitHub artifacts are ZIP archives. Compression level `0` is recommended for GLB, ZIP, images, videos, and other already-compressed files.
- The downloader runs directly as TypeScript on Node.js 24 and has no runtime package dependencies.

## Security model

This workflow intentionally permits outbound requests to arbitrary HTTP(S) hosts. Manual dispatch is limited by repository Actions permissions. Issue-triggered requests are restricted to repository owners, members, and collaborators. Do not weaken that guard or add untrusted triggers such as `pull_request_target`. For the least abuse surface, use a private repository.
