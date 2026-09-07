import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
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
