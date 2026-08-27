import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const REGION = "auto";
const SERVICE = "s3";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function encodedPath(bucket, key) {
  return `/${[bucket, ...key.split("/")]
    .map((part) => encodeURIComponent(part).replaceAll("!", "%21"))
    .join("/")}`;
}

export function signedR2Get({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  key,
  now = new Date(),
}) {
  for (const [name, value] of Object.entries({
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    key,
  })) {
    if (!value || typeof value !== "string") {
      throw new Error(`Missing R2 signing field: ${name}`);
    }
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const pathname = encodedPath(bucket, key);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = "UNSIGNED-PAYLOAD";
  const canonicalHeaders = [
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    "",
  ].join("\n");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "GET",
    pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, REGION);
  const serviceKey = hmac(regionKey, SERVICE);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");

  return {
    url: `https://${host}${pathname}`,
    headers: {
      Authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  };
}
