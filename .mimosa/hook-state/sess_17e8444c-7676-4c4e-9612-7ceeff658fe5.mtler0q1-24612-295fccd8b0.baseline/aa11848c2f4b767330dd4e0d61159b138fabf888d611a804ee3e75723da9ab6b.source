const TIKTOK_API = "https://open.tiktokapis.com/v2";

const DEFAULT_PRIVACY = process.env.TIKTOK_PRIVACY_LEVEL ?? "PUBLIC_TO_EVERYONE";

/**
 * TikTok Content Posting API — direct post with PULL_FROM_URL:
 *   1. POST /post/publish/video/init/ (TikTok fetches the clip from video_url)
 *   2. Poll /post/publish/status/fetch/ until PUBLISH_COMPLETE.
 */
export async function publishToTikTok({ accessToken, caption, videoUrl }) {
  const title = caption.split("\n").map((l) => l.trim()).filter(Boolean).join(" ").slice(0, 2200);

  const initRes = await fetch(`${TIKTOK_API}/post/publish/video/init/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      post_info: {
        title,
        privacy_level: DEFAULT_PRIVACY,
        disable_comment: false,
        disable_duet: false,
        disable_stitch: false,
      },
      source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
    }),
  });
  if (!initRes.ok) {
    throw new Error(`TikTok init failed (${initRes.status}): ${await initRes.text()}`);
  }
  const initData = await initRes.json();
  const publishId = initData?.data?.publish_id;
  if (!publishId) throw new Error(`TikTok init error: ${initData?.error?.message ?? "no publish_id"}`);

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const statusRes = await fetch(`${TIKTOK_API}/post/publish/status/fetch/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const statusData = await statusRes.json();
    const publishStatus = statusData?.data?.status?.publish_status;
    if (publishStatus === "PUBLISH_COMPLETE") {
      const videoId = statusData?.data?.publish_id ?? publishId;
      return {
        externalId: videoId,
        externalUrl: `https://www.tiktok.com/@me/video/${videoId}`,
      };
    }
    if (publishStatus === "PUBLISH_FAILED") {
      throw new Error(`TikTok publish failed: ${JSON.stringify(statusData?.data?.status?.fail_code ?? {})}`);
    }
    if (i === 59) throw new Error("TikTok publish timed out");
  }
  throw new Error("TikTok publish timed out");
}
