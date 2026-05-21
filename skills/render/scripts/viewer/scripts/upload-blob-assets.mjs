#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { put } from "@vercel/blob";
import {
  DEFAULT_EXPLORER_ROOT_DIR,
  normalizeExplorerRootDir,
  repoRelativePath,
  resolveExplorerRoot,
  scanCadDirectory,
} from "../lib/cadDirectoryScanner.mjs";
import { blobAssetLookupKey } from "../lib/blobAssetManifest.mjs";
import { resolveWorkspaceRoot as resolveViewerWorkspaceRoot } from "../lib/pathUtils.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkspaceRoot = path.resolve(appRoot, "../../../..");
const DEFAULT_MANIFEST_PATH = ".vercel-blob-assets.json";
const DEFAULT_CACHE_CONTROL_MAX_AGE = 60;
const DEFAULT_CONCURRENCY = 4;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function unquoteEnvValue(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match || process.env[match[1]]) {
      continue;
    }
    process.env[match[1]] = unquoteEnvValue(match[2]);
  }
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function decodeAssetLookupPath(lookupKey) {
  return lookupKey
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
    .join(path.sep);
}

function contentTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".glb") {
    return "model/gltf-binary";
  }
  if (extension === ".stl") {
    return "model/stl";
  }
  if (extension === ".3mf") {
    return "model/3mf";
  }
  if (extension === ".dxf") {
    return "image/vnd.dxf";
  }
  if (extension === ".urdf" || extension === ".srdf" || extension === ".sdf") {
    return "application/xml; charset=utf-8";
  }
  if (extension === ".js" || extension === ".mjs") {
    return "text/javascript; charset=utf-8";
  }
  return undefined;
}

function normalizeBlobPrefix(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function blobPathnameForRepoPath(repoPath, prefix = "") {
  const normalizedRepoPath = String(repoPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const normalizedPrefix = normalizeBlobPrefix(prefix);
  return normalizedPrefix ? `${normalizedPrefix}/${normalizedRepoPath}` : normalizedRepoPath;
}

function collectAssetRecords(catalog, repoRoot, rootPath) {
  const records = new Map();
  for (const entry of catalog.entries || []) {
    for (const asset of Object.values(entry?.assets || {})) {
      const lookupKey = blobAssetLookupKey(asset?.url);
      if (!lookupKey || records.has(lookupKey)) {
        continue;
      }
      const filePath = path.resolve(repoRoot, decodeAssetLookupPath(lookupKey));
      const relativeToRepo = path.relative(path.resolve(repoRoot), filePath);
      const relativeToRoot = path.relative(path.resolve(rootPath), filePath);
      if (
        relativeToRepo.startsWith("..") ||
        path.isAbsolute(relativeToRepo) ||
        relativeToRoot.startsWith("..") ||
        path.isAbsolute(relativeToRoot)
      ) {
        throw new Error(`Blob asset path must stay inside the Explorer root: ${lookupKey}`);
      }
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        continue;
      }
      records.set(lookupKey, {
        key: lookupKey,
        filePath,
        repoPath: repoRelativePath(repoRoot, filePath),
        hash: String(asset?.hash || ""),
        size: stats.size,
      });
    }
  }
  return [...records.values()].sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function writeManifest(manifestPath, manifest) {
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    if (fs.readFileSync(manifestPath, "utf-8") === payload) {
      return false;
    }
  } catch {
    // Missing manifests are written below.
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, payload);
  return true;
}

async function uploadAsset(record, options) {
  const pathname = blobPathnameForRepoPath(record.repoPath, options.prefix);
  if (options.dryRun) {
    return {
      ...record,
      pathname,
      url: `https://example.public.blob.vercel-storage.com/${pathname}`,
      contentType: contentTypeForPath(record.filePath) || "",
      etag: "",
    };
  }
  const body = await fs.promises.readFile(record.filePath);
  const blob = await put(pathname, body, {
    access: "public",
    allowOverwrite: true,
    cacheControlMaxAge: options.cacheControlMaxAge,
    contentType: contentTypeForPath(record.filePath),
    multipart: record.size > 10 * 1024 * 1024,
  });
  return {
    ...record,
    pathname: blob.pathname,
    url: blob.url,
    contentType: blob.contentType || contentTypeForPath(record.filePath) || "",
    etag: blob.etag || "",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv(path.join(appRoot, ".env"));

  const workspaceRoot = path.resolve(args.workspaceRoot || process.env.EXPLORER_WORKSPACE_ROOT || resolveViewerWorkspaceRoot({
    env: process.env,
    cwd: process.cwd(),
    appRoot,
    defaultWorkspaceRoot,
  }));
  const rootDir = normalizeExplorerRootDir(args.rootDir ?? process.env.EXPLORER_ROOT_DIR ?? DEFAULT_EXPLORER_ROOT_DIR);
  const resolvedRoot = resolveExplorerRoot(workspaceRoot, rootDir);
  const manifestPath = path.resolve(appRoot, args.manifest || process.env.EXPLORER_BLOB_ASSET_MANIFEST || DEFAULT_MANIFEST_PATH);
  const cacheControlMaxAge = normalizePositiveInteger(
    args.cacheControlMaxAge || process.env.EXPLORER_BLOB_CACHE_CONTROL_MAX_AGE,
    DEFAULT_CACHE_CONTROL_MAX_AGE
  );
  const concurrency = normalizePositiveInteger(args.concurrency || process.env.EXPLORER_BLOB_UPLOAD_CONCURRENCY, DEFAULT_CONCURRENCY);
  const prefix = normalizeBlobPrefix(args.prefix || process.env.EXPLORER_BLOB_PREFIX || "");
  const dryRun = Boolean(args.dryRun);

  if (!dryRun && !process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN is required to upload CAD assets to Vercel Blob.");
  }

  const catalog = scanCadDirectory({ repoRoot: workspaceRoot, rootDir });
  const records = collectAssetRecords(catalog, workspaceRoot, resolvedRoot.rootPath);
  console.log(`${dryRun ? "Prepared" : "Uploading"} ${records.length} CAD asset${records.length === 1 ? "" : "s"} from ${rootDir || "."}`);

  const uploaded = await mapWithConcurrency(records, concurrency, async (record, index) => {
    const result = await uploadAsset(record, { cacheControlMaxAge, dryRun, prefix });
    console.log(`[${index + 1}/${records.length}] ${result.repoPath} -> ${result.pathname}`);
    return result;
  });

  const manifest = {
    schemaVersion: 1,
    workspaceRoot: path.basename(workspaceRoot),
    rootDir,
    prefix,
    catalog,
    assets: Object.fromEntries(uploaded.map((asset) => [
      asset.key,
      {
        url: asset.url,
        pathname: asset.pathname,
        repoPath: asset.repoPath,
        hash: asset.hash,
        size: asset.size,
        contentType: asset.contentType,
      },
    ])),
  };
  const manifestLabel = path.relative(process.cwd(), manifestPath) || manifestPath;
  const wroteManifest = writeManifest(manifestPath, manifest);
  console.log(`${wroteManifest ? "Wrote" : "Manifest unchanged:"} ${manifestLabel}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
