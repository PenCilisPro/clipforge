import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env.js";

/**
 * Cloudflare R2 storage (S3-compatible), replacing Supabase Storage.
 * Keys are "<bucket>/<path>" so existing DB path values stay valid:
 * r2Key("clips", "uid/clip.mp4") -> "clips/uid/clip.mp4".
 */
const client = new S3Client({
  region: "auto",
  // Path-style required: R2's TLS cert doesn't cover <bucket>.<account>.r2.cloudflarestorage.com
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

// Request-level timeout — without it a stalled R2 connection hangs the
// awaiting promise (and a worker slot) forever. Generous: source videos are
// large, but never legitimately minutes-silent.
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const LARGE_TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;

export async function upload(key, body, contentType) {
  await client.send(
    new PutObjectCommand({
      Bucket: env.r2Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
    { abortSignal: AbortSignal.timeout(LARGE_TRANSFER_TIMEOUT_MS) }
  );
}

/**
 * Upload straight from a file on disk. Reading the whole video into the heap
 * first (fs.readFile → Buffer) spikes RSS by the file size. Keep transfers
 * on a file stream so source and output size do not become Node heap size.
 */
export async function uploadFile(key, filePath, contentType) {
  const { createReadStream } = await import("node:fs");
  const { stat } = await import("node:fs/promises");
  const { size } = await stat(filePath);
  await client.send(
    new PutObjectCommand({
      Bucket: env.r2Bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: size,
      ContentType: contentType,
    }),
    { abortSignal: AbortSignal.timeout(LARGE_TRANSFER_TIMEOUT_MS) }
  );
}

export async function download(key) {
  const res = await client.send(
    new GetObjectCommand({ Bucket: env.r2Bucket, Key: key }),
    { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
  return res.Body; // Readable stream
}

/**
 * Exact byte size of one object (metadata call, no body transfer). Used to
 * pre-compute ContentLength for composite uploads.
 */
export async function headSize(key) {
  const res = await client.send(
    new HeadObjectCommand({ Bucket: env.r2Bucket, Key: key }),
    { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
  return Number(res.ContentLength) || 0;
}

/**
 * Assemble several stored objects into ONE new object without any local
 * file: every source body streams chunk-by-chunk into a single PutObject
 * body. Disk cost is zero — the point, since reassembling a split upload
 * locally used to fill the worker's ~1 GiB ephemeral disk and starve
 * transcription audio. Memory cost is one chunk. `sources` must be full
 * keys with sizes from headSize(); the sum becomes the request's
 * ContentLength (required for stream bodies). A mid-stream failure aborts
 * the whole request — callers should treat it as retryable from scratch.
 */
export async function uploadCompositeStream(key, sources, contentType) {
  if (!sources?.length) throw new Error("uploadCompositeStream: no sources");
  const { Readable } = await import("node:stream");
  const total = sources.reduce((sum, s) => sum + (Number(s.size) || 0), 0);
  if (total <= 0) throw new Error("uploadCompositeStream: sources total 0 bytes");
  async function* composite() {
    for (const source of sources) {
      const body = await download(source.key);
      for await (const chunk of body) yield chunk;
    }
  }
  await client.send(
    new PutObjectCommand({
      Bucket: env.r2Bucket,
      Key: key,
      Body: Readable.from(composite()),
      ContentLength: total,
      ContentType: contentType,
    }),
    { abortSignal: AbortSignal.timeout(LARGE_TRANSFER_TIMEOUT_MS) }
  );
  return total;
}

export async function downloadBuffer(key) {
  const res = await client.send(
    new GetObjectCommand({ Bucket: env.r2Bucket, Key: key }),
    { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
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
