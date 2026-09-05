import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { encrypt, signState, verifyState } from "../lib/crypto.js";
import { isProOrAdmin } from "../lib/tiers.js";
import { env } from "../config/env.js";

const router = Router();

const OAUTH_CONFIG = {
  youtube: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope:
      "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
    clientId: () => env.youtubeClientId,
    clientSecret: () => env.youtubeClientSecret,
    extraAuthParams: {
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    },
  },
  instagram: {
    authorizeUrl: "https://www.facebook.com/v19.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v19.0/oauth/access_token",
    scope: "instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement",
    clientId: () => env.metaAppId,
    clientSecret: () => env.metaAppSecret,
    extraAuthParams: {},
  },
  facebook: {
    authorizeUrl: "https://www.facebook.com/v19.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v19.0/oauth/access_token",
    scope: "pages_manage_posts,pages_show_list,pages_read_engagement",
    clientId: () => env.metaAppId,
    clientSecret: () => env.metaAppSecret,
    extraAuthParams: {},
  },
  tiktok: {
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    scope: "user.info.basic,video.publish,video.upload",
    clientId: () => env.tiktokClientKey,
    clientSecret: () => env.tiktokClientSecret,
    extraAuthParams: { client_key: () => env.tiktokClientKey },
  },
};

function credentialsFor(platform) {
  const config = OAUTH_CONFIG[platform];
  if (!config) return null;
  const clientId = config.clientId();
  const clientSecret = config.clientSecret();
  if (!clientId || !clientSecret) return null;
  return { ...config, clientId, clientSecret };
}

// Best-effort account identity so the same channel can be re-connected
// without creating duplicate rows (upsert key includes platform_account_id).
async function fetchAccountIdentity(platform, accessToken) {
  try {
    if (platform === "youtube") {
      const res = await fetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = await res.json();
      const channel = data?.items?.[0];
      if (channel?.id) {
        return {
          accountId: channel.id,
          username: channel.snippet?.title ?? channel.snippet?.customUrl ?? null,
        };
      }
    } else if (platform === "tiktok") {
      const res = await fetch(
        "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = await res.json();
      const user = data?.data?.user;
      if (user?.open_id) {
        return { accountId: user.open_id, username: user.display_name ?? null };
      }
    } else {
      const res = await fetch("https://graph.facebook.com/me?fields=id,name", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json();
      if (data?.id) {
        return { accountId: data.id, username: data.name ?? null };
      }
    }
  } catch (err) {
    console.warn(`[oauth:${platform}] identity lookup failed:`, err.message);
  }
  return { accountId: "unknown", username: null };
}

// List connected accounts
router.get("/api/social/connections", requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("social_connections")
      .select(
        "id, user_id, platform, platform_account_id, platform_username, token_expires_at, connected_at"
      )
      .eq("user_id", req.user.id);
    if (error) throw error;
    res.json({ connections: data });
  } catch (err) {
    next(err);
  }
});

// Disconnect one connected account by its row id.
router.delete("/api/social/connections/:id", requireAuth, async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from("social_connections")
      .delete()
      .eq("user_id", req.user.id)
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Start OAuth — returns the provider authorize URL
router.get("/api/social/:platform/connect", requireAuth, async (req, res) => {
  const { platform } = req.params;
  const config = credentialsFor(platform);
  if (!config) {
    return res
      .status(501)
      .json({ error: `OAuth for ${platform} is not configured on this deployment` });
  }

  const state = signState({ userId: req.user.id, platform });

  // First channel per platform is free; extra channels are a paid/admin feature.
  const { count } = await supabaseAdmin
    .from("social_connections")
    .select("id", { count: "exact", head: true })
    .eq("user_id", req.user.id)
    .eq("platform", platform);
  if ((count ?? 0) > 0 && !(await isProOrAdmin(req.user.id, req.user.email))) {
    return res.status(403).json({
      error:
        "Connecting multiple channels per platform needs a Pro subscription — upgrade your plan to add another channel.",
    });
  }

  const redirectUri = `${env.backendUrl}/api/social/${platform}/callback`;

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scope,
    state,
    ...Object.fromEntries(
      Object.entries(config.extraAuthParams).map(([k, v]) => [
        k,
        typeof v === "function" ? v() : v,
      ])
    ),
  });

  res.json({ authorizeUrl: `${config.authorizeUrl}?${params.toString()}` });
});

// OAuth callback — exchange code, encrypt + store tokens, bounce to frontend
router.get("/api/social/:platform/callback", async (req, res) => {
  const { platform } = req.params;
  const frontendBase = `${env.frontendUrl}/dashboard/connections`;
  const config = OAUTH_CONFIG[platform];

  try {
    if (!config) throw new Error("Unknown platform");
    const { code, state } = req.query;
    const stateData = verifyState(String(state));
    if (stateData.platform !== platform) throw new Error("Platform mismatch");

    const tokenRes = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: `${env.backendUrl}/api/social/${platform}/callback`,
        client_id: config.clientId(),
        client_secret: config.clientSecret(),
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      throw new Error(tokens.error_description ?? tokens.error ?? "Token exchange failed");
    }

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
      : null;

    const identity = await fetchAccountIdentity(platform, tokens.access_token);

    const { error } = await supabaseAdmin
      .from("social_connections")
      .upsert(
        {
          user_id: stateData.userId,
          platform,
          access_token_encrypted: encrypt(tokens.access_token),
          refresh_token_encrypted: tokens.refresh_token
            ? encrypt(tokens.refresh_token)
            : null,
          token_expires_at: expiresAt,
          platform_account_id: identity.accountId,
          platform_username: identity.username,
          connected_at: new Date().toISOString(),
        },
        { onConflict: "user_id,platform,platform_account_id" }
      );
    if (error) throw error;

    return res.redirect(
      `${frontendBase}?status=connected&platform=${platform}`
    );
  } catch (err) {
    console.error(`[oauth:${platform}]`, err.message);
    return res.redirect(
      `${frontendBase}?status=error&platform=${platform ?? "unknown"}`
    );
  }
});

export default router;
