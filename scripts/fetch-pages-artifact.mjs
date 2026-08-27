#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signedR2Get } from "./r2-sigv4.mjs";

const APP_IDS = new Set([
  "typi",
  "music",
  "language",
  "geography",
  "steadygo",
  "trip",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

export function validateManifest(manifest, { appId, bucket }) {
  if (manifest?.version !== 1) throw new Error("Unsupported manifest version");
  if (manifest.app !== appId) throw new Error("Manifest app does not match");
  if (manifest.artifact?.bucket !== bucket) {
    throw new Error("Manifest bucket does not match the configured bucket");
  }
  if (
    typeof manifest.artifact?.key !== "string" ||
    !manifest.artifact.key.startsWith(`pages/${appId}/`) ||
    manifest.artifact.key.includes("..")
  ) {
    throw new Error("Manifest contains an invalid artifact key");
  }
  if (!SHA256.test(manifest.artifact?.sha256 || "")) {
    throw new Error("Manifest contains an invalid SHA-256 digest");
  }
  if (
    !Number.isSafeInteger(manifest.artifact?.size) ||
    manifest.artifact.size <= 0 ||
    manifest.artifact.size > MAX_ARCHIVE_BYTES
  ) {
    throw new Error("Manifest contains an invalid archive size");
  }
  if (!COMMIT.test(manifest.source?.commit || "")) {
    throw new Error("Manifest contains an invalid source commit");
  }
  return manifest;
}

export function assertSafeArchiveEntries(entries) {
  for (const entry of entries) {
    if (
      !entry ||
      entry.startsWith("/") ||
      entry.split("/").some((part) => part === "..")
    ) {
      throw new Error(`Unsafe archive entry: ${entry || "<empty>"}`);
    }
  }
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function findSourceMaps(directory) {
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".map")) return path;
    }
  }
  return undefined;
}

function exactSizeStream(expectedSize) {
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > expectedSize) {
        callback(new Error("R2 object exceeds its declared size"));
      } else {
        callback(null, chunk);
      }
    },
    flush(callback) {
      if (received !== expectedSize) {
        callback(new Error("R2 object size does not match the manifest"));
      } else {
        callback();
      }
    },
  });
}

export async function fetchPagesArtifact({ appId, root = process.cwd() }) {
  if (!APP_IDS.has(appId)) throw new Error(`Unknown Trainapps app: ${appId}`);

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  const missing = Object.entries({
    R2_ACCOUNT_ID: accountId,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
    R2_BUCKET: bucket,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) throw new Error(`Missing environment: ${missing.join(", ")}`);

  const manifestPath = resolve(root, "deployments", `${appId}.json`);
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")), {
    appId,
    bucket,
  });
  const temporary = mkdtempSync(resolve(root, ".trainapps-artifact-"));
  const archive = join(temporary, "artifact.tar.gz");
  const extracted = join(temporary, "out");

  try {
    const request = signedR2Get({
      accountId,
      accessKeyId,
      secretAccessKey,
      bucket,
      key: manifest.artifact.key,
    });
    const response = await fetch(request.url, {
      headers: request.headers,
      redirect: "error",
    });
    if (!response.ok || !response.body) {
      throw new Error(`R2 download failed with HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength && declaredLength !== manifest.artifact.size) {
      throw new Error("R2 object size does not match the manifest");
    }
    await pipeline(
      Readable.fromWeb(response.body),
      exactSizeStream(manifest.artifact.size),
      createWriteStream(archive, { flags: "wx", mode: 0o600 }),
    );

    if ((await fileSha256(archive)) !== manifest.artifact.sha256) {
      throw new Error("R2 object SHA-256 does not match the manifest");
    }
    const entries = execFileSync("tar", ["-tzf", archive], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean);
    assertSafeArchiveEntries(entries);
    mkdirSync(extracted);
    execFileSync("tar", [
      "-xzf",
      archive,
      "-C",
      extracted,
      "--no-same-owner",
      "--no-same-permissions",
    ]);

    const markerPath = join(extracted, "deployment.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (marker.commit !== manifest.source.commit) {
      throw new Error("Extracted deployment marker does not match the manifest");
    }
    const sourceMap = findSourceMaps(extracted);
    if (sourceMap) throw new Error(`Artifact contains a source map: ${sourceMap}`);

    const output = resolve(root, "out");
    rmSync(output, { force: true, recursive: true });
    renameSync(extracted, output);
    console.log(
      `Prepared ${appId} from verified source commit ${manifest.source.commit}.`,
    );
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

async function main() {
  await fetchPagesArtifact({ appId: process.argv[2] });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
