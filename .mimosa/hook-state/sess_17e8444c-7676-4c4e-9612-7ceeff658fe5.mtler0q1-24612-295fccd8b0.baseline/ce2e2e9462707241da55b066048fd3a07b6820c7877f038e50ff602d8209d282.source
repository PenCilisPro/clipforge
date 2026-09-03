const GRAPH = "https://graph.facebook.com/v19.0";

/**
 * Instagram Reels — two-phase container flow:
 *   1. POST /{ig-user-id}/media (media_type=REELS, video_url=public URL)
 *   2. Poll the container until status_code=FINISHED, then publish.
 *
 * Facebook Reels — single call with a public video_url:
 *   POST /{page-id}/video_reels?upload_phase=finish&video_url=...
 *
 * Both need a public (signed) clip URL that Meta's crawlers can reach.
 */
export async function publishToMeta({ accessToken, platform, caption, videoUrl }) {
  const accountsRes = await fetch(
    `${GRAPH}/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${accessToken}`
  );
  if (!accountsRes.ok) {
    throw new Error(`Meta /me/accounts failed (${accountsRes.status}): ${await accountsRes.text()}`);
  }
  const accounts = (await accountsRes.json()).data ?? [];
  if (accounts.length === 0) {
    throw new Error("No Facebook pages found for this account (a Page is required to publish Reels).");
  }

  if (platform === "instagram") {
    const withIg = accounts.find((a) => a.instagram_business_account);
    if (!withIg) {
      throw new Error(
        "No Instagram business/creator account linked to your Facebook pages."
      );
    }
    const igUserId = withIg.instagram_business_account.id;

    const containerRes = await fetch(`${GRAPH}/${igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: "REELS",
        video_url: videoUrl,
        caption,
        access_token: accessToken,
      }),
    });
    if (!containerRes.ok) {
      throw new Error(`IG container failed: ${await containerRes.text()}`);
    }
    const containerId = (await containerRes.json()).id;

    // Poll until the video finishes processing on Meta's side.
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const statusRes = await fetch(
        `${GRAPH}/${containerId}?fields=status_code&access_token=${accessToken}`
      );
      const { status_code } = await statusRes.json();
      if (status_code === "FINISHED") break;
      if (status_code === "ERROR") throw new Error("IG reel processing failed");
      if (i === 59) throw new Error("IG reel processing timed out");
    }

    const publishRes = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: containerId, access_token: accessToken }),
    });
    if (!publishRes.ok) {
      throw new Error(`IG publish failed: ${await publishRes.text()}`);
    }
    const { id } = await publishRes.json();
    return { externalId: id, externalUrl: `https://www.instagram.com/reel/${id}/` };
  }

  // facebook
  const page = accounts[0];
  const reelsRes = await fetch(
    `${GRAPH}/${page.id}/video_reels?upload_phase=finish&video_url=${encodeURIComponent(
      videoUrl
    )}&description=${encodeURIComponent(caption)}&access_token=${accessToken}`,
    { method: "POST" }
  );
  if (!reelsRes.ok) {
    throw new Error(`FB reel failed: ${await reelsRes.text()}`);
  }
  const { id } = await reelsRes.json();
  return { externalId: id, externalUrl: `https://facebook.com/reel/${id}` };
}
