import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { env } from "../config/env.js";

const router = Router();

/**
 * Views/engagement for videos published through ClipForge.
 * YouTube exposes statistics via the Data API (youtube.readonly scope we
 * already request). Instagram/Facebook/TikTok require extra insights scopes
 * the app doesn't ask for, so they're reported as unavailable.
 */
router.get("/api/analytics/platform", requireAuth, async (req, res, next) => {
  try {
    const { data: posts, error } = await supabaseAdmin
      .from("scheduled_posts")
      .select("id, platform, external_post_id, scheduled_time_utc, clips(title)")
      .eq("user_id", req.user.id)
      .eq("status", "published")
      .not("external_post_id", "is", null)
      .order("scheduled_time_utc", { ascending: false })
      .limit(200);
    if (error) throw error;

    const published = posts ?? [];
    const byPlatform = new Map(published.map((p) => [p.platform, p]));
    const unavailable = ["instagram", "tiktok", "facebook"].filter((p) =>
      published.some((post) => post.platform === p)
    );

    // YouTube stats
    let videos = [];
    let youtubeError = null;
    const ytPosts = published.filter((p) => p.platform === "youtube");
    if (ytPosts.length > 0) {
      try {
        const { data: conn } = await supabaseAdmin
          .from("social_connections")
          .select("*")
          .eq("user_id", req.user.id)
          .eq("platform", "youtube")
          .order("connected_at", { ascending: true })
          .limit(1);
        if (!conn?.length) throw new Error("YouTube account not connected");

        const accessToken = await getFreshAccessToken(conn[0]);

        // videos.list accepts up to 50 ids per call.
        videos = [];
        for (let i = 0; i < ytPosts.length; i += 50) {
          const chunk = ytPosts.slice(i, i + 50);
          const ids = chunk.map((p) => p.external_post_id).join(",");
          const res = await fetch(
            `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${ids}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (!res.ok) {
            throw new Error(`YouTube API failed (${res.status})`);
          }
          const data = await res.json();
          const statsById = new Map(
            (data.items ?? []).map((item) => [
              item.id,
              {
                views: Number(item.statistics?.viewCount ?? 0),
                likes: Number(item.statistics?.likeCount ?? 0),
                comments: Number(item.statistics?.commentCount ?? 0),
                title: item.snippet?.title ?? null,
                thumbnail:
                  item.snippet?.thumbnails?.medium?.url ??
                  item.snippet?.thumbnails?.default?.url ??
                  null,
              },
            ])
          );
          for (const post of chunk) {
            const stats = statsById.get(post.external_post_id);
            videos.push({
              post_id: post.id,
              video_id: post.external_post_id,
              clip_title: post.clips?.title ?? null,
              title: stats?.title ?? post.clips?.title ?? "Untitled",
              thumbnail: stats?.thumbnail ?? null,
              views: stats?.views ?? 0,
              likes: stats?.likes ?? 0,
              comments: stats?.comments ?? 0,
              published_at: post.scheduled_time_utc,
            });
          }
        }
      } catch (err) {
        youtubeError = err.message;
      }
    }

    videos.sort((a, b) => b.views - a.views);
    res.json({
      totals: {
        views: videos.reduce((sum, v) => sum + v.views, 0),
        likes: videos.reduce((sum, v) => sum + v.likes, 0),
        comments: videos.reduce((sum, v) => sum + v.comments, 0),
        published: published.length,
      },
      videos,
      unavailable_platforms: unavailable,
      youtube_error: youtubeError,
    });
  } catch (err) {
    next(err);
  }
});

/** Decrypt the stored YouTube token, refreshing it when close to expiry. */
async function getFreshAccessToken(conn) {
  const accessToken = decrypt(conn.access_token_encrypted);
  const expiresAt = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  if (expiresAt > Date.now() + 60_000) return accessToken;
  if (!conn.refresh_token_encrypted) return accessToken;

  const refreshToken = decrypt(conn.refresh_token_encrypted);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.youtubeClientId,
      client_secret: env.youtubeClientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`YouTube token refresh failed (${res.status})`);
  }

  await supabaseAdmin
    .from("social_connections")
    .update({
      access_token_encrypted: encrypt(data.access_token),
      token_expires_at: new Date(
        Date.now() + Number(data.expires_in ?? 3600) * 1000
      ).toISOString(),
    })
    .eq("id", conn.id);

  return data.access_token;
}

export default router;
