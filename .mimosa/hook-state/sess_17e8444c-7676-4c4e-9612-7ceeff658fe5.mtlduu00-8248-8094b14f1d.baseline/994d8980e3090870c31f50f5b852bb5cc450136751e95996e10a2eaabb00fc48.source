import crypto from "node:crypto";
import { env } from "../config/env.js";

/**
 * AES-256-GCM encryption for social platform tokens at rest.
 * Output format: iv:tag:ciphertext (all hex).
 */
function keyBuffer() {
  if (!env.encryptionKey || env.encryptionKey.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(env.encryptionKey, "hex");
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuffer(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(payload) {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    keyBuffer(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/** HMAC-signed, expiring state param for OAuth flows. */
export function signState(data) {
  const payload = Buffer.from(
    JSON.stringify({ ...data, exp: Date.now() + 10 * 60 * 1000 })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", env.appSecret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(state) {
  const [payload, sig] = state.split(".");
  const expected = crypto
    .createHmac("sha256", env.appSecret)
    .update(payload)
    .digest("base64url");
  if (
    sig?.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    throw new Error("Invalid OAuth state signature");
  }
  const data = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (Date.now() > data.exp) throw new Error("OAuth state expired");
  return data;
}
