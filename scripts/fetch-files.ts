import { createHash } from "node:crypto";
import { appendFileSync, createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { pathToFileURL } from "node:url";

export interface DownloadEntry {
  url: string;
  name?: string;
  sha256?: string;
}

interface DownloadResult {
  index: number;
  url: string;
  requestedName?: string;
  finalUrl?: string;
  outputPath?: string;
  bytes?: number;
  sha256?: string;
  status: "success" | "failed" | "skipped";
  attempts: number;
  contentType?: string | null;
  error?: string;
}

interface Config {
  outputDir: string;
  artifactName: string;
  concurrency: number;
  retries: number;
  timeoutMs: number;
  maxFileSizeBytes: number;
  failFast: boolean;
  hostHeaders: Record<string, Record<string, string>>;
}

const DEFAULT_USER_AGENT = "github-artifact-fetcher/1.0";
const MAX_REDIRECTS = 10;

export function parseFileSpec(spec: string): DownloadEntry[] {
  const trimmedSpec = spec.trim();
  if (trimmedSpec.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedSpec);
    } catch (error) {
      throw new Error(`Invalid JSON array: ${errorMessage(error)}`);
    }
    if (!Array.isArray(parsed)) throw new Error("File specification JSON must be an array");
    if (parsed.length === 0) throw new Error("No download entries were provided");
    return parsed.map((value, index) => normalizeJsonEntry(value, index + 1));
  }

  const entries: DownloadEntry[] = [];

  for (const [lineIndex, rawLine] of spec.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let entry: DownloadEntry;
    if (line.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`Line ${lineIndex + 1}: invalid JSON: ${errorMessage(error)}`);
      }
      entry = normalizeJsonEntry(parsed, lineIndex + 1);
    } else {
      const separator = line.indexOf(" :: ");
      entry = separator >= 0
        ? { name: line.slice(0, separator).trim(), url: line.slice(separator + 4).trim() }
        : { url: line };
    }

    validateHttpUrl(entry.url, lineIndex + 1);
    if (entry.name !== undefined) entry.name = sanitizeRelativePath(entry.name);
    if (entry.sha256 !== undefined) {
      entry.sha256 = entry.sha256.toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new Error(`Line ${lineIndex + 1}: sha256 must contain exactly 64 hexadecimal characters`);
      }
    }
    entries.push(entry);
  }

  if (entries.length === 0) throw new Error("No download entries were provided");
  return entries;
}

function normalizeJsonEntry(value: unknown, lineNumber: number): DownloadEntry {
  if (!isRecord(value) || typeof value.url !== "string") {
    throw new Error(`Line ${lineNumber}: JSON entry requires a string "url"`);
  }
  const entry: DownloadEntry = {
    url: value.url,
    name: typeof value.name === "string" ? value.name : undefined,
    sha256: typeof value.sha256 === "string" ? value.sha256.toLowerCase() : undefined,
  };
  validateHttpUrl(entry.url, lineNumber);
  if (entry.name !== undefined) entry.name = sanitizeRelativePath(entry.name);
  if (entry.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error(`Line ${lineNumber}: sha256 must contain exactly 64 hexadecimal characters`);
  }
  return entry;
}

