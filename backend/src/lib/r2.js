import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";

/**
 * Cloudflare R2 storage (S3-compatible), replacing Supabase Storage.
 * Keys are "<bucket>/<path>" so existing DB path values stay valid:
 * r2Key("clips", "uid/clip.mp4") -> "clips/uid/clip.mp4".
 */
const client = new S3Client({
  region: "auto",
  // Path-style is required: virtual-hosted style puts the bucket into the
  // hostname (<bucket>.<account>.r2.cloudflarestorage.com), which R2's TLS
  // certificate does not cover — browsers fail with ERR_SSL_VERSION_OR_CIPHER_MISMATCH.
  forcePathStyle: true,
  endpoint: env.r2AccountId
    ? `https://${env.r2AccountId}.r2.cloudflarestorage.com`
    : undefined,
  credentials: env.r2AccessKeyId
    ? {
        accessKeyId: env.r2AccessKeyId,
        secretAccessKey: env.r2SecretAccessKey,
      }
    : undefined,
});

export function r2Key(bucket, path) {
  return `${bucket}/${path}`;
}

// R2_ACCOUNT_ID must be the Cloudflare account hash (32 hex chars), not an
// access-key token — presigned upload URLs are built from it, and a wrong
// value makes browsers fail with ERR_SSL_VERSION_OR_CIPHER_MISMATCH.
export async function upload(key, body, contentType) {
  await client.send(
    new PutObjectCommand({
      Bucket: env.r2Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

export async function download(key) {
  const res = await client.send(new GetObjectCommand({ Bucket: env.r2Bucket, Key: key }));
  return res.Body; // Readable stream
}

export async function downloadBuffer(key) {
  const res = await client.send(new GetObjectCommand({ Bucket: env.r2Bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function exists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: env.r2Bucket, Key: key }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return false;
    throw err;
  }
}

/** Object size in bytes, or null when the object does not exist. */
export async function objectSize(key) {
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: env.r2Bucket, Key: key }));
    return res.ContentLength ?? null;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return null;
    throw err;
  }
}

/**
 * S3 multipart upload — the browser assembles large files in R2 part by part
 * and only the metadata round-trips through this (memory-poor) service. The
 * joined object exists in R2 exactly once, so no worker-side reassembly or
 * re-upload of a multi-hundred-MB file is ever needed.
 */
export async function createMultipartUpload(key, contentType) {
  const res = await client.send(
    new CreateMultipartUploadCommand({ Bucket: env.r2Bucket, Key: key, ContentType: contentType })
  );
  if (!res.UploadId) throw new Error("R2 did not return an upload id");
  return res.UploadId;
}

export async function presignUploadPart(key, uploadId, partNumber, expiresIn = 60 * 60 * 24) {
  return getSignedUrl(
    client,
    new UploadPartCommand({ Bucket: env.r2Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn }
  );
}

export async function completeMultipartUpload(key, uploadId, parts) {
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: env.r2Bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: [...parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    })
  );
}

export async function abortMultipartUpload(key, uploadId) {
  await client.send(
    new AbortMultipartUploadCommand({ Bucket: env.r2Bucket, Key: key, UploadId: uploadId })
  );
}

/** All object keys under a prefix (up to 10k — fine for upload part folders). */
export async function listByPrefix(prefix) {
  const keys = [];
  let token;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: env.r2Bucket, Prefix: prefix, ContinuationToken: token })
    );
    for (const o of res.Contents ?? []) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export async function remove(keys) {
  if (!keys?.length) return;
  await client.send(
    new DeleteObjectsCommand({
      Bucket: env.r2Bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    })
  );
}

export async function presignGet(key, expiresIn = 3600) {
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: env.r2Bucket, Key: key }),
    { expiresIn }
  );
}

export async function presignPut(key, contentType, expiresIn = 3600) {
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: env.r2Bucket, Key: key, ContentType: contentType }),
    { expiresIn }
  );
}

export function publicUrl(key) {
  return `${env.r2PublicBaseUrl?.replace(/\/$/, "")}/${key}`;
}
