/**
 * YouTube Shorts upload via the Data API v3 resumable protocol.
 * Vertical videos ≤ 3 minutes are automatically classified as Shorts.
 */
export async function publishToYouTube({ accessToken, caption, videoUrl }) {
  const lines = caption.split("\n").map((l) => l.trim()).filter(Boolean);
  const title = (lines[0] ?? "New clip").slice(0, 100);
  const description = lines.slice(1).join("\n").slice(0, 4900);
  const tags = (caption.match(/#[\w-]+/g) ?? []).map((t) => t.slice(1)).slice(0, 15);

  // 1. Initiate a resumable session
  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        snippet: { title, description, tags, categoryId: "22" },
        status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
      }),
    }
  );
  if (!initRes.ok) {
    throw new Error(`YouTube upload init failed (${initRes.status}): ${await initRes.text()}`);
  }
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube did not return an upload URL");

  // 2. Fetch the clip bytes (from Supabase Storage signed URL) and PUT them
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`Could not read clip from storage (${videoRes.status})`);
  const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(videoBuffer.length),
    },
    body: videoBuffer,
  });
  if (!uploadRes.ok) {
    throw new Error(`YouTube upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
  }

  const video = await uploadRes.json();
  return { externalId: video.id, externalUrl: `https://youtube.com/shorts/${video.id}` };
}