export function sanitizeRelativePath(input: string): string {
  const trimmed = input.trim().replaceAll("\\", "/");
  if (!trimmed) throw new Error("Output name cannot be empty");
  if (trimmed.includes("\0")) throw new Error("Output name cannot contain NUL bytes");
  if (isAbsolute(trimmed) || /^[a-zA-Z]:\//.test(trimmed)) {
    throw new Error(`Output name must be relative: ${input}`);
  }

  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Output name contains an unsafe path segment: ${input}`);
  }

  const cleaned = segments.map(sanitizePathSegment).join("/");
  if (!cleaned) throw new Error("Output name is empty after sanitization");
  return cleaned;
}

export function sanitizeArtifactName(input: string): string {
  const cleaned = input
    .trim()
    .replace(/["':<>|*?\\/\r\n]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 200);
  return cleaned || "downloaded-files";
}

export function deriveFilename(url: string, contentDisposition: string | null, index: number): string {
  const fromHeader = filenameFromContentDisposition(contentDisposition);
  if (fromHeader) {
    const headerBasename = basename(fromHeader.replaceAll("\\", "/"));
    return sanitizeRelativePath(sanitizePathSegment(headerBasename));
  }

  const parsed = new URL(url);
  const candidate = decodeURIComponentSafe(basename(parsed.pathname));
  if (candidate && candidate !== "/" && candidate !== ".") {
    return sanitizeRelativePath(sanitizePathSegment(candidate));
  }
  return `download-${String(index + 1).padStart(3, "0")}.bin`;
}

function filenameFromContentDisposition(value: string | null): string | undefined {
  if (!value) return undefined;

  const extended = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (extended?.[1]) return decodeURIComponentSafe(stripQuotes(extended[1].trim()));

  const regular = value.match(/filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]+)/i);
  if (!regular?.[1]) return undefined;
  return stripQuotes(regular[1].trim()).replace(/\\"/g, '"');
}

function stripQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function sanitizePathSegment(segment: string): string {
  const cleaned = segment
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 240);
  return cleaned || "download.bin";
}

function validateHttpUrl(value: string, lineNumber?: number): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${lineNumber ? `Line ${lineNumber}: ` : ""}invalid URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${lineNumber ? `Line ${lineNumber}: ` : ""}only HTTP(S) URLs are supported: ${value}`);
  }
  return url;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string, minimum = 1): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected boolean value, received: ${value}`);
}

function parseHostHeaders(value: string | undefined): Record<string, Record<string, string>> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`DOWNLOAD_HEADERS_JSON is invalid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("DOWNLOAD_HEADERS_JSON must be a JSON object");

  const result: Record<string, Record<string, string>> = {};
  for (const [host, headers] of Object.entries(parsed)) {
    if (!isRecord(headers)) throw new Error(`Headers for ${host} must be a JSON object`);
    const normalizedHost = host.trim().toLowerCase();
    if (!normalizedHost || normalizedHost.includes("/") || normalizedHost.includes(":")) {
      throw new Error(`Header map key must be an exact hostname without scheme or port: ${host}`);
    }
    result[normalizedHost] = {};
    for (const [name, headerValue] of Object.entries(headers)) {
      if (typeof headerValue !== "string") throw new Error(`Header ${name} for ${host} must be a string`);
      if (/\r|\n/.test(name) || /\r|\n/.test(headerValue)) throw new Error(`Header ${name} for ${host} contains a newline`);
      result[normalizedHost][name] = headerValue;
    }
  }
  return result;
}

async function fetchWithRedirects(urlValue: string, config: Config, signal: AbortSignal): Promise<Response> {
  let current = validateHttpUrl(urlValue);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const headers = new Headers({
      Accept: "*/*",
      "User-Agent": DEFAULT_USER_AGENT,
      ...(config.hostHeaders[current.hostname.toLowerCase()] ?? {}),
    });

    const response = await fetch(current, {
      method: "GET",
      headers,
      redirect: "manual",
      signal,
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error(`HTTP ${response.status} redirect did not include a Location header`);
    if (redirect === MAX_REDIRECTS) throw new Error(`Exceeded ${MAX_REDIRECTS} redirects`);
    await response.body?.cancel();
    current = validateHttpUrl(new URL(location, current).toString());
  }

  throw new Error("Unreachable redirect state");
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  }
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);
}

