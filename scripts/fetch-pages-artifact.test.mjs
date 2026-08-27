import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeArchiveEntries, validateManifest } from "./fetch-pages-artifact.mjs";
import { signedR2Get } from "./r2-sigv4.mjs";

const manifest = {
  version: 1,
  app: "typi",
  source: { commit: "a".repeat(40) },
  artifact: {
    bucket: "trainapps-pages",
    key: `pages/typi/${"a".repeat(40)}.tar.gz`,
    sha256: "b".repeat(64),
    size: 123,
  },
};

test("accepts a scoped immutable artifact manifest", () => {
  assert.equal(
    validateManifest(manifest, { appId: "typi", bucket: "trainapps-pages" }),
    manifest,
  );
});

test("rejects a manifest that can escape its application prefix", () => {
  assert.throws(
    () =>
      validateManifest(
        {
          ...manifest,
          artifact: { ...manifest.artifact, key: "pages/music/file.tar.gz" },
        },
        { appId: "typi", bucket: "trainapps-pages" },
      ),
    /invalid artifact key/,
  );
});

test("rejects path traversal in an archive", () => {
  assert.throws(
    () => assertSafeArchiveEntries(["index.html", "../secret"]),
    /Unsafe/,
  );
});

test("creates a scoped R2 request without exposing the secret", () => {
  const request = signedR2Get({
    accountId: "account",
    accessKeyId: "access",
    secretAccessKey: "top-secret",
    bucket: "trainapps-pages",
    key: "pages/typi/archive file.tar.gz",
    now: new Date("2026-08-27T12:34:56.000Z"),
  });
  assert.equal(
    request.url,
    "https://account.r2.cloudflarestorage.com/trainapps-pages/pages/typi/archive%20file.tar.gz",
  );
  assert.match(
    request.headers.Authorization,
    /Credential=access\/20260827\/auto\/s3\/aws4_request/,
  );
  assert.doesNotMatch(request.headers.Authorization, /top-secret/);
});
