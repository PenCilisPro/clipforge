import { supabaseAdmin } from "../lib/supabase.js";
import { decryptToken } from "../lib/crypto.js";
import { publishToYouTube } from "./youtube.js";
import { publishToMeta } from "./meta.js";
import { publishToTikTok } from "./tiktok.js";
import { encrypt } from "./token-refresh.js";

const PUBLISHERS = {
  youtube: (ctx) => publishToYouTube(ctx),
  instagram: (ctx) => publishToMeta({ ...ctx, platform: "instagram" }),
  facebook: (ctx) => publishToMeta({ ...ctx, platform: "facebook" }),
  tiktok: (ctx) => publishToTikTok(ctx),
};

async function signedClipUrl(storagePath) {
  const { data, error } = await supabaseAdmin.storage
    .from("clips")
    .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Delayed-publish processor. Loads the scheduled post, refreshes the OAuth
 * token if needed, hands the clip to the platform API, then records the
 * result in scheduled_posts.
 */
export async function processPublish(job) {
  const { scheduledPostId } = job.data;

  const { data: post } = await supabaseAdmin
    .from("scheduled_posts")
    .select("*")
    .eq("id", scheduledPostId)
    .single();
  if (!post) throw new Error(`Scheduled post ${scheduledPostId} not found`);
  if (post.status === "canceled") {
    job.log("Post was canceled — skipping.");
    return { skipped: true };
  }
  if (post.status === "published") {
    return { alreadyPublished: true };
  }

  const { data: clip } = await supabaseAdmin
    .from("clips")
    .select("id, title, hook_text, hashtags, storage_path")
    .eq("id", post.clip_id)
    .single();
  if (!clip?.storage_path) throw new Error("Clip is not ready (missing storage_path)");

  // Older posts have no stored connection — fall back to the earliest one.
  let connectionQuery = supabaseAdmin
    .from("social_connections")
    .select("*")
    .eq("user_id", post.user_id)
    .eq("platform", post.platform);
  if (post.social_connection_id) {
    connectionQuery = connectionQuery.eq("id", post.social_connection_id);
  } else {
    connectionQuery = connectionQuery.order("connected_at", { ascending: true }).limit(1);
  }
  const { data: connection } = await connectionQuery.single();
  if (!connection) throw new Error(`No connected ${post.platform} account`);

  await supabaseAdmin
    .from("scheduled_posts")
    .update({ status: "publishing", error_message: null })
    .eq("id", post.id);

  try {
    let accessToken = decryptToken(connection.access_token_encrypted);

    // Refresh proactively when the token expires within 10 minutes.
    if (
      connection.token_expires_at &&
      new Date(connection.token_expires_at) < new Date(Date.now() + 10 * 60 * 1000)
    ) {
      const refreshed = await refreshPlatformToken(post.platform, connection);
      accessToken = refreshed.accessToken;
      await supabaseAdmin
        .from("social_connections")
        .update({
          access_token_encrypted: encrypt(refreshed.accessToken),
          refresh_token_encrypted: refreshed.refreshToken
            ? encrypt(refreshed.refreshToken)
            : connection.refresh_token_encrypted,
          token_expires_at: refreshed.expiresAt,
        })
        .eq("id", connection.id);
    }

    const caption =
      post.caption_text ??
      [clip.hook_text ?? clip.title ?? "", clip.hashtags.map((t) => `#${t}`).join(" ")]
        .filter(Boolean)
        .join("\n\n");

    const videoUrl = await signedClipUrl(clip.storage_path);

    const { externalId, externalUrl } = await PUBLISHERS[post.platform]({
      accessToken,
      caption,
      videoUrl,
      clip,
    });

    const { error } = await supabaseAdmin
      .from("scheduled_posts")
      .update({ status: "published", external_post_id: externalId, error_message: null })
      .eq("id", post.id);
    if (error) throw error;

    job.log(`Published ${clip.id} to ${post.platform}: ${externalUrl}`);
    return { scheduledPostId: post.id, externalId, externalUrl };
  } catch (error) {
    await supabaseAdmin
      .from("scheduled_posts")
      .update({ status: "failed", error_message: error.message })
      .eq("id", post.id);
    throw error;
  }
}