async function downloadEntry(entry: DownloadEntry, index: number, config: Config, claimedPaths: Set<string>): Promise<DownloadResult> {
  let lastError = "Unknown download error";
  let attempts = 0;
  let claimedRelativePath: string | undefined;

  for (let attempt = 1; attempt <= config.retries + 1; attempt += 1) {
    attempts = attempt;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${config.timeoutMs / 1000} seconds`)), config.timeoutMs);
    let partPath: string | undefined;

    try {
      const response = await fetchWithRedirects(entry.url, config, controller.signal);
      if (!response.ok) {
        const message = `HTTP ${response.status} ${response.statusText}`;
        if (retryableStatus(response.status) && attempt <= config.retries) {
          await response.body?.cancel();
          lastError = message;
          console.warn(`Retrying ${entry.url} after attempt ${attempt}: ${lastError}`);
          await sleep(retryDelayMs(attempt, response.headers.get("retry-after")));
          continue;
        }
        throw new Error(message);
      }
      if (!response.body) throw new Error("Response contained no body");

      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength !== undefined && contentLength > config.maxFileSizeBytes) {
        throw new Error(`Content-Length ${contentLength} exceeds limit ${config.maxFileSizeBytes}`);
      }

      const initialName = entry.name ?? deriveFilename(response.url || entry.url, response.headers.get("content-disposition"), index);
      claimedRelativePath ??= claimUniquePath(initialName, claimedPaths);
      const relativePath = claimedRelativePath;
      const outputPath = resolveInside(config.outputDir, relativePath);
      partPath = `${outputPath}.part`;
      await mkdir(dirname(outputPath), { recursive: true });

      const hash = createHash("sha256");
      let bytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > config.maxFileSizeBytes) {
            callback(new Error(`Downloaded data exceeds limit ${config.maxFileSizeBytes} bytes`));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });

      await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(partPath, { flags: "wx" }));
      const digest = hash.digest("hex");
      if (entry.sha256 && digest !== entry.sha256) {
        throw new Error(`SHA-256 mismatch: expected ${entry.sha256}, received ${digest}`);
      }
      await rename(partPath, outputPath);
      partPath = undefined;

      return {
        index,
        url: entry.url,
        requestedName: entry.name,
        finalUrl: response.url || entry.url,
        outputPath: relative(config.outputDir, outputPath).split(sep).join("/"),
        bytes,
        sha256: digest,
        status: "success",
        attempts: attempt,
        contentType: response.headers.get("content-type"),
      };
    } catch (error) {
      lastError = errorMessage(error);
      if (partPath) await rm(partPath, { force: true }).catch(() => undefined);
      if (attempt <= config.retries && !/SHA-256 mismatch|exceeds limit|only HTTP|Output name/.test(lastError)) {
        console.warn(`Retrying ${entry.url} after attempt ${attempt}: ${lastError}`);
        await sleep(retryDelayMs(attempt, null));
        continue;
      }
      break;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    index,
    url: entry.url,
    requestedName: entry.name,
    status: "failed",
    attempts,
    error: lastError,
  };
}

function claimUniquePath(input: string, claimed: Set<string>): string {
  const normalizedInput = sanitizeRelativePath(input);
  if (!claimed.has(normalizedInput)) {
    claimed.add(normalizedInput);
    return normalizedInput;
  }

  const extension = extname(normalizedInput);
  const stem = extension ? normalizedInput.slice(0, -extension.length) : normalizedInput;
  for (let suffix = 2; suffix < 100_000; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!claimed.has(candidate)) {
      claimed.add(candidate);
      return candidate;
    }
  }
  throw new Error(`Could not allocate a unique output name for ${input}`);
}

function resolveInside(root: string, relativePath: string): string {
  const rootPath = resolve(root);
  const outputPath = resolve(rootPath, normalize(relativePath));
  const rel = relative(rootPath, outputPath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Output path escapes destination: ${relativePath}`);
  return outputPath;
}

async function runPool(entries: DownloadEntry[], config: Config): Promise<DownloadResult[]> {
  const results: DownloadResult[] = new Array(entries.length);
  const claimedPaths = new Set<string>();
  let cursor = 0;
  let stop = false;

  async function worker(): Promise<void> {
    while (!stop) {
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) return;

      const result = await downloadEntry(entries[index], index, config, claimedPaths);
      results[index] = result;
      logResult(result);
      if (config.failFast && result.status === "failed") stop = true;
    }
  }

  await Promise.all(Array.from({ length: Math.min(config.concurrency, entries.length) }, () => worker()));

  for (let index = 0; index < entries.length; index += 1) {
    if (!results[index]) {
      results[index] = {
        index,
        url: entries[index].url,
        requestedName: entries[index].name,
        status: "skipped",
        attempts: 0,
        error: "Skipped because fail-fast was triggered",
      };
    }
  }
  return results;
}

