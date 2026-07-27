import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveFilename,
  parseFileSpec,
  sanitizeArtifactName,
  sanitizeRelativePath,
} from "./fetch-files.ts";

test("parses plain, named, and JSON entries", () => {
  assert.deepEqual(
    parseFileSpec(`
# comment
https://example.com/a.zip
renamed.bin :: https://example.com/download?id=1
{"url":"https://example.com/b","name":"nested/b.bin","sha256":"${"a".repeat(64)}"}
`),
    [
      { url: "https://example.com/a.zip" },
      { url: "https://example.com/download?id=1", name: "renamed.bin" },
      { url: "https://example.com/b", name: "nested/b.bin", sha256: "a".repeat(64) },
    ],
  );
});

test("parses a compact JSON array", () => {
  assert.deepEqual(
    parseFileSpec('[{"url":"https://example.com/a"},{"url":"https://example.com/b","name":"b.bin"}]'),
    [
      { url: "https://example.com/a", name: undefined, sha256: undefined },
      { url: "https://example.com/b", name: "b.bin", sha256: undefined },
    ],
  );
});

test("rejects unsupported protocols and traversal", () => {
  assert.throws(() => parseFileSpec("file:///etc/passwd"), /only HTTP/);
  assert.throws(() => sanitizeRelativePath("../escape"), /unsafe path segment/);
  assert.throws(() => sanitizeRelativePath("/absolute"), /must be relative/);
});

test("derives filenames from content disposition and URL", () => {
  assert.equal(deriveFilename("https://example.com/ignored", 'attachment; filename="hello world.zip"', 0), "hello world.zip");
  assert.equal(deriveFilename("https://example.com/path/model.glb?download=1", null, 0), "model.glb");
  assert.equal(deriveFilename("https://example.com/", null, 4), "download-005.bin");
});

test("sanitizes artifact names", () => {
  assert.equal(sanitizeArtifactName('  files: one/two?  '), "files-one-two");
  assert.equal(sanitizeArtifactName("...."), "downloaded-files");
});
