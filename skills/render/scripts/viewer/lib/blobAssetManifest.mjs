import fs from "node:fs";
import path from "node:path";

function normalizeString(value) {
  return String(value || "").trim();
}

export function blobAssetLookupKey(url) {
  const rawUrl = normalizeString(url);
  if (!rawUrl) {
    return "";
  }
  try {
    return new URL(rawUrl, "http://cad-explorer.local").pathname;
  } catch {
    return rawUrl.split(/[?#]/)[0];
  }
}

function blobAssetUrlWithVersion(url, version) {
  const rawUrl = normalizeString(url);
  const rawVersion = normalizeString(version);
  if (!rawUrl || !rawVersion) {
    return rawUrl;
  }
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.set("v", rawVersion);
    return parsed.toString();
  } catch {
    const separator = rawUrl.includes("?") ? "&" : "?";
    return `${rawUrl}${separator}v=${encodeURIComponent(rawVersion)}`;
  }
}

function normalizeBlobAssetEntry(key, value) {
  const lookupKey = blobAssetLookupKey(
    normalizeString(key) ||
    normalizeString(value?.localUrl) ||
    normalizeString(value?.url)
  );
  const url = normalizeString(typeof value === "string" ? value : value?.url);
  if (!lookupKey || !url) {
    return null;
  }
  return [
    lookupKey,
    {
      ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
      url,
    },
  ];
}

export function normalizeBlobAssetManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return null;
  }
  const rawAssets = manifest.assets && typeof manifest.assets === "object"
    ? manifest.assets
    : {};
  const entries = Array.isArray(rawAssets)
    ? rawAssets.map((asset) => normalizeBlobAssetEntry(asset?.key || asset?.localUrl, asset))
    : Object.entries(rawAssets).map(([key, value]) => normalizeBlobAssetEntry(key, value));
  const assets = Object.fromEntries(entries.filter(Boolean));
  return {
    ...manifest,
    schemaVersion: 1,
    assets,
  };
}

export function catalogFromBlobAssetManifest(manifest) {
  const catalog = manifest?.catalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog) || !Array.isArray(catalog.entries)) {
    return null;
  }
  return applyBlobAssetManifest(catalog, manifest);
}

export function readBlobAssetManifest(manifestPath) {
  const resolvedPath = normalizeString(manifestPath);
  if (!resolvedPath) {
    return null;
  }
  const payload = fs.readFileSync(resolvedPath, "utf-8");
  return normalizeBlobAssetManifest(JSON.parse(payload));
}

export function resolveBlobAssetManifestPath(value, appRoot) {
  const rawValue = normalizeString(value);
  if (!rawValue) {
    return "";
  }
  return path.isAbsolute(rawValue)
    ? rawValue
    : path.resolve(appRoot, rawValue);
}

function rewriteAssetWithBlob(asset, manifest) {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    return asset;
  }
  const match = manifest?.assets?.[blobAssetLookupKey(asset.url)];
  if (!match?.url) {
    return asset;
  }
  return {
    ...asset,
    url: blobAssetUrlWithVersion(match.url, asset.hash),
    storage: "vercel-blob",
  };
}

export function applyBlobAssetManifest(catalog, manifest) {
  if (!manifest?.assets || !catalog || typeof catalog !== "object" || !Array.isArray(catalog.entries)) {
    return catalog;
  }
  return {
    ...catalog,
    entries: catalog.entries.map((entry) => {
      if (!entry?.assets || typeof entry.assets !== "object" || Array.isArray(entry.assets)) {
        return entry;
      }
      const assets = Object.fromEntries(
        Object.entries(entry.assets).map(([key, asset]) => [key, rewriteAssetWithBlob(asset, manifest)])
      );
      return {
        ...entry,
        assets,
      };
    }),
  };
}