function logResult(result: DownloadResult): void {
  if (result.status === "success") {
    console.log(`✓ ${result.outputPath} (${result.bytes} bytes, sha256 ${result.sha256})`);
  } else {
    console.error(`✗ ${result.url}: ${result.error}`);
  }
}

async function writeReports(outputDir: string, results: DownloadResult[], startedAt: string): Promise<void> {
  const finishedAt = new Date().toISOString();
  const successes = results.filter((result) => result.status === "success");
  const manifest = {
    schemaVersion: 1,
    startedAt,
    finishedAt,
    successCount: successes.length,
    failureCount: results.filter((result) => result.status === "failed").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
    files: results,
  };
  await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(
    join(outputDir, "SHA256SUMS"),
    successes.map((result) => `${result.sha256}  ${result.outputPath}`).join("\n") + (successes.length ? "\n" : ""),
    "utf8",
  );
}

function setOutput(name: string, value: string | number | boolean): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.log(`output ${name}=${value}`);
    return;
  }
  requireSafeOutput(name, String(value));
  const line = `${name}=${value}\n`;
  appendFileSync(outputFile, line, "utf8");
}

function requireSafeOutput(name: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe output name: ${name}`);
  if (/\r|\n/.test(value)) throw new Error(`Output ${name} contains a newline`);
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const outputDir = resolve(".download-output");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const spec = process.env.DOWNLOAD_FILE_SPEC ?? "";
  const entries = parseFileSpec(spec);
  const maxFileSizeMb = parsePositiveInteger(process.env.DOWNLOAD_MAX_FILE_SIZE_MB, 4096, "DOWNLOAD_MAX_FILE_SIZE_MB");
  const config: Config = {
    outputDir,
    artifactName: sanitizeArtifactName(process.env.DOWNLOAD_ARTIFACT_NAME ?? "downloaded-files"),
    concurrency: parsePositiveInteger(process.env.DOWNLOAD_CONCURRENCY, 4, "DOWNLOAD_CONCURRENCY"),
    retries: parsePositiveInteger(process.env.DOWNLOAD_RETRIES, 3, "DOWNLOAD_RETRIES", 0),
    timeoutMs: parsePositiveInteger(process.env.DOWNLOAD_REQUEST_TIMEOUT_SECONDS, 600, "DOWNLOAD_REQUEST_TIMEOUT_SECONDS") * 1000,
    maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
    failFast: parseBoolean(process.env.DOWNLOAD_FAIL_FAST, true),
    hostHeaders: parseHostHeaders(process.env.DOWNLOAD_HEADERS_JSON),
  };

  console.log(`Downloading ${entries.length} file(s) with concurrency ${config.concurrency}`);
  const results = await runPool(entries, config);
  await writeReports(outputDir, results, startedAt);

  const successCount = results.filter((result) => result.status === "success").length;
  const failureCount = results.filter((result) => result.status === "failed").length;
  setOutput("artifact_name", config.artifactName);
  setOutput("success_count", successCount);
  setOutput("failure_count", failureCount);
  setOutput("has_output", true);

  if (failureCount > 0 || successCount === 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch(async (error) => {
    console.error(errorMessage(error));
    await mkdir(resolve(".download-output"), { recursive: true }).catch(() => undefined);
    await writeFile(
      resolve(".download-output/manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, fatalError: errorMessage(error) }, null, 2)}\n`,
      "utf8",
    ).catch(() => undefined);
    setOutput("artifact_name", sanitizeArtifactName(process.env.DOWNLOAD_ARTIFACT_NAME ?? "downloaded-files"));
    setOutput("success_count", 0);
    setOutput("failure_count", 1);
    setOutput("has_output", true);
    process.exitCode = 1;
  });
}
