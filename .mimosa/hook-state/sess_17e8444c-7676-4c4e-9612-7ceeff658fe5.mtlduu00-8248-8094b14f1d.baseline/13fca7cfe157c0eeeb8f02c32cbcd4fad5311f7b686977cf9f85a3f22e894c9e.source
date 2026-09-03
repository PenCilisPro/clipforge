import crypto from "node:crypto";

const KEY = process.env.ENCRYPTION_KEY ?? "";

export function encrypt(plaintext) {
  if (KEY.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-char hex string");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(KEY, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Refresh an expired/expiring OAuth access token for a platform.
 * Returns { accessToken, refreshToken?, expiresAt }.
 */
export async function refreshPlatformToken(platform, connection) {
  const refreshToken = connection.refresh_token_encrypted
    ? decrypt(connection.refresh_token_encrypted)
    : null;

  if (platform === "youtube") {
    if (!refreshToken) throw new Error("Google refresh token missing — reconnect the account.");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: process.env.YOUTUBE_CLIENT_ID ?? "",
        client_secret: process.env.YOUTUBE_CLIENT_SECRET ?? "",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Google token refresh failed: ${data.error_description ?? data.error}`);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + Number(data.expires_in) * 1000).toISOString(),
    };
  }

  if (platform === "instagram" || platform === "facebook") {
    const current = decrypt(connection.access_token_encrypted);
    const res = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${
        process.env.META_APP_ID ?? ""
      }&client_secret=${process.env.META_APP_SECRET ?? ""}&fb_exchange_token=${current}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(`Meta token refresh failed: ${data.error?.message ?? res.status}`);
    return {
      accessToken: data.access_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
        : null,
    };
  }

  if (platform === "tiktok") {
    if (!refreshToken) throw new Error("TikTok refresh token missing — reconnect the account.");
    const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_key: process.env.TIKTOK_CLIENT_KEY ?? "",
        client_secret: process.env.TIKTOK_CLIENT_SECRET ?? "",
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(`TikTok token refresh failed: ${data.error ?? res.status}`);
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + Number(data.expires_in) * 1000).toISOString(),
    };
  }

  throw new Error(`No refresh flow for platform ${platform}`);
}

function decrypt(payload) {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(KEY, "hex"),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
